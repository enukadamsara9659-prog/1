// Procedurally rigged alien creatures ("husks") born from the meteor.
// Everything is built from primitives and animated by sine-driven part motion,
// which keeps them cheap (no skinning) while still reading as alive.
import * as THREE from 'three';
import { Rng, clamp, lerp, damp } from '../core/rng.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

// ---------------------------------------------------------------- materials
let MATS = null;
export function creatureMaterials() {
  if (MATS) return MATS;
  const chitin = (color, rough = 0.52, metal = 0.18) => new THREE.MeshStandardMaterial({
    color, roughness: rough, metalness: metal, flatShading: false,
  });
  MATS = {
    dark: chitin(0x14161b, 0.5, 0.22),
    plate: chitin(0x232830, 0.42, 0.34),
    bone: chitin(0xb9ae98, 0.68, 0.05),
    flesh: chitin(0x2c1f28, 0.85, 0.02),
    glow: new THREE.MeshStandardMaterial({
      color: 0x37ffd0, emissive: 0x2fffc4, emissiveIntensity: 3.2, roughness: 0.3, metalness: 0,
    }),
    glowWarm: new THREE.MeshStandardMaterial({
      color: 0xffa33a, emissive: 0xff8a1e, emissiveIntensity: 3.4, roughness: 0.35,
    }),
    glowViolet: new THREE.MeshStandardMaterial({
      color: 0xb26cff, emissive: 0x9a4dff, emissiveIntensity: 3.0, roughness: 0.3,
    }),
    ghost: new THREE.MeshStandardMaterial({
      color: 0x8fd8ff, emissive: 0x2b6c9c, emissiveIntensity: 1.1,
      transparent: true, opacity: 0.5, roughness: 0.2, depthWrite: false,
    }),
    hitFlash: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  };
  return MATS;
}

function mesh(geo, mat, parent, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

const GEO = {};
function geo(key, make) {
  if (!GEO[key]) GEO[key] = make();
  return GEO[key];
}

// ---------------------------------------------------------------- archetypes
export const ARCHETYPES = {
  spawnling: {
    name: 'Spawnling', hp: 55, speed: 5.2, radius: 0.55, height: 0.9, damage: 12,
    xp: 14, shards: 2, threat: 1, attackRange: 2.0, attackCd: 1.1, aggro: 55, glow: 'glow',
    desc: 'A skittering shard-born hatchling. Fast, fragile, always in numbers.',
  },
  brute: {
    name: 'Husk Brute', hp: 420, speed: 2.9, radius: 1.15, height: 3.1, damage: 42,
    xp: 95, shards: 12, threat: 4, attackRange: 3.6, attackCd: 1.9, aggro: 70, glow: 'glowWarm',
    desc: 'Armoured siege-creature. Slams the ground and charges without fear.',
  },
  spitter: {
    name: 'Bile Spitter', hp: 130, speed: 2.2, radius: 0.8, height: 1.9, damage: 22,
    xp: 48, shards: 6, threat: 3, attackRange: 46, attackCd: 2.4, aggro: 80, glow: 'glow',
    ranged: true, projSpeed: 34, desc: 'Lobs caustic aether from a distance. Kill it first.',
  },
  wraith: {
    name: 'Aether Wraith', hp: 180, speed: 6.4, radius: 0.7, height: 2.2, damage: 28,
    xp: 62, shards: 8, threat: 3, attackRange: 2.4, attackCd: 1.3, aggro: 95, glow: 'glowViolet',
    ghost: true, desc: 'Phase-shifts through the world. Appears behind you.',
  },
  titan: {
    name: 'Shard Titan', hp: 4200, speed: 2.4, radius: 3.2, height: 8.6, damage: 90,
    xp: 900, shards: 120, threat: 20, attackRange: 7, attackCd: 2.6, aggro: 160, glow: 'glowWarm',
    boss: true, ranged: true, projSpeed: 46, desc: 'A living fragment of the meteor itself.',
  },
};

// ---------------------------------------------------------------- builders
function buildSpawnling(M) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const thorax = mesh(geo('sp_thorax', () => new THREE.SphereGeometry(0.42, 14, 11)), M.plate, body, 0, 0.42, 0);
  thorax.scale.set(1.0, 0.72, 1.5);
  const abdomen = mesh(geo('sp_abd', () => new THREE.SphereGeometry(0.34, 12, 10)), M.dark, body, 0, 0.44, -0.62);
  abdomen.scale.set(0.9, 0.8, 1.25);
  const head = new THREE.Group();
  head.position.set(0, 0.46, 0.56);
  body.add(head);
  mesh(geo('sp_head', () => new THREE.SphereGeometry(0.24, 12, 10)), M.dark, head).scale.set(1, 0.82, 1.25);
  // mandibles
  for (const s of [-1, 1]) {
    const man = mesh(geo('sp_man', () => new THREE.ConeGeometry(0.07, 0.42, 6)), M.bone, head, s * 0.14, -0.05, 0.2);
    man.rotation.set(1.25, 0, -s * 0.5);
  }
  // glowing eyes
  for (const s of [-1, 1]) {
    const eye = mesh(geo('sp_eye', () => new THREE.SphereGeometry(0.06, 8, 6)), M.glow, head, s * 0.12, 0.07, 0.17);
    eye.castShadow = false;
  }
  // legs
  const legs = [];
  const legGeo = geo('sp_leg', () => new THREE.CylinderGeometry(0.035, 0.022, 0.78, 5));
  legGeo.translate(0, -0.39, 0);
  for (let i = 0; i < 6; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const row = Math.floor(i / 2) - 1;
    const hip = new THREE.Group();
    hip.position.set(side * 0.3, 0.42, row * 0.42);
    body.add(hip);
    const upper = mesh(legGeo, M.dark, hip);
    upper.rotation.z = side * 0.9;
    const knee = new THREE.Group();
    knee.position.set(0, -0.74, 0);
    hip.add(knee);
    const lower = mesh(legGeo, M.dark, knee);
    lower.scale.y = 0.9;
    lower.rotation.z = -side * 1.15;
    legs.push({ hip, knee, side, phase: (i * Math.PI) / 3 });
  }
  // spikes
  for (let i = 0; i < 5; i++) {
    const sp = mesh(geo('sp_spike', () => new THREE.ConeGeometry(0.05, 0.3, 5)), M.bone, body, 0, 0.7, -0.2 - i * 0.22);
    sp.rotation.x = -0.5;
    sp.scale.setScalar(1 - i * 0.13);
  }
  return { root, body, head, legs, parts: { body, head } };
}

function buildBrute(M) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const torso = mesh(geo('br_torso', () => new THREE.SphereGeometry(1.0, 16, 14)), M.plate, body, 0, 1.85, 0);
  torso.scale.set(1.15, 1.05, 0.85);
  const belly = mesh(geo('br_belly', () => new THREE.SphereGeometry(0.8, 14, 12)), M.flesh, body, 0, 1.35, 0.16);
  belly.scale.set(1.05, 0.9, 0.9);
  const head = new THREE.Group();
  head.position.set(0, 2.72, 0.12);
  body.add(head);
  mesh(geo('br_head', () => new THREE.SphereGeometry(0.42, 12, 10)), M.dark, head).scale.set(1, 0.9, 1.15);
  for (const s of [-1, 1]) {
    const eye = mesh(geo('br_eye', () => new THREE.SphereGeometry(0.09, 8, 6)), M.glowWarm, head, s * 0.18, 0.06, 0.33);
    eye.castShadow = false;
    const horn = mesh(geo('br_horn', () => new THREE.ConeGeometry(0.11, 0.8, 6)), M.bone, head, s * 0.26, 0.3, -0.05);
    horn.rotation.set(-0.5, 0, -s * 0.45);
  }
  // arms
  const arms = [];
  for (const s of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(s * 1.0, 2.35, 0);
    body.add(shoulder);
    const upper = mesh(geo('br_upper', () => {
      const g = new THREE.CylinderGeometry(0.22, 0.18, 1.0, 8); g.translate(0, -0.5, 0); return g;
    }), M.plate, shoulder);
    upper.rotation.z = s * 0.35;
    const elbow = new THREE.Group();
    elbow.position.set(0, -1.0, 0);
    shoulder.add(elbow);
    const fore = mesh(geo('br_fore', () => {
      const g = new THREE.CylinderGeometry(0.26, 0.2, 0.95, 8); g.translate(0, -0.47, 0); return g;
    }), M.plate, elbow);
    const fist = mesh(geo('br_fist', () => new THREE.SphereGeometry(0.36, 10, 8)), M.dark, elbow, 0, -1.0, 0);
    arms.push({ shoulder, elbow, fist, side: s });
  }
  // legs
  const legs = [];
  for (const s of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(s * 0.48, 1.2, 0);
    body.add(hip);
    const up = mesh(geo('br_thigh', () => {
      const g = new THREE.CylinderGeometry(0.28, 0.22, 1.1, 8); g.translate(0, -0.55, 0); return g;
    }), M.plate, hip);
    const knee = new THREE.Group();
    knee.position.set(0, -1.1, 0);
    hip.add(knee);
    mesh(geo('br_shin', () => {
      const g = new THREE.CylinderGeometry(0.22, 0.16, 1.1, 8); g.translate(0, -0.55, 0); return g;
    }), M.dark, knee);
    const foot = mesh(geo('br_foot', () => new THREE.BoxGeometry(0.42, 0.18, 0.72)), M.dark, knee, 0, -1.16, 0.14);
    legs.push({ hip, knee, side: s });
  }
  // back crystals
  const crystals = [];
  for (let i = 0; i < 5; i++) {
    const c = mesh(geo('br_crystal', () => new THREE.ConeGeometry(0.16, 0.9, 5)), M.glowWarm, body,
      (i - 2) * 0.34, 2.5 + Math.abs(i - 2) * -0.16, -0.7);
    c.rotation.set(-0.6, 0, (i - 2) * 0.18);
    c.castShadow = false;
    crystals.push(c);
  }
  return { root, body, head, arms, legs, crystals, parts: { body, head } };
}

function buildSpitter(M) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const sac = mesh(geo('sp_sac', () => new THREE.SphereGeometry(0.72, 16, 13)), M.flesh, body, 0, 1.15, 0);
  sac.scale.set(1, 1.2, 1);
  const glowSac = mesh(geo('sp_sac2', () => new THREE.SphereGeometry(0.5, 12, 10)), M.glow, body, 0, 1.15, 0);
  glowSac.material = M.glow.clone();
  glowSac.material.transparent = true;
  glowSac.material.opacity = 0.35;
  glowSac.castShadow = false;
  const head = new THREE.Group();
  head.position.set(0, 1.86, 0.1);
  body.add(head);
  mesh(geo('sp_head2', () => new THREE.SphereGeometry(0.3, 12, 10)), M.dark, head).scale.set(1, 0.85, 1.2);
  const maw = mesh(geo('sp_maw', () => new THREE.ConeGeometry(0.22, 0.5, 8, 1, true)), M.bone, head, 0, -0.02, 0.28);
  maw.rotation.x = Math.PI / 2;
  for (const s of [-1, 1]) {
    const eye = mesh(geo('sp_eye2', () => new THREE.SphereGeometry(0.055, 8, 6)), M.glow, head, s * 0.16, 0.08, 0.2);
    eye.castShadow = false;
  }
  const legs = [];
  for (let i = 0; i < 4; i++) {
    const s = i % 2 === 0 ? -1 : 1, r = i < 2 ? 1 : -1;
    const hip = new THREE.Group();
    hip.position.set(s * 0.44, 0.95, r * 0.22);
    body.add(hip);
    const g = geo('sp_leg2', () => { const gg = new THREE.CylinderGeometry(0.07, 0.05, 1.0, 6); gg.translate(0, -0.5, 0); return gg; });
    mesh(g, M.dark, hip).rotation.z = s * 0.7;
    const knee = new THREE.Group(); knee.position.set(0, -1.0, 0); hip.add(knee);
    mesh(g, M.dark, knee).rotation.z = -s * 0.5;
    legs.push({ hip, knee, side: s, phase: i * 1.57 });
  }
  return { root, body, head, legs, maw, glowSac, parts: { body, head } };
}

function buildWraith(M) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const core = mesh(geo('wr_core', () => new THREE.SphereGeometry(0.34, 12, 10)), M.ghost, body, 0, 1.55, 0);
  const head = new THREE.Group();
  head.position.set(0, 2.05, 0);
  body.add(head);
  mesh(geo('wr_head', () => new THREE.SphereGeometry(0.26, 12, 10)), M.ghost, head).scale.set(1, 1.15, 1);
  for (const s of [-1, 1]) {
    const eye = mesh(geo('wr_eye', () => new THREE.SphereGeometry(0.05, 8, 6)), M.glowViolet, head, s * 0.1, 0.03, 0.2);
    eye.castShadow = false;
  }
  const torso = mesh(geo('wr_torso', () => new THREE.CylinderGeometry(0.42, 0.16, 1.5, 10, 1, true)), M.ghost, body, 0, 1.1, 0);
  torso.rotation.x = Math.PI;
  // tattered tendrils
  const tendrils = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const t = mesh(geo('wr_tendril', () => new THREE.CylinderGeometry(0.05, 0.01, 1.3, 5)), M.ghost, body,
      Math.cos(a) * 0.28, 0.7, Math.sin(a) * 0.28);
    t.userData.a = a;
    tendrils.push(t);
  }
  // arms
  const arms = [];
  for (const s of [-1, 1]) {
    const sh = new THREE.Group();
    sh.position.set(s * 0.4, 1.75, 0);
    body.add(sh);
    const g = geo('wr_arm', () => { const gg = new THREE.CylinderGeometry(0.07, 0.04, 1.1, 6); gg.translate(0, -0.55, 0); return gg; });
    mesh(g, M.ghost, sh).rotation.z = s * 0.4;
    const el = new THREE.Group(); el.position.set(0, -1.1, 0); sh.add(el);
    mesh(g, M.ghost, el).rotation.z = -s * 0.8;
    arms.push({ shoulder: sh, elbow: el, side: s });
  }
  return { root, body, head, tendrils, arms, parts: { body, head } };
}

function buildTitan(M) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const torso = mesh(geo('ti_torso', () => new THREE.SphereGeometry(2.4, 20, 16)), M.plate, body, 0, 5.4, 0);
  torso.scale.set(1.25, 1.1, 0.9);
  const chest = mesh(geo('ti_chest', () => new THREE.SphereGeometry(1.2, 14, 12)), M.glowWarm, body, 0, 5.4, 1.9);
  chest.castShadow = false;
  const head = new THREE.Group();
  head.position.set(0, 7.4, 0.4);
  body.add(head);
  mesh(geo('ti_head', () => new THREE.SphereGeometry(0.9, 14, 12)), M.dark, head).scale.set(1.1, 0.9, 1.2);
  for (const s of [-1, 1]) {
    const eye = mesh(geo('ti_eye', () => new THREE.SphereGeometry(0.18, 10, 8)), M.glowWarm, head, s * 0.38, 0.12, 0.7);
    eye.castShadow = false;
    const horn = mesh(geo('ti_horn', () => new THREE.ConeGeometry(0.28, 2.2, 6)), M.bone, head, s * 0.6, 0.7, -0.2);
    horn.rotation.set(-0.6, 0, -s * 0.5);
  }
  const arms = [];
  for (const s of [-1, 1]) {
    const sh = new THREE.Group(); sh.position.set(s * 2.6, 6.3, 0); body.add(sh);
    mesh(geo('ti_upper', () => { const g = new THREE.CylinderGeometry(0.55, 0.45, 2.6, 9); g.translate(0, -1.3, 0); return g; }), M.plate, sh).rotation.z = s * 0.3;
    const el = new THREE.Group(); el.position.set(0, -2.6, 0); sh.add(el);
    mesh(geo('ti_fore', () => { const g = new THREE.CylinderGeometry(0.62, 0.5, 2.4, 9); g.translate(0, -1.2, 0); return g; }), M.plate, el);
    const fist = mesh(geo('ti_fist', () => new THREE.SphereGeometry(0.95, 12, 10)), M.dark, el, 0, -2.5, 0);
    arms.push({ shoulder: sh, elbow: el, fist, side: s });
  }
  const legs = [];
  for (const s of [-1, 1]) {
    const hip = new THREE.Group(); hip.position.set(s * 1.15, 3.2, 0); body.add(hip);
    mesh(geo('ti_thigh', () => { const g = new THREE.CylinderGeometry(0.7, 0.55, 2.6, 9); g.translate(0, -1.3, 0); return g; }), M.plate, hip);
    const kn = new THREE.Group(); kn.position.set(0, -2.6, 0); hip.add(kn);
    mesh(geo('ti_shin', () => { const g = new THREE.CylinderGeometry(0.55, 0.42, 2.4, 9); g.translate(0, -1.2, 0); return g; }), M.dark, kn);
    mesh(geo('ti_foot', () => new THREE.BoxGeometry(1.1, 0.45, 1.8)), M.dark, kn, 0, -2.5, 0.3);
    legs.push({ hip, knee: kn, side: s });
  }
  const crystals = [];
  for (let i = 0; i < 9; i++) {
    const c = mesh(geo('ti_xtal', () => new THREE.ConeGeometry(0.4, 2.4, 5)), M.glowWarm, body,
      (i - 4) * 0.7, 6.6 - Math.abs(i - 4) * 0.35, -1.7);
    c.rotation.set(-0.55, 0, (i - 4) * 0.16);
    c.castShadow = false;
    crystals.push(c);
  }
  return { root, body, head, arms, legs, crystals, parts: { body, head }, weak: chest };
}

const BUILDERS = { spawnling: buildSpawnling, brute: buildBrute, spitter: buildSpitter, wraith: buildWraith, titan: buildTitan };

// ---------------------------------------------------------------- creature
export class Creature {
  constructor(type) {
    this.type = type;
    this.def = ARCHETYPES[type];
    this.M = creatureMaterials();
    const built = BUILDERS[type](this.M);
    Object.assign(this, built);
    this.root.userData.creature = this;
    // tag small parts so they can be hidden at distance (draw-call saver)
    this.root.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      const r = o.geometry.boundingSphere.radius * (o.scale.x || 1);
      o.userData.detail = r < 0.09 ? 2 : r < 0.22 ? 1 : 0;
    });
    this.detail = 2;
    this.t = Math.random() * 10;
    this.phase = Math.random() * Math.PI * 2;
    this.mode = 'idle';
    this.speed = 0;
    this.hitFlash = 0;
    this.attackAnim = -1;
    this.hurtAnim = 0;
    this.deathAnim = 0;
    this.grow = 0;
    this.root.scale.setScalar(0.01);
    this.scaleVar = 1;
  }

  setDetail(level) {
    if (this.detail === level) return;
    this.detail = level;
    this.root.traverse((o) => {
      if (o.isMesh && o.userData.detail !== undefined) o.visible = o.userData.detail <= level;
    });
  }

  setScale(s) {
    this.scaleVar = s;
    this.root.scale.setScalar(s * Math.max(0.02, this.grow));
  }

  playAttack() { this.attackAnim = 0; }
  playHurt() { this.hurtAnim = 0.35; }
  playDeath() { this.deathAnim = 0.0001; this.mode = 'dead'; }

  update(dt, ctx = {}) {
    this.t += dt;
    this.grow = Math.min(1, this.grow + dt * 1.6);
    const g = this.grow;
    if (this.deathAnim > 0) {
      this.deathAnim += dt;
      const k = Math.min(1, this.deathAnim / 1.1);
      this.root.scale.setScalar(this.scaleVar * g * (1 - k * 0.85));
      this.root.rotation.z = k * 0.9;
      this.body.position.y = -k * 0.6;
      for (const c of this.crystals || []) c.material.emissiveIntensity = 3.2 * (1 - k);
      return k >= 1;
    } else {
      this.root.scale.setScalar(this.scaleVar * (0.35 + 0.65 * g));
    }

    const t = this.t;
    const moving = this.speed > 0.15;
    const rate = 3 + this.speed * 1.5;
    this.hurtAnim = Math.max(0, this.hurtAnim - dt);
    if (this.attackAnim >= 0) this.attackAnim += dt;

    switch (this.type) {
      case 'spawnling': {
        const sw = Math.sin(t * rate + this.phase);
        this.body.position.y = Math.abs(sw) * 0.06 + (moving ? 0.02 : 0);
        this.body.rotation.z = Math.sin(t * rate * 0.5) * 0.05;
        for (const l of this.legs) {
          const p = Math.sin(t * rate + l.phase);
          l.hip.rotation.x = p * (moving ? 0.7 : 0.12);
          l.knee.rotation.x = Math.max(0, -p) * 0.9 + 0.2;
          l.hip.rotation.z = l.side * (0.9 + Math.cos(t * rate + l.phase) * 0.12);
        }
        this.head.rotation.x = -0.15 + Math.sin(t * 2.1) * 0.08;
        if (this.attackAnim >= 0) {
          const k = Math.sin(Math.min(1, this.attackAnim / 0.35) * Math.PI);
          this.head.rotation.x -= k * 0.9;
          this.body.position.z += k * 0.35;
        }
        break;
      }
      case 'brute': {
        const sw = Math.sin(t * rate * 0.6);
        this.body.position.y = sw * 0.09 * (moving ? 1 : 0.3);
        this.body.rotation.z = sw * 0.035;
        for (const l of this.legs) {
          const p = Math.sin(t * rate * 0.6 + (l.side > 0 ? 0 : Math.PI));
          l.hip.rotation.x = p * (moving ? 0.62 : 0.05);
          l.knee.rotation.x = Math.max(0, -p) * 0.8 + 0.1;
        }
        for (const a of this.arms) {
          const base = Math.sin(t * rate * 0.6 + (a.side > 0 ? Math.PI : 0)) * (moving ? 0.5 : 0.08);
          a.shoulder.rotation.x = base;
          a.shoulder.rotation.z = a.side * 0.35;
          a.elbow.rotation.x = 0.5 + Math.abs(base) * 0.3;
        }
        this.head.rotation.y = Math.sin(t * 0.7) * 0.25;
        if (this.attackAnim >= 0) {
          const p = clamp(this.attackAnim / 0.7, 0, 1);
          const k = p < 0.4 ? -p / 0.4 : Math.sin(((p - 0.4) / 0.6) * Math.PI);
          for (const a of this.arms) { a.shoulder.rotation.x = -1.6 * p * (p < 0.4 ? 1 : 0) + (p >= 0.4 ? -2.1 + k * 3.2 : 0); a.elbow.rotation.x = 0.2; }
          this.body.rotation.x = (p >= 0.4 ? k * 0.35 : -0.2 * p);
        }
        for (let i = 0; i < this.crystals.length; i++) {
          this.crystals[i].material.emissiveIntensity = 2.6 + Math.sin(t * 3 + i) * 0.9;
        }
        break;
      }
      case 'spitter': {
        const sw = Math.sin(t * rate * 0.8);
        this.body.position.y = sw * 0.07;
        this.body.rotation.z = Math.sin(t * rate * 0.4) * 0.06;
        for (const l of this.legs) {
          const p = Math.sin(t * rate * 0.8 + l.phase);
          l.hip.rotation.x = p * (moving ? 0.45 : 0.05);
          l.knee.rotation.x = Math.max(0, -p) * 0.6;
        }
        const charge = this.attackAnim >= 0 ? clamp(this.attackAnim / 0.6, 0, 1) : 0;
        this.glowSac.material.opacity = 0.25 + (charge > 0 ? charge * 0.6 : 0) + Math.sin(t * 2.4) * 0.08;
        this.glowSac.scale.setScalar(1 + charge * 0.25);
        this.head.rotation.x = -charge * 0.5;
        break;
      }
      case 'wraith': {
        this.body.position.y = Math.sin(t * 1.6) * 0.22;
        this.body.rotation.y += dt * 0.4;
        for (let i = 0; i < this.tendrils.length; i++) {
          const tt = this.tendrils[i];
          tt.rotation.x = Math.sin(t * 2.2 + i) * 0.3;
          tt.rotation.z = Math.cos(t * 1.9 + i) * 0.3;
        }
        for (const a of this.arms) {
          a.shoulder.rotation.x = Math.sin(t * 1.7 + (a.side > 0 ? 1.4 : 0)) * 0.4;
          a.elbow.rotation.x = 0.6 + Math.sin(t * 2.1) * 0.3;
        }
        if (this.attackAnim >= 0) {
          const p = Math.min(1, this.attackAnim / 0.4);
          for (const a of this.arms) a.shoulder.rotation.x = -1.8 * Math.sin(p * Math.PI);
        }
        break;
      }
      case 'titan': {
        const sw = Math.sin(t * rate * 0.45);
        this.body.position.y = sw * 0.16 * (moving ? 1 : 0.4);
        for (const l of this.legs) {
          const p = Math.sin(t * rate * 0.45 + (l.side > 0 ? 0 : Math.PI));
          l.hip.rotation.x = p * (moving ? 0.5 : 0.03);
          l.knee.rotation.x = Math.max(0, -p) * 0.7 + 0.05;
        }
        for (const a of this.arms) {
          a.shoulder.rotation.x = Math.sin(t * rate * 0.45 + (a.side > 0 ? Math.PI : 0)) * (moving ? 0.35 : 0.05);
          a.elbow.rotation.x = 0.35;
        }
        this.head.rotation.y = Math.sin(t * 0.5) * 0.2;
        for (let i = 0; i < this.crystals.length; i++) {
          this.crystals[i].material.emissiveIntensity = 2.4 + Math.sin(t * 2.2 + i * 0.7) * 1.2;
        }
        if (this.attackAnim >= 0) {
          const p = clamp(this.attackAnim / 1.0, 0, 1);
          const k = p < 0.45 ? p / 0.45 : 1 - (p - 0.45) / 0.55;
          for (const a of this.arms) { a.shoulder.rotation.x = -2.4 * k; a.elbow.rotation.x = 0.1; }
          this.body.rotation.x = k * 0.3;
        }
        break;
      }
    }

    // hurt flash
    if (this.hurtAnim > 0) {
      const k = this.hurtAnim / 0.35;
      this.body.rotation.z += Math.sin(t * 40) * 0.05 * k;
      this.body.position.x = Math.sin(t * 55) * 0.05 * k;
    } else this.body.position.x = 0;
    return false;
  }

  dispose() { this.root.removeFromParent(); }
}

/** Build a creature instance; `variant` scales size/health slightly. */
export function makeCreature(type, rng) {
  const r = rng || new Rng(1);
  const c = new Creature(type);
  const s = r.range(0.88, 1.16);
  c.scaleVar = s;
  c.root.scale.setScalar(s * 0.35);
  return c;
}
