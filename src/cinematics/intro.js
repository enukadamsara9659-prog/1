// Opening cinematic: a meteor breaks apart in the dawn sky and falls into the
// world. Fully skippable. Hands control back to the player at the end.
import * as THREE from 'three';
import { Rng, clamp, lerp, smoothstep } from '../core/rng.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

const LORE = [
  { t: 1.0, text: 'For nine hundred years the sky kept its promises.' },
  { t: 8.0, text: 'Then, at first light, it broke one.' },
  { t: 15.5, text: 'It did not burn out. It chose a place to land.' },
  { t: 22.0, text: 'Whatever came down in that fire is still down there.' },
  { t: 29.0, text: 'And it is learning our shape.' },
];

function ease(t) { return t * t * (3 - 2 * t); }

export class IntroCinematic {
  constructor(ctx) {
    this.ctx = ctx;
    this.t = 0;
    this.running = false;
    this.done = false;
    this.rng = new Rng(20261010);
    this.resolve = null;
    this.skipped = false;
    this.group = new THREE.Group();
    this.group.name = 'intro';
    ctx.scene.add(this.group);
    this.fragments = [];
    this.debris = [];
    this.flash = 0;
    this.shake = 0;
    this.built = false;
  }

  build() {
    if (this.built) return;
    this.built = true;
    const { world } = this.ctx;
    const c = world.crater || { x: 0, z: 0, radius: 120 };
    this.crater = c;
    const cy = world.heightAt(c.x, c.z);
    this.craterY = cy;

    // ---- camera keyframes (relative to the crater)
    const S = 1;
    this.shots = [
      // aerial dawn sweep, looking at the crater rim from high up
      { t: 0, pos: [c.x + 900, cy + 620, c.z + 1150], look: [c.x, cy + 40, c.z], fov: 46 },
      { t: 6, pos: [c.x + 620, cy + 430, c.z + 760], look: [c.x, cy + 60, c.z], fov: 42 },
      // tilt up to the sky
      { t: 10, pos: [c.x + 260, cy + 90, c.z + 420], look: [c.x + 160, cy + 1500, c.z + 260], fov: 58 },
      // follow the falling giant
      { t: 15.5, pos: [c.x + 180, cy + 40, c.z + 300], look: [c.x + 60, cy + 1600, c.z + 40], fov: 62 },
      // ground level, the shadow rushing in
      { t: 19.6, pos: [c.x + 150, cy + 6, c.z + 190], look: [c.x, cy + 700, c.z], fov: 70 },
      // impact hold
      { t: 21.4, pos: [c.x + 168, cy + 12, c.z + 214], look: [c.x, cy + 20, c.z], fov: 62 },
      // push through the dust
      { t: 26, pos: [c.x + 132, cy + 26, c.z + 168], look: [c.x, cy + 18, c.z], fov: 54 },
      // swing around to the player start
      { t: 31, pos: [this.ctx.playerStart.x + 26, this.ctx.playerStart.y + 12, this.ctx.playerStart.z + 34],
        look: [this.ctx.playerStart.x, this.ctx.playerStart.y + 1.6, this.ctx.playerStart.z], fov: 50 },
      { t: 35, pos: [this.ctx.playerStart.x + 4.4, this.ctx.playerStart.y + 2.4, this.ctx.playerStart.z + 6.2],
        look: [this.ctx.playerStart.x, this.ctx.playerStart.y + 1.5, this.ctx.playerStart.z], fov: 62 },
    ];

    // ---- the meteor head
    const geo = new THREE.IcosahedronGeometry(1, 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i);
      _v.multiplyScalar(1 + this.rng.range(-0.16, 0.16));
      pos.setXYZ(i, _v.x, _v.y, _v.z);
    }
    geo.computeVertexNormals();
    this.meteorMat = new THREE.MeshStandardMaterial({
      color: 0x20120c, emissive: 0xff5a12, emissiveIntensity: 5.5, roughness: 0.85, metalness: 0.3,
    });
    this.meteor = new THREE.Mesh(geo, this.meteorMat);
    this.meteor.scale.setScalar(26);
    this.meteor.visible = false;
    this.group.add(this.meteor);

    // fire trail cone
    const trailGeo = new THREE.ConeGeometry(1, 1, 12, 1, true);
    trailGeo.translate(0, -0.5, 0);
    this.trailMat = new THREE.MeshBasicMaterial({
      color: 0xff8a2a, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide, depthWrite: false,
    });
    this.trail = new THREE.Mesh(trailGeo, this.trailMat);
    this.trail.visible = false;
    this.group.add(this.trail);

    this.meteorLight = new THREE.PointLight(0xff7a26, 0, 900, 2);
    this.group.add(this.meteorLight);

    // fragments
    const fragMat = new THREE.MeshStandardMaterial({
      color: 0x1c110c, emissive: 0xff6a1a, emissiveIntensity: 5, roughness: 0.9,
    });
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), fragMat);
      m.scale.setScalar(this.rng.range(2.6, 7.5));
      m.visible = false;
      this.group.add(m);
      this.fragments.push({
        mesh: m, t: -1, vel: new THREE.Vector3(),
        pos: new THREE.Vector3(), spin: new THREE.Vector3(this.rng.range(-2, 2), this.rng.range(-2, 2), this.rng.range(-2, 2)),
      });
    }

    // impact flash sphere
    this.flashMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xfff0d0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    this.flashMesh.visible = false;
    this.group.add(this.flashMesh);

    // shockwave ring
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.86, 1, 96),
      new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false })
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    this.group.add(this.ring);

    // debris pool
    const debGeo = new THREE.IcosahedronGeometry(1, 0);
    const debMat = new THREE.MeshStandardMaterial({ color: 0x2a211c, emissive: 0xff4a10, emissiveIntensity: 1.6, roughness: 1 });
    for (let i = 0; i < 46; i++) {
      const m = new THREE.Mesh(debGeo, debMat);
      m.scale.setScalar(this.rng.range(1.4, 5.5));
      m.visible = false;
      this.group.add(m);
      this.debris.push({ mesh: m, vel: new THREE.Vector3(), spin: new THREE.Vector3(), t: -1, life: 0 });
    }
  }

  start() {
    this.build();
    this.running = true;
    this.t = 0;
    const { sky } = this.ctx;
    if (sky) { sky.setTime(5.35); sky.weather.cloudiness = 0.5; }
    this.ctx.audio?.play('meteor_hiss', { gain: 0.0 });
    this.showText(0);
    return new Promise((res) => { this.resolve = res; });
  }

  showText(i) {
    const el = document.getElementById('cine');
    const tx = document.getElementById('cine-text');
    if (!el || !tx) return;
    el.classList.remove('hidden');
    el.classList.add('on');
    tx.style.opacity = 0;
    tx.textContent = LORE[i] ? LORE[i].text : '';
    requestAnimationFrame(() => { tx.style.opacity = 1; });
  }

  hideText() {
    const el = document.getElementById('cine');
    if (el) { el.classList.add('hidden'); el.classList.remove('on'); }
  }

  skip() {
    if (!this.running || this.skipped) return;
    this.skipped = true;
    this.t = Math.max(this.t, 30.5);
  }

  // ------------------------------------------------------------- update
  update(dt) {
    if (!this.running) return;
    this.t += dt;
    const t = this.t;
    const { camera, world, particles, audio } = this.ctx;

    // ---- camera path
    let a = this.shots[0], b = this.shots[this.shots.length - 1];
    for (let i = 0; i < this.shots.length - 1; i++) {
      if (t >= this.shots[i].t && t <= this.shots[i + 1].t) { a = this.shots[i]; b = this.shots[i + 1]; break; }
      if (t > this.shots[this.shots.length - 1].t) { a = b = this.shots[this.shots.length - 1]; }
    }
    const span = Math.max(0.001, b.t - a.t);
    const k = ease(clamp((t - a.t) / span, 0, 1));
    camera.position.set(lerp(a.pos[0], b.pos[0], k), lerp(a.pos[1], b.pos[1], k), lerp(a.pos[2], b.pos[2], k));
    const look = _v.set(lerp(a.look[0], b.look[0], k), lerp(a.look[1], b.look[1], k), lerp(a.look[2], b.look[2], k));
    if (this.shake > 0.001) {
      this.shake = Math.max(0, this.shake - dt * 1.1);
      const s = this.shake * this.shake * 12;
      camera.position.x += (Math.random() - 0.5) * s;
      camera.position.y += (Math.random() - 0.5) * s;
      camera.position.z += (Math.random() - 0.5) * s;
    }
    camera.lookAt(look);
    const fov = lerp(a.fov, b.fov, k);
    if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }

    // ---- sky: dawn breaks
    if (this.ctx.sky) {
      const h = 5.35 + clamp((t - 4) / 26, 0, 1) * 1.35;
      this.ctx.sky.setTime(h);
    }

    // ---- the meteor: entry (t 4..16), break-up (t 9..11), fall (t 11..20.2)
    this.updateMeteor(t, dt);

    // ---- impact at 20.2
    if (!this.impacted && t >= 20.2) this.impact();
    if (this.impacted) this.updateImpact(dt, t);

    // ---- lore text
    for (let i = 0; i < LORE.length; i++) {
      if (t >= LORE[i].t && this._loreIdx !== i) { this._loreIdx = i; this.showText(i); }
    }
    if (t > LORE[LORE.length - 1].t + 3.4) this.hideText();

    // ---- audio cues
    if (!this._hiss && t > 6) { this._hiss = true; audio?.play('meteor_hiss', { gain: 0.6 }); }
    if (!this._boom && t > 19.4) { this._boom = true; audio?.play('meteor_boom', { gain: 1 }); audio?.play('rumble', { gain: 0.8 }); }
    if (!this._hiss2 && t > 12.5) { this._hiss2 = true; audio?.play('meteor_hiss', { gain: 0.5 }); }

    // ---- finish
    if (t >= 35.2) this.finish();
  }

  updateMeteor(t, dt) {
    const m = this.meteor;
    if (t < 5.5 || t > 20.4) { m.visible = false; this.trail.visible = false; this.meteorLight.intensity = 0; return; }
    const c = this.crater;
    // path: from far north-east, high, curving down into the crater
    const p = clamp((t - 5.5) / (20.4 - 5.5), 0, 1);
    const pe = Math.pow(p, 2.15);
    const startX = c.x + 4200, startZ = c.z - 5600, startY = this.craterY + 5200;
    const x = lerp(startX, c.x, pe);
    const z = lerp(startZ, c.z, pe);
    const y = lerp(startY, this.craterY + 12, pe);
    m.position.set(x, y, z);
    m.visible = true;
    const s = lerp(38, 46, p);
    m.scale.setScalar(s);
    m.rotation.x += dt * 0.6;
    m.rotation.z += dt * 0.35;

    // trail points back along the velocity
    const nx = lerp(startX, c.x, Math.pow(clamp(p + 0.02, 0, 1), 2.15)) - x;
    const ny = lerp(startY, this.craterY + 12, Math.pow(clamp(p + 0.02, 0, 1), 2.15)) - y;
    const nz = lerp(startZ, c.z, Math.pow(clamp(p + 0.02, 0, 1), 2.15)) - z;
    const dir = _v.set(nx, ny, nz).normalize();
    const back = _v2.copy(m.position).addScaledVector(dir, -s * 1.2);
    this.trail.visible = true;
    this.trail.position.copy(back);
    this.trail.scale.set(s * 1.5, s * 22, s * 1.5);
    this.trail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().negate());
    this.trailMat.opacity = 0.35 + Math.sin(performance.now() * 0.02) * 0.15;
    this.meteorLight.intensity = 2600;
    this.meteorLight.position.copy(m.position);
    this.meteorLight.distance = 2400;

    // fire + smoke trail particles
    const rate = 60 * dt;
    if (Math.random() < rate) {
      this.ctx.particles.spawn(
        m.position.x + this.rng.range(-s, s), m.position.y + this.rng.range(-s, s), m.position.z + this.rng.range(-s, s),
        dir.x * -40 + this.rng.range(-8, 8), dir.y * -40 + this.rng.range(-8, 8) + 14, dir.z * -40 + this.rng.range(-8, 8),
        { size: s * 0.9, life: 1.4, color: 0xff7a26, gravity: 2, drag: 1.1, alpha: 0.5 }
      );
      this.ctx.particles.spawn(
        m.position.x + this.rng.range(-s, s), m.position.y + this.rng.range(-s, s), m.position.z + this.rng.range(-s, s),
        this.rng.range(-6, 6), this.rng.range(-2, 8), this.rng.range(-6, 6),
        { size: s * 1.4, life: 2.6, color: 0x4a3a30, gravity: 1.4, drag: 1.6, alpha: 0.22 }
      );
    }

    // break-up at t=9.2
    if (!this.broke && t > 9.2) {
      this.broke = true;
      for (const f of this.fragments) {
        f.t = 0;
        f.pos.copy(m.position);
        f.mesh.visible = true;
        f.mesh.position.copy(f.pos);
        f.vel.set(this.rng.range(-160, 160), this.rng.range(-60, 190), this.rng.range(-160, 160))
          .addScaledVector(dir, 320);
      }
      this.ctx.audio?.play('meteor_boom', { gain: 0.35 });
    }
    for (const f of this.fragments) {
      if (f.t < 0) continue;
      f.t += dt;
      f.vel.y -= 62 * dt;
      f.pos.addScaledVector(f.vel, dt);
      f.mesh.position.copy(f.pos);
      f.mesh.rotation.x += f.spin.x * dt;
      f.mesh.rotation.y += f.spin.y * dt;
      const gy = this.ctx.world.heightAt(f.pos.x, f.pos.z);
      if (f.pos.y <= gy + 2) {
        f.t = -1;
        f.mesh.visible = false;
        this.ctx.particles?.explosion(f.pos.clone().setY(gy + 2), 12, 0xff8a30);
        this.ctx.audio?.play('explosion', { pos: f.pos, gain: 0.5 });
      }
      if (Math.random() < 40 * dt) {
        this.ctx.particles.spawn(f.pos.x, f.pos.y, f.pos.z, 0, 0, 0,
          { size: f.mesh.scale.x * 1.5, life: 1.2, color: 0xff8a30, gravity: 1, drag: 1.4, alpha: 0.45 });
      }
    }
  }

  impact() {
    this.impacted = true;
    const c = this.crater;
    const pos = new THREE.Vector3(c.x, this.craterY + 6, c.z);
    this.ctx.particles?.explosion(pos, 90, 0xffb060);
    for (let i = 0; i < 5; i++) {
      const p = pos.clone().add(new THREE.Vector3(this.rng.range(-70, 70), this.rng.range(0, 40), this.rng.range(-70, 70)));
      this.ctx.particles?.explosion(p, 46, 0xff8a30);
    }
    this.ctx.audio?.play('meteor_boom', { gain: 1.2 });
    this.ctx.audio?.play('rumble', { gain: 1 });
    this.flash = 1;
    this.shake = 1.4;
    this.flashMesh.position.copy(pos);
    this.flashMesh.visible = true;
    this.flashMesh.scale.setScalar(30);
    this.ring.position.set(c.x, this.craterY + 2, c.z);
    this.ring.visible = true;
    this.ringT = 0;
    for (const d of this.debris) {
      d.t = 0;
      d.life = this.rng.range(2.5, 5.5);
      d.mesh.visible = true;
      d.mesh.position.copy(pos);
      const a = this.rng.float() * Math.PI * 2;
      const sp = this.rng.range(40, 190);
      d.vel.set(Math.cos(a) * sp, this.rng.range(70, 220), Math.sin(a) * sp);
      d.spin.set(this.rng.range(-6, 6), this.rng.range(-6, 6), this.rng.range(-6, 6));
    }
    this.meteor.visible = false;
    this.trail.visible = false;
    this.meteorLight.intensity = 0;
    // wake the world
    this.ctx.events?.emit('meteor:impacted');
  }

  updateImpact(dt, t) {
    const c = this.crater;
    // expanding ring
    if (this.ring.visible) {
      this.ringT += dt;
      const r = 40 + this.ringT * 260;
      this.ring.scale.setScalar(r);
      this.ring.material.opacity = Math.max(0, 0.85 - this.ringT * 0.55);
      if (this.ringT > 2.2) this.ring.visible = false;
    }
    // flash
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 1.6);
      this.flashMesh.material.opacity = this.flash * 0.9;
      this.flashMesh.scale.setScalar(30 + (1 - this.flash) * 220);
      if (this.flash <= 0) this.flashMesh.visible = false;
    }
    // debris
    for (const d of this.debris) {
      if (d.t < 0) continue;
      d.t += dt;
      d.vel.y -= 42 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      const gy = this.ctx.world.heightAt(d.mesh.position.x, d.mesh.position.z);
      if (d.mesh.position.y < gy + 1) {
        d.mesh.position.y = gy + 1;
        d.vel.y = Math.abs(d.vel.y) * 0.28;
        d.vel.x *= 0.6; d.vel.z *= 0.6;
      }
      if (d.t > d.life) { d.t = -1; d.mesh.visible = false; }
    }
    // lingering plume
    if (Math.random() < 26 * dt && t < 34) {
      const a = Math.random() * Math.PI * 2;
      const rr = Math.random() * 90;
      this.ctx.particles.spawn(c.x + Math.cos(a) * rr, this.craterY + Math.random() * 8, c.z + Math.sin(a) * rr,
        Math.cos(a) * 4, this.rng.range(6, 22), Math.sin(a) * 4,
        { size: this.rng.range(6, 14), life: this.rng.range(3, 6), color: t > 26 ? 0x6b5a4a : 0xff8a40, gravity: 1.6, drag: 0.6, alpha: 0.2 });
    }
  }

  finish() {
    if (this.done) return;
    this.done = true;
    this.running = false;
    this.hideText();
    // clean up
    this.group.removeFromParent();
    this.ctx.events?.emit('intro:done');
    if (this.resolve) this.resolve();
  }
}
