// Weapon definitions, view-model rig and firing state machine.
// Ammo is unlimited by design (the shard-fed magazines refill themselves), but
// magazines still empty so combat keeps its rhythm.
import * as THREE from 'three';
import assets from '../core/assets.js';
import { Rng, clamp, lerp } from '../core/rng.js';

export const WEAPONS = {
  rifle: {
    id: 'rifle', name: 'AR-17 Dawnbreaker', slot: 'primary', model: 'rifle_assault', kind: 'auto',
    damage: 26, rpm: 640, magSize: 30, reload: 2.05, spread: 0.9, adsSpread: 0.28, range: 190,
    pellets: 1, recoil: 0.55, zoom: 1.35, movePenalty: 0.82, projSpeed: 420, headMult: 2.4,
    desc: 'Reliable shard-fed assault rifle. Balanced in every way.',
    stats: { damage: 6, rate: 7, range: 7, control: 6, mobility: 6 },
  },
  smg: {
    id: 'smg', name: 'Kestrel SMG-9', slot: 'primary', model: 'smg', kind: 'auto',
    damage: 17, rpm: 950, magSize: 40, reload: 1.7, spread: 1.5, adsSpread: 0.55, range: 105,
    pellets: 1, recoil: 0.38, zoom: 1.18, movePenalty: 0.95, projSpeed: 380, headMult: 1.9,
    desc: 'Sprays cheap shards fast. Melts swarms, struggles at range.',
    stats: { damage: 4, rate: 10, range: 4, control: 7, mobility: 9 },
  },
  shotgun: {
    id: 'shotgun', name: 'Hearthbreaker-12', slot: 'primary', model: 'shotgun', kind: 'pump',
    damage: 15, rpm: 95, magSize: 7, reload: 2.8, spread: 4.2, adsSpread: 2.4, range: 46,
    pellets: 9, recoil: 1.1, zoom: 1.1, movePenalty: 0.86, projSpeed: 300, headMult: 1.5,
    desc: 'Nine shard flechettes per shell. Devastating up close.',
    stats: { damage: 10, rate: 3, range: 2, control: 3, mobility: 6 },
  },
  sniper: {
    id: 'sniper', name: 'Vigil .50 Aether', slot: 'primary', model: 'sniper', kind: 'bolt',
    damage: 140, rpm: 48, magSize: 5, reload: 3.1, spread: 2.6, adsSpread: 0.02, range: 460,
    pellets: 1, recoil: 1.35, zoom: 4.5, movePenalty: 0.7, projSpeed: 900, headMult: 3.2,
    desc: 'One shot, one husk. Pierces the first target it meets.',
    stats: { damage: 10, rate: 2, range: 10, control: 2, mobility: 4 },
  },
  pistol: {
    id: 'pistol', name: 'Sidearm "Ember"', slot: 'secondary', model: 'pistol', kind: 'semi',
    damage: 34, rpm: 420, magSize: 14, reload: 1.4, spread: 1.2, adsSpread: 0.35, range: 90,
    pellets: 1, recoil: 0.5, zoom: 1.2, movePenalty: 1.0, projSpeed: 360, headMult: 2.2,
    desc: 'Always there when the primary runs dry.',
    stats: { damage: 5, rate: 6, range: 4, control: 6, mobility: 10 },
  },
  blade: {
    id: 'blade', name: 'Aether Blade', slot: 'melee', model: null, kind: 'melee',
    damage: 120, rpm: 90, magSize: Infinity, reload: 0, spread: 0, adsSpread: 0, range: 3.4,
    pellets: 1, recoil: 0.2, zoom: 1.0, movePenalty: 1.0, projSpeed: 0, headMult: 1.0,
    desc: 'A shard of the meteor itself, honed to a monomolecular edge.',
    stats: { damage: 8, rate: 4, range: 1, control: 8, mobility: 8 },
  },
};

export const WEAPON_LIST = Object.values(WEAPONS);

const _v = new THREE.Vector3();

export class Weapon {
  constructor(id, opts = {}) {
    this.def = WEAPONS[id] || WEAPONS.rifle;
    this.id = this.def.id;
    this.ammo = this.def.magSize;
    this.cooldown = 0;
    this.reloading = 0;
    this.heat = 0;
    this.kills = 0;
    this.shots = 0;
    this.hits = 0;
    this.level = 1;
    this.xp = 0;
    this.mods = [];
    this.owner = opts.owner || null;
    this.buildView(opts.camera);
    this.buildWorld();
  }

  // ---------- viewmodel (first person) ----------
  buildView(camera) {
    const g = new THREE.Group();
    g.name = 'viewmodel-' + this.id;
    const m = this.def.model ? assets.model('weapons', this.def.model) : null;
    if (m) {
      m.traverse((o) => {
        if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; o.renderOrder = 10; }
      });
      m.scale.setScalar(1.0);
      this.muzzleOffset = new THREE.Vector3(0, 0.02, 0.42);
      g.add(m);
    } else {
      // procedural aether blade
      const blade = new THREE.Group();
      const grip = new THREE.Mesh(
        new THREE.CylinderGeometry(0.022, 0.026, 0.2, 10),
        new THREE.MeshStandardMaterial({ color: 0x2a2320, roughness: 0.8 })
      );
      grip.rotation.x = Math.PI / 2;
      blade.add(grip);
      const edge = new THREE.Mesh(
        new THREE.ConeGeometry(0.055, 0.62, 4),
        new THREE.MeshStandardMaterial({
          color: 0x9fe8ff, emissive: 0x49d8ff, emissiveIntensity: 2.6, roughness: 0.15, metalness: 0.6,
        })
      );
      edge.rotation.x = -Math.PI / 2;
      edge.position.z = 0.4;
      blade.add(edge);
      this.bladeEdge = edge;
      this.muzzleOffset = new THREE.Vector3(0, 0.05, 0.6);
      g.add(blade);
    }
    // muzzle flash
    const flash = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xfff0c0, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    const star = new THREE.Mesh(
      new THREE.ConeGeometry(0.14, 0.42, 6, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffc266, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
    );
    star.rotation.x = -Math.PI / 2;
    star.position.z = 0.18;
    flash.add(core, star);
    flash.visible = false;
    flash.renderOrder = 20;
    this.flash = flash;
    this.flashParts = [core, star];
    g.add(flash);
    if (this.muzzleOffset) flash.position.copy(this.muzzleOffset);

    const light = new THREE.PointLight(0xffc077, 0, 14, 2);
    this.muzzleLight = light;
    g.add(light);

    this.view = g;
    this.viewBase = new THREE.Vector3(0.24, -0.2, -0.42);
    this.adsBase = new THREE.Vector3(0.0, -0.115, -0.30);
    this.view.position.copy(this.viewBase);
    this.flashTime = 0;
  }

  buildWorld() {
    if (!this.def.model) return null;
    const m = assets.model('weapons', this.def.model);
    if (!m) return null;
    m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.world = m;
    return m;
  }

  get damage() { return this.def.damage * (1 + (this.level - 1) * 0.06); }
  get fireDelay() { return 60 / this.def.rpm; }
  get reloadTime() { return this.def.reload; }
  get empty() { return this.def.magSize !== Infinity && this.ammo <= 0; }

  canFire(held) {
    if (this.cooldown > 0) return false;
    if (this.reloading > 0) return false;
    if (this.empty) return false;
    if (this.def.kind === 'semi' || this.def.kind === 'pump' || this.def.kind === 'bolt' || this.def.kind === 'melee') {
      if (!held) return false;
    }
    return true;
  }

  startReload() {
    if (this.reloading > 0) return false;
    if (this.def.magSize === Infinity) return false;
    if (this.ammo >= this.def.magSize) return false;
    this.reloading = this.reloadTime;
    return true;
  }

  /** consume one shot; returns spread angle in radians */
  fire(ads) {
    if (this.def.magSize !== Infinity) this.ammo--;
    this.cooldown = this.fireDelay;
    this.shots++;
    this.heat = Math.min(3, this.heat + 1);
    this.flashTime = 0.055;
    const base = this.def.spread * (1 - 0.35 * Math.min(1, this.level / 10));
    const bloom = this.heat * 0.16;
    const spr = (ads ? this.def.adsSpread : base) + bloom;
    return THREE.MathUtils.degToRad(spr);
  }

  addXp(amount) {
    this.xp += amount;
    const need = 120 + (this.level - 1) * 90;
    let leveled = 0;
    while (this.xp >= need + (this.level - 1) * 0) {
      // recompute per level
      const req = 120 + (this.level - 1) * 90;
      if (this.xp < req) break;
      this.xp -= req;
      this.level++;
      leveled++;
    }
    return leveled;
  }

  update(dt, state = {}) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.heat = Math.max(0, this.heat - dt * 2.4);
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) { this.reloading = 0; this.ammo = this.def.magSize; }
    }
    if (this.flashTime > 0) {
      this.flashTime -= dt;
      const on = this.flashTime > 0;
      this.flash.visible = on;
      if (on) {
        const k = this.flashTime / 0.055;
        this.flash.scale.setScalar(0.7 + (1 - k) * 0.9);
        this.flash.rotation.z = Math.random() * Math.PI;
        for (const p of this.flashParts) p.material.opacity = 0.95 * k;
        this.muzzleLight.intensity = 55 * k;
      } else this.muzzleLight.intensity = 0;
    }
    if (this.bladeEdge) {
      this.bladeEdge.material.emissiveIntensity = 2.2 + Math.sin(performance.now() * 0.004) * 0.5;
    }

    // viewmodel placement: idle sway, walk bob, reload tilt, ads
    if (this.view && state.camera) {
      const ads = state.ads ? 1 : 0;
      this.adsBlend = lerp(this.adsBlend ?? 0, ads, 1 - Math.pow(0.001, dt));
      const speed = state.speed || 0;
      const t = state.time || 0;
      const bob = Math.min(1, speed / 6);
      const sway = new THREE.Vector3(
        Math.sin(t * 1.1) * 0.006 + (state.lookX || 0) * -0.02,
        Math.sin(t * 2.2) * 0.005 * (0.4 + bob) + Math.abs(Math.sin(t * 4.4)) * 0.012 * bob,
        0
      );
      const target = this.viewBase.clone().lerp(this.adsBase, this.adsBlend).add(sway);
      // reload animation
      if (this.reloading > 0) {
        const p = 1 - this.reloading / this.reloadTime;
        const arc = Math.sin(p * Math.PI);
        target.y -= arc * 0.28;
        target.x -= arc * 0.1;
        this.view.rotation.x = -arc * 0.9;
        this.view.rotation.z = arc * 0.5;
      } else {
        this.view.rotation.x = lerp(this.view.rotation.x, (state.pitch || 0) * 0.12, 0.2);
        this.view.rotation.z = lerp(this.view.rotation.z, 0, 0.2);
      }
      // recoil kick on the viewmodel
      if (this.flashTime > 0) {
        const k = this.flashTime / 0.055;
        target.z += k * 0.09 * this.def.recoil;
        target.y += k * 0.03 * this.def.recoil;
      }
      this.view.position.lerp(target, 1 - Math.pow(0.0001, dt));
      this.view.rotation.y = lerp(this.view.rotation.y, this.adsBlend > 0.5 ? 0 : -0.04, 0.2);
    }
  }

  attach(camera) {
    if (this.view) camera.add(this.view);
  }
  detach(camera) {
    if (this.view) camera.remove(this.view);
  }
  worldPos(out = new THREE.Vector3()) {
    if (this.view && this.muzzleOffset) return out.copy(this.muzzleOffset).applyMatrix4(this.view.matrixWorld);
    return out.set(0, 0, 0);
  }
}

/** Builds the starting loadout for the player. */
export function startingLoadout(ids = ['rifle', 'shotgun', 'pistol']) {
  return ids.map((id) => new Weapon(id));
}
