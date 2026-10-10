// Enemy population + AI. Creatures live dormant inside nests and are
// instantiated only when the player is close, so a continent full of monsters
// costs almost nothing until you walk into it.
import * as THREE from 'three';
import { Creature, ARCHETYPES, makeCreature } from './creature.js';
import { Rng, clamp, lerp, damp } from '../core/rng.js';
import settings from '../core/settings.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

const TYPE_WEIGHTS = [
  ['spawnling', 0.52], ['brute', 0.13], ['spitter', 0.19], ['wraith', 0.16],
];

export class Enemies {
  constructor(ctx) {
    this.ctx = ctx; // { scene, world, structures, vegetation, player, particles, events, combat, audio }
    this.scene = ctx.scene;
    this.world = ctx.world;
    this.group = new THREE.Group();
    this.group.name = 'enemies';
    ctx.scene.add(this.group);
    this.rng = new Rng(9781);
    this.pops = [];
    this.active = [];
    this.corpses = [];
    this.maxActive = 22;
    this.activeRadius = 320;
    this.aggroMultiplier = 1;
    this.killCount = 0;
    this.difficulty = 1;
    this.think = 0;
    this.time = 0;
  }

  /** seed the population from nests, scorch and POIs */
  populate() {
    const { world } = this.ctx;
    const rng = this.rng;
    for (const nest of world.nests) {
      const strength = clamp(((nest.tier || 1) - 1) / 2, 0, 1) * 0.7 + 0.3;
      const size = Math.round(lerp(5, 14, strength));
      const types = [];
      for (let i = 0; i < size; i++) types.push(this.pickType(rng, strength));
      this.pops.push({ x: nest.x, z: nest.z, r: nest.radius || 40, kinds: types, alive: types.length, spawn: 0 });
    }
    // a scattering of lone wanderers across the map
    for (let i = 0; i < 90; i++) {
      const x = rng.range(-3600, 3600), z = rng.range(-3600, 3600);
      if (world.heightAt(x, z) < 1) continue;
      this.pops.push({ x, z, r: 30, kinds: [this.pickType(rng, 0.4)], alive: 1, spawn: 0 });
    }
    this.totalPop = this.pops.reduce((a, p) => a + p.alive, 0);
    this.remaining = this.totalPop;
    return this;
  }

  pickType(rng, strength = 0.5) {
    const r = rng.float();
    let acc = 0;
    for (const [t, w] of TYPE_WEIGHTS) {
      let ww = w;
      if (t === 'brute') ww *= 0.5 + strength;
      if (t === 'wraith') ww *= 0.6 + strength * 0.8;
      acc += ww;
      if (r <= acc) return t;
    }
    return 'spawnling';
  }

  spawnActive() {
    const p = this.ctx.player;
    if (!p) return;
    const px = p.pos.x, pz = p.pos.z;
    // sort pops by distance and spawn from the nearest
    const near = [];
    for (const pop of this.pops) {
      if (pop.alive <= 0) continue;
      const d = Math.hypot(pop.x - px, pop.z - pz);
      if (d < this.activeRadius) near.push([d, pop]);
    }
    near.sort((a, b) => a[0] - b[0]);
    for (const [d, pop] of near) {
      if (this.active.length >= this.maxActive) break;
      // don't spawn right on top of the player
      let tries = 0, x = 0, z = 0, ok = false;
      while (tries++ < 6 && !ok) {
        const a = this.rng.float() * Math.PI * 2;
        const rad = this.rng.range(6, Math.min(pop.r, 46));
        x = pop.x + Math.cos(a) * rad;
        z = pop.z + Math.sin(a) * rad;
        const dist = Math.hypot(x - px, z - pz);
        ok = dist > 45 && dist < this.activeRadius;
      }
      if (!ok) continue;
      this.spawnOne(pop, x, z);
    }
  }

  spawnOne(pop, x, z, typeOverride = null) {
    const kind = typeOverride || pop.kinds.pop();
    if (!kind) return null;
    pop.alive--;
    const c = makeCreature(kind, this.rng);
    const y = this.world.heightAt(x, z);
    c.root.position.set(x, y, z);
    this.group.add(c.root);
    const def = ARCHETYPES[kind];
    const e = {
      kind, creature: c, def, pop,
      pos: new THREE.Vector3(x, y, z),
      vel: new THREE.Vector3(),
      hp: def.hp * this.difficulty, maxHp: def.hp * this.difficulty,
      radius: def.radius * c.scaleVar,
      state: 'idle', yaw: this.rng.float() * Math.PI * 2,
      speed: 0, cd: this.rng.range(0, 1), wander: new THREE.Vector3(),
      wanderT: 0, alert: 0, lastSeen: 0, stagger: 0, slow: 0, burn: 0,
      detail: 2, lvl: 1,
    };
    this.applyLevel(e);
    this.active.push(e);
    this.ctx.events?.emit('enemy:spawned', e);
    return e;
  }

  applyLevel(e) {
    // scale with player level so the world keeps pace
    const pl = this.ctx.player?.level || 1;
    const k = 1 + Math.max(0, pl - 1) * 0.11;
    e.maxHp = e.def.hp * this.difficulty * k;
    e.hp = Math.min(e.hp, e.maxHp) || e.maxHp;
    e.lvl = Math.max(1, Math.round(pl * 0.8) + Math.round((this.rng.float() - 0.5) * 2));
    if (e.lvl < 1) e.lvl = 1;
  }

  // ------------------------------------------------------------- queries
  raycast(from, dir, maxDist = 200) {
    // returns { enemy, point, distance, head } or null
    let best = null;
    const to = _v3;
    for (const e of this.active) {
      if (e.state === 'dead') continue;
      // capsule-ish test: sphere at body centre + head sphere
      const bodyY = e.pos.y + e.def.height * 0.45 * e.creature.scaleVar;
      const headY = e.pos.y + e.def.height * 0.88 * e.creature.scaleVar;
      const rB = e.radius * 1.15;
      const rH = e.radius * 0.55;
      const dB = raySphere(from, dir, _v2.set(e.pos.x, bodyY, e.pos.z), rB);
      const dH = raySphere(from, dir, _v2.set(e.pos.x, headY, e.pos.z), rH);
      let d = null, head = false;
      if (dH !== null && (dB === null || dH < dB)) { d = dH; head = true; }
      else if (dB !== null) d = dB;
      if (d !== null && d < maxDist && (!best || d < best.distance)) {
        best = { enemy: e, distance: d, head, point: new THREE.Vector3().copy(from).addScaledVector(dir, d) };
      }
    }
    return best;
  }

  /** sphere query used for explosions / pulses */
  inRadius(pos, radius, out = []) {
    out.length = 0;
    for (const e of this.active) {
      if (e.state === 'dead') continue;
      const cy = e.pos.y + e.def.height * 0.5 * e.creature.scaleVar;
      const d = Math.hypot(e.pos.x - pos.x, e.pos.y + e.def.height * 0.4 - pos.y, e.pos.z - pos.z);
      if (d < radius + e.radius) out.push({ enemy: e, distance: d });
    }
    return out;
  }

  damage(enemy, amount, hitPos, head = false, source = 'player') {
    if (enemy.state === 'dead') return 0;
    let dmg = amount * (head ? (enemy.def.boss ? 1.6 : 2.4) : 1);
    // armoured plates soak front damage
    enemy.hp -= dmg;
    enemy.creature.playHurt();
    enemy.alert = 12;
    if (hitPos) {
      this.ctx.particles?.blood(hitPos, _v.copy(hitPos).sub(source === 'player' ? this.ctx.player.pos : hitPos).normalize().multiplyScalar(-0.4));
      this.ctx.floating?.add(hitPos, Math.round(dmg), head ? '#ffd45e' : '#ffffff', head ? 1.35 : 1);
    }
    this.ctx.audio?.play('hit_flesh', { gain: 0.5, rate: this.rng.range(0.9, 1.15) });
    if (enemy.hp <= 0) this.kill(enemy, source);
    return dmg;
  }

  kill(enemy, source = 'player') {
    if (enemy.state === 'dead') return;
    enemy.state = 'dead';
    enemy.creature.playDeath();
    this.killCount++;
    this.remaining = Math.max(0, this.remaining - 1);
    const p = this.ctx.player;
    this.ctx.particles?.explosion(_v.copy(enemy.pos).setY(enemy.pos.y + enemy.def.height * 0.5 * enemy.creature.scaleVar), enemy.def.radius * 1.6, 0x53ffc8);
    this.ctx.audio?.play('enemy_die', { rate: this.rng.range(0.85, 1.2), pos: enemy.pos });
    if (p) {
      const xp = enemy.def.xp * (1 + 0.06 * (enemy.lvl - 1));
      p.addXp(xp);
      p.shards += enemy.def.shards + Math.round(enemy.def.shards * 0.1 * enemy.lvl);
      p.kills++;
      if (enemy.def.boss) {
        p.aether += 3;
        this.ctx.events?.emit('boss:killed', enemy);
      }
    }
    this.ctx.events?.emit('enemy:killed', { enemy, source });
    this.corpses.push({ enemy, t: 6 });
  }

  // ------------------------------------------------------------- update
  update(dt) {
    this.time += dt;
    const player = this.ctx.player;
    if (!player) return;
    const px = player.pos.x, pz = player.pos.z, py = player.pos.y;

    if ((this.think -= dt) <= 0) { this.think = 0.35; this.spawnActive(); }

    const sep = new THREE.Vector3();
    for (let i = this.active.length - 1; i >= 0; i--) {
      const e = this.active[i];
      // cull / despawn
      const dist = Math.hypot(e.pos.x - px, e.pos.z - pz);
      if (e.state === 'dead') {
        const done = e.creature.update(dt);
        if (done || dist > this.activeRadius * 1.4) {
          e.creature.dispose();
          this.active.splice(i, 1);
        }
        continue;
      }
      if (dist > this.activeRadius * 1.25) {
        e.pop.kinds.push(e.kind);
        e.pop.alive++;
        e.creature.dispose();
        this.active.splice(i, 1);
        continue;
      }

      // ---- detail level
      const detail = dist > 150 ? 0 : dist > 70 ? 1 : 2;
      if (detail !== e.detail) { e.detail = detail; e.creature.setDetail(detail); }

      this.thinkAI(e, dt, player, px, py, pz, dist, sep);

      // ---- integrate motion
      const groundY = this.world.heightAt(e.pos.x, e.pos.z);
      const floor = Math.max(groundY, this.ctx.structures?.floorAt?.(e.pos.x, e.pos.z, e.pos.y + 1) ?? -Infinity);
      e.pos.x += e.vel.x * dt;
      e.pos.z += e.vel.z * dt;
      e.pos.y = damp(e.pos.y, floor, e.state === 'chase' ? 14 : 8, dt);
      // push out of trees / walls
      const push = _v.set(0, 0, 0);
      this.ctx.vegetation?.trunkPush(e.pos.x, e.pos.z, e.radius * 0.9, push);
      if (this.ctx.structures) this.ctx.structures.resolveCollisions(e.pos.x, e.pos.z, e.radius * 0.9, push);
      e.pos.x += push.x; e.pos.z += push.z;

      // ---- visual
      e.speed = Math.hypot(e.vel.x, e.vel.z);
      e.creature.speed = e.speed;
      e.creature.mode = e.state;
      e.creature.root.position.copy(e.pos);
      e.creature.root.rotation.y = e.yaw;
      e.creature.update(dt);
    }

    // corpses fade-out bookkeeping
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      this.corpses[i].t -= dt;
      if (this.corpses[i].t <= 0) this.corpses.splice(i, 1);
    }
  }

  thinkAI(e, dt, player, px, py, pz, dist, sep) {
    const cd = (e.cd -= dt);
    e.alert = Math.max(0, e.alert - dt);
    e.stagger = Math.max(0, e.stagger - dt);
    const def = e.def;
    const canSee = dist < def.aggro * this.aggroMultiplier && (dist < 14 || this.los(e, px, py, pz));
    if (canSee) { e.alert = 8; e.lastSeen = 0; } else e.lastSeen += dt;

    // ---- state transitions
    if (e.stagger > 0) e.state = 'stagger';
    else if (e.state !== 'attack' || cd > 0) {
      if (e.alert > 0 && e.lastSeen < 6) e.state = 'chase';
      else if (e.state === 'chase' && e.lastSeen > 6) e.state = 'patrol';
      else if (e.state === 'idle') e.state = 'patrol';
    }

    // ---- movement intent
    const wish = _v2.set(0, 0, 0);
    if (e.state === 'chase' || e.state === 'attack') {
      wish.set(px - e.pos.x, 0, pz - e.pos.z);
      const d = wish.length();
      wish.normalize();
      const want = def.ranged ? (d < 26 ? -0.6 : d > 40 ? 1 : 0) : (d > def.attackRange * 0.8 ? 1 : 0);
      wish.multiplyScalar(want);
      // strafe a little so they don't form a conga line
      wish.x += -wish.z * 0.25 * Math.sin(this.time * 1.7 + e.creature.phase);
      wish.z += wish.x * 0.12;
    } else if (e.state === 'patrol') {
      e.wanderT -= dt;
      if (e.wanderT <= 0) {
        e.wanderT = this.rng.range(2.5, 6);
        const a = this.rng.float() * Math.PI * 2;
        const r = this.rng.range(6, 26);
        e.wander.set(e.pop.x + Math.cos(a) * r, 0, e.pop.z + Math.sin(a) * r);
      }
      wish.set(e.wander.x - e.pos.x, 0, e.wander.z - e.pos.z);
      if (wish.length() > 2) wish.normalize();
      wish.multiplyScalar(0.34);
    }

    // separation
    sep.set(0, 0, 0);
    let n = 0;
    for (const o of this.active) {
      if (o === e || o.state === 'dead') continue;
      const dx = e.pos.x - o.pos.x, dz = e.pos.z - o.pos.z;
      const d2 = dx * dx + dz * dz;
      const rr = (e.radius + o.radius) * 1.35;
      if (d2 < rr * rr && d2 > 0.0001) {
        const d = Math.sqrt(d2);
        sep.x += (dx / d) * (1 - d / rr);
        sep.z += (dz / d) * (1 - d / rr);
        n++;
      }
    }
    if (n) wish.addScaledVector(sep.normalize(), 0.9);

    // ---- speed & steering
    let maxSpeed = def.speed;
    if (e.state === 'patrol') maxSpeed *= 0.45;
    if (e.state === 'stagger') maxSpeed *= 0.15;
    if (e.state === 'attack') maxSpeed *= 0.2;
    if (e.burn > 0) { e.burn -= dt; e.hp -= dt * 6 * (e.def.boss ? 0.4 : 1); maxSpeed *= 0.8; if (e.hp <= 0) { this.kill(e, 'burn'); return; } }
    if (e.slow > 0) { e.slow -= dt; maxSpeed *= 0.45; }

    const target = wish.multiplyScalar(maxSpeed);
    const cur = _v3.set(e.vel.x, 0, e.vel.z);
    cur.lerp(target, clamp(dt * (e.state === 'chase' ? 7 : 4), 0, 1));
    e.vel.x = cur.x; e.vel.z = cur.z;

    // face movement or the player
    const faceX = e.state === 'chase' || e.state === 'attack' ? px - e.pos.x : e.vel.x;
    const faceZ = e.state === 'chase' || e.state === 'attack' ? pz - e.pos.z : e.vel.z;
    if (Math.abs(faceX) + Math.abs(faceZ) > 0.01) {
      const want = Math.atan2(faceX, faceZ);
      let d = ((want - e.yaw + Math.PI) % (Math.PI * 2)) - Math.PI;
      if (d < -Math.PI) d += Math.PI * 2;
      e.yaw += d * clamp(dt * 8, 0, 1);
    }

    // ---- attacks
    if (e.state === 'chase' && canSee) {
      const reach = def.attackRange * (def.boss ? 1.1 : 1);
      if (dist < reach && cd <= 0) {
        e.state = 'attack';
        e.cd = def.attackCd * this.rng.range(0.85, 1.2);
        e.creature.playAttack();
        const delay = def.boss ? 420 : def.ranged ? 520 : 260;
        setTimeout(() => {
          if (e.state === 'dead' || !this.ctx.player) return;
          if (def.ranged) this.rangedAttack(e);
          else {
            const d2 = Math.hypot(e.pos.x - this.ctx.player.pos.x, e.pos.z - this.ctx.player.pos.z);
            if (d2 < reach * 1.35) {
              this.ctx.player.damage(def.damage * (1 + 0.1 * (e.lvl - 1)) * this.difficulty, e.pos, 'melee');
              this.ctx.audio?.play('claw', { pos: e.pos });
              this.ctx.particles?.sparks(this.ctx.player.pos.clone().setY(this.ctx.player.pos.y + 1.2), 6);
            }
          }
          e.state = 'chase';
        }, delay);
      }
    }

    // wraith blink
    if (e.kind === 'wraith' && e.state === 'chase' && (e.blinkCd = (e.blinkCd ?? 4) - dt) <= 0) {
      e.blinkCd = this.rng.range(5, 9);
      const a = this.rng.float() * Math.PI * 2;
      const nx = px + Math.cos(a) * 7, nz = pz + Math.sin(a) * 7;
      if (this.world.heightAt(nx, nz) > 0.5) {
        this.ctx.particles?.burst(_v.set(e.pos.x, e.pos.y + 1, e.pos.z), { count: 16, speed: 4, color: 0xb26cff, life: 0.5, size: 0.18, gravity: 0 });
        e.pos.x = nx; e.pos.z = nz;
        this.ctx.particles?.burst(_v.set(nx, e.pos.y + 1, nz), { count: 16, speed: 4, color: 0xb26cff, life: 0.5, size: 0.18, gravity: 0 });
        this.ctx.audio?.play('blink', { pos: e.pos });
      }
    }
  }

  rangedAttack(e) {
    const player = this.ctx.player;
    if (!player) return;
    const from = _v.set(e.pos.x, e.pos.y + e.def.height * 0.75 * e.creature.scaleVar, e.pos.z);
    const to = player.pos.clone().setY(player.pos.y + 1.1);
    // lead the target a little
    to.addScaledVector(player.vel, 0.25);
    this.ctx.combat?.spawnProjectile({
      from: from.clone(), to, speed: e.def.projSpeed, damage: e.def.damage * (1 + 0.1 * (e.lvl - 1)) * this.difficulty,
      color: e.def.boss ? 0xffa33a : 0x53ffc8, radius: e.def.boss ? 0.6 : 0.3, owner: e, splash: e.def.boss ? 4 : 1.6,
    });
    this.ctx.audio?.play('spit', { pos: e.pos });
  }

  los(e, px, py, pz) {
    // cheap terrain occlusion march
    const from = _v.set(e.pos.x, e.pos.y + e.def.height * 0.7 * e.creature.scaleVar, e.pos.z);
    const dx = px - from.x, dy = (py + 1.2) - from.y, dz = pz - from.z;
    const d = Math.hypot(dx, dy, dz);
    const steps = Math.min(28, Math.ceil(d / 9));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = from.x + dx * t, y = from.y + dy * t, z = from.z + dz * t;
      const h = this.world.heightAt(x, z);
      if (h > y + 0.6) return false;
    }
    return true;
  }

  /** spawn a wave around the player (used by nests / events) */
  spawnWave(count, type = null, radius = 60, origin = null) {
    const p = this.ctx.player;
    const cx = origin ? origin.x : p.pos.x, cz = origin ? origin.z : p.pos.z;
    const spawned = [];
    for (let i = 0; i < count; i++) {
      const a = this.rng.float() * Math.PI * 2;
      const r = radius * this.rng.range(0.7, 1.15);
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      if (this.world.heightAt(x, z) < 0.5) continue;
      const pop = { x, z, r: 20, kinds: [type || this.pickType(this.rng, 0.8)], alive: 1, spawn: 0, temp: true };
      this.pops.push(pop);
      const e = this.spawnOne(pop, x, z, type);
      if (e) {
        e.alert = 30;
        this.ctx.particles?.burst(_v.set(x, this.world.heightAt(x, z) + 0.6, z), { count: 22, speed: 5, color: 0x53ffc8, life: 0.8, size: 0.22 });
      }
      if (e) spawned.push(e);
    }
    return spawned;
  }

  stats() {
    return { active: this.active.length, killed: this.killCount, remaining: this.remaining, total: this.totalPop };
  }
}

function raySphere(origin, dir, center, radius) {
  const ox = origin.x - center.x, oy = origin.y - center.y, oz = origin.z - center.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t1 = -b - s;
  if (t1 > 0) return t1;
  const t2 = -b + s;
  return t2 > 0 ? t2 : null;
}
