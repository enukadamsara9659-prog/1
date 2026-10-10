// Companion squad: three AI teammates that fight, banter and revive you.
import * as THREE from 'three';
import { Character } from './character.js';
import { Rng, clamp, lerp, damp } from '../core/rng.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _push = { x: 0, z: 0 };

export const COMPANIONS = [
  {
    id: 'mira', name: 'Mira Sol', model: 'michelle', height: 1.72, role: 'Marksman',
    weapon: 'sniper', fireRate: 0.9, damage: 55, range: 150, accuracy: 0.045, color: 0xd8c7b0,
    perk: 'Spotter — marks enemies, revealing them through terrain for 6s',
    voice: 'female',
  },
  {
    id: 'dorn', name: 'Dorn Halvard', model: 'xbot', height: 1.88, role: 'Bulwark',
    weapon: 'shotgun', fireRate: 1.15, damage: 34, range: 34, accuracy: 0.075, color: 0xb9c4d0,
    perk: 'Bulwark — draws enemy fire and vents a shield pulse when surrounded',
    voice: 'male',
  },
  {
    id: 'nyx', name: 'Nyx Ardyn', model: 'soldier', height: 1.78, role: 'Engineer',
    weapon: 'smg', fireRate: 0.13, damage: 15, range: 70, accuracy: 0.06, color: 0x9fb0c8,
    perk: 'Tinker — drops shard turrets and repairs your shield out of combat',
    voice: 'female',
  },
];

class Companion {
  constructor(def, index, ctx) {
    this.def = def;
    this.index = index;
    this.ctx = ctx;
    this.name = def.name;
    this.level = 1;
    this.xp = 0;
    this.maxHealth = 160;
    this.health = 160;
    this.down = false;
    this.downTimer = 0;
    this.reviveT = 0;
    this.kills = 0;
    this.affinity = 0;

    this.char = new Character({ model: def.model, height: def.height, name: def.name, tint: def.color });
    this.group = new THREE.Group();
    this.group.add(this.char.group);
    ctx.scene.add(this.group);

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.radius = 0.42;
    this.speed = 0;
    this.fireCd = Math.random();
    this.burst = 0;
    this.target = null;
    this.state = 'follow';
    this.barkCd = 0;
    this.pitch = 0;
    this.aimDir = new THREE.Vector3(0, 0, 1);
    this.muzzle = new THREE.Vector3();
    this.stagger = 0;

    // weapon in hand
    const wm = ctx.assets.model('weapons', def.weapon);
    if (wm) {
      wm.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
      this.weaponMesh = wm;
      this.char.attachToHand(wm, 'handR', new THREE.Vector3(0.02, -0.04, 0.05), new THREE.Vector3(-Math.PI / 2, 0, 0));
    }
    // shoulder light so you can spot them at night
    this.light = new THREE.PointLight(0x9fd8ff, 1.4, 9, 2);
    this.light.position.set(0, 1.6, 0);
    this.group.add(this.light);
  }

  spawnNear(player) {
    const a = Math.random() * Math.PI * 2;
    const r = 2.5 + this.index * 1.1;
    this.pos.set(player.pos.x + Math.cos(a) * r, 0, player.pos.z + Math.sin(a) * r);
    this.pos.y = this.ctx.world.heightAt(this.pos.x, this.pos.z);
    this.group.position.copy(this.pos);
  }

  damage(amount, from) {
    if (this.down) return;
    this.health -= amount;
    this.char.hitReact(from ? _v.copy(this.pos).sub(from).normalize() : null);
    this.stagger = 0.25;
    if (this.health <= 0) {
      this.health = 0;
      this.down = true;
      this.downTimer = 30;
      this.char.die();
      this.ctx.events?.emit('companion:down', this);
      this.bark('I\'m down! Don\'t let them finish me!');
    }
  }

  revive() {
    this.down = false;
    this.health = this.maxHealth * 0.6;
    this.char.revive();
    this.ctx.events?.emit('companion:up', this);
    this.bark('Back on my feet. Thanks.');
  }

  addXp(n) {
    this.xp += n;
    while (this.xp >= 200 * this.level) {
      this.xp -= 200 * this.level;
      this.level++;
      this.maxHealth += 18;
      this.health = this.maxHealth;
      this.ctx.events?.emit('companion:levelup', this);
    }
  }

  bark(text) {
    if (this.barkCd > 0) return;
    this.barkCd = 5;
    this.ctx.events?.emit('bark', { who: this.def, text });
  }

  update(dt, player, squad) {
    this.barkCd = Math.max(0, this.barkCd - dt);
    this.stagger = Math.max(0, this.stagger - dt);
    this.char.update(dt, this.aimDir);
    if (this.down) {
      this.downTimer -= dt;
      if (this.downTimer <= 0) { this.revive(); }
      this.speed = 0;
      this.char.setSpeed(0);
      this.group.position.copy(this.pos);
      return;
    }

    const world = this.ctx.world;
    const enemies = this.ctx.enemies;

    // ---- pick a target
    let best = null, bestD = Infinity;
    for (const e of enemies.active) {
      if (e.state === 'dead') continue;
      const d = Math.hypot(e.pos.x - this.pos.x, e.pos.z - this.pos.z);
      if (d < this.def.range && d < bestD) { bestD = d; best = e; }
    }
    // prefer whatever the player is shooting at if it is close
    this.target = best;

    // ---- desired position
    const slotA = (-0.55 + this.index * 0.55) * Math.PI;
    let tx, tz;
    if (this.state === 'hold') { tx = this.holdX; tz = this.holdZ; }
    else {
      const back = 3.4 + Math.floor(this.index / 2) * 1.6;
      const side = (this.index % 2 === 0 ? -1 : 1) * (1.9 + Math.floor(this.index / 2) * 0.6);
      tx = player.pos.x - Math.sin(player.yaw) * back + Math.cos(player.yaw) * side;
      tz = player.pos.z - Math.cos(player.yaw) * back - Math.sin(player.yaw) * side;
    }
    // revive the player
    const toPlayer = Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
    if (player.downed && !player.dead) {
      tx = player.pos.x + Math.cos(this.index * 2.1) * 1.2;
      tz = player.pos.z + Math.sin(this.index * 2.1) * 1.2;
      if (toPlayer < 2.4) {
        player.reviveProgress += dt * (this.def.id === 'nyx' ? 0.55 : 0.34);
        this.ctx.events?.emit('revive:progress', player.reviveProgress);
        if (player.reviveProgress >= 1) {
          player.revive();
          this.bark('Got you, up!');
          this.affinity += 2;
        }
      }
    }

    // combat shuffle: back off if the target is very close, close in if far
    if (best) {
      const d = bestD;
      const ideal = this.def.range * 0.45;
      if (d < ideal * 0.6) {
        tx = this.pos.x + (this.pos.x - best.pos.x) * 0.6;
        tz = this.pos.z + (this.pos.z - best.pos.z) * 0.6;
      } else if (d > this.def.range * 0.85) {
        tx = this.pos.x + (best.pos.x - this.pos.x) * 0.3;
        tz = this.pos.z + (best.pos.z - this.pos.z) * 0.3;
      }
    }

    const wish = _v.set(tx - this.pos.x, 0, tz - this.pos.z);
    const distWish = wish.length();
    if (distWish > 0.01) wish.divideScalar(distWish);
    // separation from the other companions and player
    for (const o of squad.members) {
      if (o === this) continue;
      const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 4 && d2 > 0.001) { const d = Math.sqrt(d2); wish.x += (dx / d) * (1 - d / 2) * 1.4; wish.z += (dz / d) * (1 - d / 2) * 1.4; }
    }
    const pdx = this.pos.x - player.pos.x, pdz = this.pos.z - player.pos.z;
    const pd = Math.hypot(pdx, pdz);
    if (pd < 1.9 && pd > 0.001) { wish.x += (pdx / pd) * (1 - pd / 1.9) * 1.6; wish.z += (pdz / pd) * (1 - pd / 1.9) * 1.6; }
    wish.y = 0;
    if (wish.lengthSq() > 1) wish.normalize();

    let maxSpeed = distWish > 12 ? 6.6 : clamp(distWish * 1.5, 0, 5.4);
    if (this.stagger > 0) maxSpeed *= 0.4;
    // sprint to catch up
    if (distWish > 26 && this.state === 'follow') maxSpeed = 8.2;

    const target = wish.multiplyScalar(maxSpeed);
    const cur = _v2.set(this.vel.x, 0, this.vel.z);
    cur.lerp(target, clamp(dt * 8, 0, 1));
    this.vel.x = cur.x; this.vel.z = cur.z;

    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    // push out of the world
    _push.x = 0; _push.z = 0;
    this.ctx.vegetation?.trunkPush(this.pos.x, this.pos.z, this.radius, _push);
    this.ctx.structures?.resolveCollisions(this.pos.x, this.pos.z, this.radius, _push);
    this.pos.x += _push.x; this.pos.z += _push.z;

    const gy = world.heightAt(this.pos.x, this.pos.z);
    const floor = Math.max(gy, this.ctx.structures?.floorAt?.(this.pos.x, this.pos.z, this.pos.y + 1.2) ?? -Infinity);
    this.pos.y = damp(this.pos.y, floor, 10, dt);
    this.group.position.copy(this.pos);
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    this.char.setSpeed(this.speed);

    // ---- aim + shoot
    this.fireCd -= dt;
    if (best) {
      const eye = _v3.set(this.pos.x, this.pos.y + 1.45, this.pos.z);
      const aimAt = _v2.set(best.pos.x, best.pos.y + best.def.height * 0.55 * best.creature.scaleVar, best.pos.z);
      this.aimDir.copy(aimAt).sub(eye).normalize();
      const want = Math.atan2(this.aimDir.x, this.aimDir.z);
      let d = ((want - this.yaw + Math.PI) % (Math.PI * 2)) - Math.PI;
      if (d < -Math.PI) d += Math.PI * 2;
      this.yaw += d * clamp(dt * 9, 0, 1);
      this.char.aimWeight = damp(this.char.aimWeight, 1, 8, dt);
      if (this.fireCd <= 0 && Math.abs(d) < 0.6 && bestD < this.def.range) {
        this.fireCd = this.def.fireRate * (0.8 + Math.random() * 0.5);
        this.shoot(best);
      }
    } else {
      const want = player.yaw;
      let d = ((want - this.yaw + Math.PI) % (Math.PI * 2)) - Math.PI;
      if (d < -Math.PI) d += Math.PI * 2;
      this.yaw += d * clamp(dt * 4, 0, 1);
      this.aimDir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      this.char.aimWeight = damp(this.char.aimWeight, 0.35, 6, dt);
    }
    this.group.rotation.y = this.yaw - this.char.yawOffset;
    this.char.group.rotation.y = 0;
  }

  shoot(enemy) {
    this.char.fireRecoil(0.6);
    this.char.bonePosition('handR', this.muzzle);
    const hitChance = clamp(1 - this.def.accuracy - Math.max(0, (this.target ? Math.hypot(this.target.pos.x - this.pos.x, this.target.pos.z - this.pos.z) : 0) / this.def.range * 0.35), 0.25, 0.98);
    const hit = Math.random() < hitChance;
    const to = _v.copy(enemy.pos).setY(enemy.pos.y + enemy.def.height * 0.5 * enemy.creature.scaleVar);
    if (!hit) to.x += (Math.random() - 0.5) * 2.2, to.y += (Math.random() - 0.5) * 1.6, to.z += (Math.random() - 0.5) * 2.2;
    this.ctx.particles?.tracers.add(this.muzzle, to, 0xffd9a0, 0.05, 0.7);
    this.ctx.particles?.muzzleSmoke(this.muzzle, _v2.copy(to).sub(this.muzzle).normalize());
    this.ctx.audio?.play('shot_rifle', { pos: this.pos, gain: 0.35, rate: 0.8 + Math.random() * 0.4 });
    if (hit) {
      const dmg = this.def.damage * (1 + 0.12 * (this.level - 1)) * (Math.random() < 0.16 ? 2.2 : 1);
      this.ctx.enemies.damage(enemy, dmg, to.clone(), Math.random() < 0.16, this.def.id);
      this.addXp(4);
    }
  }
}

export class Squad {
  constructor(ctx) {
    this.ctx = ctx;
    this.members = COMPANIONS.map((def, i) => new Companion(def, i, ctx));
    this.mode = 'follow';
    this.barkTimer = 20;
    this.ambientLines = [
      ['mira', 'Wind\'s picking up. Something out there is moving.'],
      ['dorn', 'Stay behind me when they charge. I\'ll take the first hit.'],
      ['nyx', 'Those crystals… they\'re still broadcasting. To what?'],
      ['mira', 'Shard-light at two o\'clock. Eyes up.'],
      ['dorn', 'I hate the way the ground hums near the crater.'],
      ['nyx', 'If the meteor is still alive, we\'re the immune system.'],
    ];
  }

  spawn(player) {
    for (const m of this.members) m.spawnNear(player);
  }

  command(mode) {
    this.mode = mode;
    for (const m of this.members) {
      m.state = mode;
      if (mode === 'hold') { m.holdX = m.pos.x; m.holdZ = m.pos.z; }
    }
    this.ctx.events?.emit('squad:command', mode);
  }

  update(dt, player) {
    for (const m of this.members) m.update(dt, player, this);

    this.barkTimer -= dt;
    if (this.barkTimer <= 0) {
      this.barkTimer = 45 + Math.random() * 70;
      const [who, text] = this.ambientLines[Math.floor(Math.random() * this.ambientLines.length)];
      const m = this.members.find((x) => x.def.id === who);
      if (m && !m.down) { m.barkCd = 0; m.bark(text); }
    }
  }

  alive() { return this.members.filter((m) => !m.down).length; }
}
