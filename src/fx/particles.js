// Pooled GPU particles, tracers, impact decals and floating damage numbers.
import * as THREE from 'three';
import { Rng, clamp, lerp } from '../core/rng.js';
import assets from '../core/assets.js';

const MAX = 3000;

const VERT = /* glsl */`
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (300.0 / max(0.001, -mv.z));
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */`
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d);
  if (r > 0.25) discard;
  float a = smoothstep(0.25, 0.02, r);
  gl_FragColor = vec4(vColor, vAlpha * a);
}`;

export class Particles {
  constructor(scene) {
    this.scene = scene;
    this.rng = new Rng(1337);
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(MAX * 3);
    this.col = new Float32Array(MAX * 3);
    this.size = new Float32Array(MAX);
    this.alpha = new Float32Array(MAX);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    geo.setDrawRange(0, 0);
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    scene.add(this.points);

    // CPU state
    this.vel = new Float32Array(MAX * 3);
    this.life = new Float32Array(MAX);
    this.maxLife = new Float32Array(MAX);
    this.grav = new Float32Array(MAX);
    this.drag = new Float32Array(MAX);
    this.size0 = new Float32Array(MAX);
    this.count = 0;

    this.tracers = new Tracers(scene, 96);
    this.decals = new Decals(scene, 96);
  }

  alloc() {
    if (this.count < MAX) return this.count++;
    // recycle the oldest-ish slot
    return Math.floor(this.rng.float() * MAX);
  }

  spawn(x, y, z, vx, vy, vz, opts = {}) {
    const i = this.alloc();
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    const c = opts.color || 0xffffff;
    this.col[i * 3] = ((c >> 16) & 255) / 255;
    this.col[i * 3 + 1] = ((c >> 8) & 255) / 255;
    this.col[i * 3 + 2] = (c & 255) / 255;
    this.size0[i] = opts.size ?? 0.12;
    this.size[i] = this.size0[i];
    this.life[i] = this.maxLife[i] = opts.life ?? 0.7;
    this.grav[i] = opts.gravity ?? -9;
    this.drag[i] = opts.drag ?? 1.6;
    this.alpha[i] = opts.alpha ?? 1;
    return i;
  }

  burst(pos, opts = {}) {
    const n = opts.count ?? 12;
    const spd = opts.speed ?? 4;
    const rng = this.rng;
    for (let k = 0; k < n; k++) {
      const dir = opts.dir ? opts.dir.clone() : new THREE.Vector3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalize();
      const s = spd * rng.range(0.3, 1);
      this.spawn(
        pos.x + rng.range(-0.05, 0.05), pos.y + rng.range(-0.05, 0.05), pos.z + rng.range(-0.05, 0.05),
        dir.x * s + (opts.base ? opts.base.x : 0),
        dir.y * s + (opts.base ? opts.base.y : 0),
        dir.z * s + (opts.base ? opts.base.z : 0),
        opts
      );
    }
  }

  // --------- named effects ---------
  muzzleSmoke(pos, dir) {
    this.burst(pos, { count: 5, speed: 1.6, dir, size: 0.18, life: 0.42, color: 0xbbaa99, gravity: 0.6, drag: 3.5, alpha: 0.35 });
    this.burst(pos, { count: 4, speed: 7, dir, size: 0.07, life: 0.14, color: 0xffd08a, gravity: -1, drag: 6, alpha: 1 });
  }
  impact(pos, normal, kind = 'stone') {
    const colors = { stone: 0xbfae93, wood: 0x8a6a45, flesh: 0x63ffd8, water: 0x9fd8ff, metal: 0xffe0a0, ground: 0x9a8b74 };
    const c = colors[kind] || colors.stone;
    const d = normal.clone().multiplyScalar(0.6);
    this.burst(pos, { count: 9, speed: 5, dir: d, base: normal.clone().multiplyScalar(1.4), size: 0.08, life: 0.5, color: c, gravity: -14, drag: 2.2 });
    this.burst(pos, { count: 4, speed: 2.4, dir: d, size: 0.28, life: 0.55, color: c, gravity: 0.4, drag: 4, alpha: 0.28 });
  }
  blood(pos, dir) {
    this.burst(pos, { count: 14, speed: 4.5, dir, size: 0.11, life: 0.75, color: 0x53ffc8, gravity: -12, drag: 1.6, alpha: 0.95 });
    this.burst(pos, { count: 6, speed: 1.4, size: 0.2, life: 1.1, color: 0x1f8f7a, gravity: -2, drag: 3, alpha: 0.4 });
  }
  sparks(pos, n = 8) {
    this.burst(pos, { count: n, speed: 6, size: 0.05, life: 0.35, color: 0xffc46b, gravity: -16, drag: 1.2 });
  }
  dust(pos, r = 1) {
    for (let i = 0; i < 8; i++) {
      const a = this.rng.float() * Math.PI * 2, rr = this.rng.range(0, r);
      this.spawn(pos.x + Math.cos(a) * rr, pos.y + this.rng.range(0, 0.2), pos.z + Math.sin(a) * rr,
        Math.cos(a) * 0.6, this.rng.range(0.2, 0.9), Math.sin(a) * 0.6,
        { size: 0.5, life: 1.4, color: 0xa89880, gravity: -0.2, drag: 2.2, alpha: 0.16 });
    }
  }
  shell(pos, dir) {
    this.spawn(pos.x, pos.y, pos.z, dir.x * 2 + this.rng.range(-1, 1), 2.4 + this.rng.range(0, 1), dir.z * 2 + this.rng.range(-1, 1),
      { size: 0.05, life: 1.6, color: 0xd9b45c, gravity: -16, drag: 0.4 });
  }
  explosion(pos, radius = 4, color = 0xff9a3c) {
    this.burst(pos, { count: 40, speed: radius * 2.6, size: 0.4, life: 1.0, color, gravity: 1.2, drag: 2.4 });
    this.burst(pos, { count: 26, speed: radius * 4.2, size: 0.16, life: 0.5, color: 0xffe6a8, gravity: -3, drag: 2 });
    this.burst(pos, { count: 18, speed: radius * 0.8, size: 1.2, life: 1.8, color: 0x6b5a4a, gravity: 0.6, drag: 3, alpha: 0.3 });
  }
  embers(pos, n = 3) {
    this.burst(pos, { count: n, speed: 0.7, size: 0.07, life: 1.6, color: 0xff9c3a, gravity: 1.4, drag: 1.2, alpha: 0.8 });
  }
  heal(pos) {
    for (let i = 0; i < 14; i++) {
      const a = this.rng.float() * Math.PI * 2;
      this.spawn(pos.x + Math.cos(a) * 0.5, pos.y + this.rng.range(-0.8, 0.2), pos.z + Math.sin(a) * 0.5,
        0, this.rng.range(1.4, 2.6), 0, { size: 0.1, life: 1.1, color: 0x7bffcf, gravity: 0.4, drag: 1.2 });
    }
  }

  update(dt) {
    const { pos, vel, life, maxLife, grav, drag, size, size0, alpha } = this;
    let n = this.count;
    for (let i = 0; i < n; i++) {
      if (life[i] <= 0) { alpha[i] = 0; continue; }
      life[i] -= dt;
      if (life[i] <= 0) { alpha[i] = 0; size[i] = 0; continue; }
      const d = Math.max(0, 1 - drag[i] * dt);
      vel[i * 3] *= d; vel[i * 3 + 1] = vel[i * 3 + 1] * d + grav[i] * dt; vel[i * 3 + 2] *= d;
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      const t = life[i] / maxLife[i];
      size[i] = size0[i] * (0.35 + 0.65 * t);
      alpha[i] = t > 0.75 ? (1 - t) * 4 : t / 0.75;
    }
    this.geo.setDrawRange(0, n);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    this.tracers.update(dt);
    this.decals.update(dt);
  }
}

// ---------------------------------------------------------------- tracers
class Tracers {
  constructor(scene, max = 96) {
    this.max = max;
    const geo = new THREE.CylinderGeometry(0.02, 0.02, 1, 5, 1, true);
    geo.rotateX(Math.PI / 2);
    geo.translate(0, 0, -0.5);
    this.mat = new THREE.MeshBasicMaterial({
      color: 0xffe3a8, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 7;
    scene.add(this.mesh);
    this.items = [];
    this.dummy = new THREE.Object3D();
  }
  add(from, to, color = 0xffe3a8, life = 0.06, width = 1) {
    const dir = new THREE.Vector3().subVectors(to, from);
    const len = dir.length();
    if (len < 0.01) return;
    this.dummy.position.copy(from);
    this.dummy.lookAt(to);
    this.dummy.scale.set(width, width, len);
    this.dummy.updateMatrix();
    const i = this.items.length < this.max ? this.items.length : 0;
    if (this.items.length < this.max) this.items.push({ m: this.dummy.matrix.clone(), t: life });
    else this.items[0] = { m: this.dummy.matrix.clone(), t: life };
    this.mesh.count = this.items.length;
    for (let k = 0; k < this.items.length; k++) this.mesh.setMatrixAt(k, this.items[k].m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  update(dt) {
    let changed = false;
    for (let i = this.items.length - 1; i >= 0; i--) {
      this.items[i].t -= dt;
      if (this.items[i].t <= 0) { this.items.splice(i, 1); changed = true; }
    }
    if (!changed) return;
    for (let k = 0; k < this.items.length; k++) this.mesh.setMatrixAt(k, this.items[k].m);
    this.mesh.count = this.items.length;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- decals
class Decals {
  constructor(scene, max = 96) {
    this.max = max;
    this.pool = [];
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.group = new THREE.Group();
    scene.add(this.group);
    for (let i = 0; i < max; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x1a1512, transparent: true, opacity: 0, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.renderOrder = 3;
      this.group.add(m);
      this.pool.push({ mesh: m, t: 0, life: 0 });
    }
    this.idx = 0;
  }
  add(pos, normal, size = 0.35, life = 14) {
    const d = this.pool[this.idx];
    this.idx = (this.idx + 1) % this.max;
    d.mesh.position.copy(pos).addScaledVector(normal, 0.02);
    d.mesh.scale.setScalar(size * (0.7 + Math.random() * 0.6));
    d.mesh.rotation.y = Math.random() * Math.PI * 2;
    if (normal.y < 0.9) {
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
      d.mesh.quaternion.copy(q);
      d.mesh.rotateY(Math.random() * Math.PI * 2);
    }
    d.mesh.material.opacity = 0.75;
    d.mesh.visible = true;
    d.t = life; d.life = life;
  }
  update(dt) {
    for (const d of this.pool) {
      if (d.t <= 0) continue;
      d.t -= dt;
      if (d.t <= 0) { d.mesh.visible = false; continue; }
      if (d.t < 1.5) d.mesh.material.opacity = 0.75 * (d.t / 1.5);
    }
  }
}

// --------------------------------------------------------- damage numbers
export class FloatingText {
  constructor(scene, camera) {
    this.camera = camera;
    this.pool = [];
    this.group = new THREE.Group();
    scene.add(this.group);
    this.canvasCache = new Map();
    for (let i = 0; i < 40; i++) {
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false }));
      spr.visible = false;
      spr.renderOrder = 900;
      this.group.add(spr);
      this.pool.push({ spr, t: 0, life: 1, vy: 0, pos: new THREE.Vector3() });
    }
    this.idx = 0;
  }
  _texture(text, color) {
    const key = text + '|' + color;
    let t = this.canvasCache.get(key);
    if (t) return t;
    const c = document.createElement('canvas');
    c.width = 128; c.height = 64;
    const g = c.getContext('2d');
    g.font = 'bold 40px Arial';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 7;
    g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.strokeText(text, 64, 32);
    g.fillStyle = color;
    g.fillText(text, 64, 32);
    t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    this.canvasCache.set(key, t);
    return t;
  }
  add(pos, text, color = '#ffffff', scale = 1) {
    const it = this.pool[this.idx];
    this.idx = (this.idx + 1) % this.pool.length;
    it.spr.material.map = this._texture(String(text), color);
    it.spr.material.needsUpdate = true;
    it.pos.copy(pos);
    it.spr.position.copy(pos);
    it.spr.visible = true;
    it.spr.scale.set(0.9 * scale, 0.45 * scale, 1);
    it.t = 1; it.life = 1;
    it.vy = 1.6 + Math.random() * 0.8;
  }
  update(dt) {
    for (const it of this.pool) {
      if (!it.spr.visible) continue;
      it.t -= dt * 0.9;
      if (it.t <= 0) { it.spr.visible = false; continue; }
      it.pos.y += it.vy * dt;
      it.vy -= dt * 1.4;
      it.spr.position.copy(it.pos);
      it.spr.material.opacity = Math.min(1, it.t * 2);
      const d = this.camera.position.distanceTo(it.pos);
      const s = Math.max(0.6, d * 0.055);
      it.spr.scale.set(s * 0.9, s * 0.45, 1);
    }
  }
}
