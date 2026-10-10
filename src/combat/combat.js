// Hitscan / projectile / explosion resolution and all the impact FX that go with it.
import * as THREE from 'three';
import { Rng, clamp, lerp } from '../core/rng.js';
import { WORLD } from '../world/constants.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

export class Combat {
  constructor(ctx) {
    this.ctx = ctx; // { scene, world, structures, vegetation, enemies, player, particles, floating, audio, events }
    this.rng = new Rng(20261010);
    this.projectiles = [];
    this.group = new THREE.Group();
    this.group.name = 'projectiles';
    ctx.scene.add(this.group);
    this.geo = new THREE.SphereGeometry(1, 10, 8);
    this.hits = [];
    this.lastKillTime = -99;
    this.killStreak = 0;
  }

  // ------------------------------------------------------------- aiming
  /** point under the crosshair: enemy first, then the world */
  aimPoint(origin, dir, maxDist = 400) {
    const hitE = this.ctx.enemies?.raycast(origin, dir, maxDist);
    let best = maxDist, point = _v.copy(origin).addScaledVector(dir, maxDist), enemy = null, head = false;
    if (hitE) { best = hitE.distance; point.copy(hitE.point); enemy = hitE.enemy; head = hitE.head; }
    const wh = this.rayWorld(origin, dir, maxDist);
    if (wh && wh.distance < best) {
      return { point: wh.point, distance: wh.distance, normal: wh.normal, kind: wh.kind, enemy: null };
    }
    return { point: point.clone(), distance: best, enemy, head, normal: null, kind: enemy ? 'flesh' : 'ground' };
  }

  /** march the heightfield + structure OBBs */
  rayWorld(origin, dir, maxDist = 400) {
    const world = this.ctx.world;
    const stepBase = 1.2;
    let t = 0.4;
    let prevY = origin.y;
    while (t < maxDist) {
      const step = stepBase + t * 0.02;
      const x = origin.x + dir.x * t, y = origin.y + dir.y * t, z = origin.z + dir.z * t;
      const h = world.heightAt(x, z);
      if (y <= h) {
        // refine
        let lo = t - step, hi = t;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) * 0.5;
          const yy = origin.y + dir.y * mid;
          if (yy <= world.heightAt(origin.x + dir.x * mid, origin.z + dir.z * mid)) hi = mid; else lo = mid;
        }
        const hx = origin.x + dir.x * hi, hz = origin.z + dir.z * hi;
        const n = world.normalAt(hx, hz, _v2).clone();
        return { distance: hi, point: new THREE.Vector3(hx, world.heightAt(hx, hz), hz), normal: n, kind: h < 0.2 ? 'water' : 'ground' };
      }
      // structures
      const s = this.ctx.structures;
      if (s && s.rayBoxes) {
        const hit = s.rayBoxes(origin, dir, t, step);
        if (hit) return hit;
      }
      t += step;
    }
    return null;
  }

  // ------------------------------------------------------------- firing
  fire(weapon, shooter) {
    const { player } = this.ctx;
    const origin = shooter.muzzleWorld(new THREE.Vector3());
    // converge: aim from the muzzle at whatever the crosshair sees
    const aimAt = player ? player.aimPoint.clone() : null;
    const dir = _v3;
    if (aimAt) {
      dir.copy(aimAt).sub(origin);
      if (dir.lengthSq() < 0.25) dir.copy(shooter.lookDir ? shooter.lookDir(dir) : dir.set(0, 0, 1));
      dir.normalize();
    } else {
      dir.copy(shooter.lookDir ? shooter.lookDir(dir) : dir.set(0, 0, 1)).normalize();
    }

    const spread = weapon.fire(player.ads > 0.5);
    const pellets = weapon.def.pellets || 1;
    weapon.accuracy = weapon.accuracy || { shots: 0, hits: 0 };
    weapon.accuracy.shots++;
    let anyHit = false;

    for (let p = 0; p < pellets; p++) {
      const d = dir.clone();
      if (spread > 0) {
        const a = this.rng.float() * Math.PI * 2;
        const r = Math.sqrt(this.rng.float()) * spread * (p === 0 ? 0.35 : 1);
        const up = Math.abs(d.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
        const right = new THREE.Vector3().crossVectors(d, up).normalize();
        const realUp = new THREE.Vector3().crossVectors(right, d).normalize();
        d.addScaledVector(right, Math.cos(a) * r).addScaledVector(realUp, Math.sin(a) * r).normalize();
      }
      const res = this.aimPoint(origin, d, weapon.def.range);
      const endPoint = res.point;
      this.ctx.particles?.tracers.add(origin, endPoint, weapon.def.id === 'sniper' ? 0xbfe6ff : 0xffe3a8, 0.05 + Math.random() * 0.03, weapon.def.id === 'sniper' ? 1.4 : 0.8);
      if (res.enemy) {
        anyHit = true;
        const falloff = clamp(1 - res.distance / (weapon.def.range * 1.35), 0.35, 1);
        const dmg = weapon.damage * falloff * (1 + 0.02 * (shooter.skills?.damage || 0) * 5);
        this.ctx.enemies.damage(res.enemy, dmg, res.point, res.head, 'player');
        if (res.head) { player.headshots++; this.ctx.events?.emit('headshot', res.enemy); }
        this.ctx.audio?.play('hit_marker', { gain: 0.35 });
      } else if (res.point) {
        const n = res.normal || new THREE.Vector3(0, 1, 0);
        this.ctx.particles?.impact(res.point, n, res.kind === 'water' ? 'water' : this.surfaceKind(res.point));
        this.ctx.particles?.decals.add(res.point, n, weapon.def.id === 'sniper' ? 0.5 : 0.3);
        this.ctx.audio?.play('impact_' + (res.kind === 'water' ? 'water' : 'stone'), { pos: res.point, gain: 0.4 });
      }
    }
    if (anyHit) weapon.accuracy.hits++;
    this.ctx.events?.emit('weapon:fired', weapon);
  }

  surfaceKind(pos) {
    const w = this.ctx.world;
    const slope = w.slopeAt?.(pos.x, pos.z) ?? 0;
    if (w.scorchAt(pos.x, pos.z) > 0.4) return 'stone';
    if (slope > 0.6) return 'stone';
    return 'ground';
  }

  meleeSwing(shooter, range, damage) {
    const dir = shooter.lookDir(_v.clone());
    const origin = shooter.pos.clone().setY(shooter.pos.y + 1.2);
    // fan test
    let hits = 0;
    const list = this.ctx.enemies?.active || [];
    for (const e of list) {
      if (e.state === 'dead') continue;
      const to = _v2.set(e.pos.x - origin.x, 0, e.pos.z - origin.z);
      const d = to.length();
      if (d > range + e.radius) continue;
      to.normalize();
      const facing = to.x * dir.x + to.z * dir.z;
      if (facing < 0.45) continue;
      this.ctx.enemies.damage(e, damage, e.pos.clone().setY(e.pos.y + e.def.height * 0.5), false, 'melee');
      e.stagger = 0.55;
      e.vel.x += dir.x * 6; e.vel.z += dir.z * 6;
      hits++;
    }
    // smash props / spark on terrain
    const res = this.rayWorld(origin, dir, range + 1);
    if (res) this.ctx.particles?.impact(res.point, res.normal, this.surfaceKind(res.point));
    this.ctx.audio?.play(hits ? 'melee_hit' : 'melee_swing', { gain: 0.6 });
    if (hits) { shooter.shield = Math.min(shooter.maxShield, shooter.shield + hits * 8); }
    return hits;
  }

  // ------------------------------------------------------------- projectiles
  spawnProjectile(opts) {
    const {
      from, to, speed = 30, damage = 10, color = 0x53ffc8, radius = 0.3,
      owner = null, splash = 0, gravity = 0, bounce = false, life = 6, homing = 0,
    } = opts;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(this.geo, mat);
    mesh.scale.setScalar(radius);
    mesh.position.copy(from);
    this.group.add(mesh);
    const light = new THREE.PointLight(color, 6, 12, 2);
    mesh.add(light);
    const dir = to.clone().sub(from).normalize();
    const pr = {
      mesh, dir, speed, damage, radius, owner, splash, gravity, bounce, life,
      vel: dir.multiplyScalar(speed), pos: from.clone(), homing, target: homing ? to.clone() : null,
      t: 0,
    };
    this.projectiles.push(pr);
    return pr;
  }

  throwGrenade(player) {
    const origin = player.pos.clone().setY(player.pos.y + 1.4);
    const to = player.aimPoint.clone();
    const dist = clamp(origin.distanceTo(to), 8, 60);
    this.spawnProjectile({
      from: origin, to, speed: clamp(dist * 1.15, 16, 34), damage: 220, color: 0xffd06b,
      radius: 0.22, owner: player, splash: 7.5, gravity: 26, bounce: true, life: 6,
    });
  }

  updateProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.t += dt;
      p.life -= dt;
      if (p.gravity) p.vel.y -= p.gravity * dt;
      if (p.homing && p.target) {
        const want = _v.copy(p.target).sub(p.pos).normalize();
        p.vel.lerp(want.multiplyScalar(p.speed), clamp(dt * p.homing, 0, 1));
      }
      const step = _v.copy(p.vel).multiplyScalar(dt);
      const len = step.length();
      const next = _v2.copy(p.pos).add(step);
      // collide with world
      const h = this.ctx.world.heightAt(next.x, next.z);
      const hitWorld = next.y <= h + p.radius;
      // collide with enemies (unless owner is an enemy)
      let hitEnemy = null;
      if (p.owner !== this.ctx.enemies) {
        for (const e of this.ctx.enemies?.active || []) {
          if (e.state === 'dead' || e === p.owner) continue;
          const cy = e.pos.y + e.def.height * 0.5 * e.creature.scaleVar;
          if (Math.hypot(next.x - e.pos.x, next.y - cy, next.z - e.pos.z) < e.radius + p.radius + 0.3) { hitEnemy = e; break; }
        }
      }
      // collide with the player when fired by an enemy
      let hitPlayer = false;
      const pl = this.ctx.player;
      if (pl && !p.owner?.pos && p.owner !== pl) {
        const cy = pl.pos.y + 0.9;
        if (Math.hypot(next.x - pl.pos.x, next.y - cy, next.z - pl.pos.z) < 0.7 + p.radius) hitPlayer = true;
      }
      p.pos.copy(next);
      p.mesh.position.copy(p.pos);
      const trailT = (p.trailT = (p.trailT || 0) + dt);
      if (trailT > 0.03) {
        p.trailT = 0;
        this.ctx.particles?.spawn(p.pos.x, p.pos.y, p.pos.z, 0, 0, 0,
          { size: p.radius * 1.5, life: 0.35, color: p.mesh.material.color.getHex(), gravity: 0, drag: 3, alpha: 0.7 });
      }
      if (p.life <= 0 || hitWorld || hitEnemy || hitPlayer) {
        if (p.splash > 0) {
          this.explosion(p.pos.clone(), p.splash, p.damage, p.owner);
        } else {
          if (hitEnemy) this.ctx.enemies.damage(hitEnemy, p.damage, p.pos.clone(), false, 'projectile');
          if (hitPlayer) this.ctx.player.damage(p.damage, p.pos.clone(), 'projectile');
          this.ctx.particles?.burst(p.pos, { count: 12, speed: 4, color: p.mesh.material.color.getHex(), life: 0.5, size: p.radius });
        }
        this.group.remove(p.mesh);
        p.mesh.material.dispose();
        this.projectiles.splice(i, 1);
      }
    }
  }

  explosion(pos, radius, damage, owner = null) {
    this.ctx.particles?.explosion(pos, radius * 0.9, 0xffa040);
    this.ctx.audio?.play('explosion', { pos, gain: 1 });
    this.ctx.events?.emit('explosion', { pos, radius });
    // shake
    const pl = this.ctx.player;
    if (pl) {
      const d = pl.pos.distanceTo(pos);
      if (d < radius * 5) pl.camShake = Math.min(2.2, pl.camShake + clamp(1 - d / (radius * 5), 0, 1) * 1.5);
      if (d < radius * 0.9) pl.damage(damage * 0.35 * clamp(1 - d / (radius * 2), 0.2, 1), pos, 'blast');
    }
    const list = this.ctx.enemies?.inRadius(pos, radius, this.hits) || [];
    for (const { enemy, distance } of list) {
      const k = clamp(1 - distance / (radius * 1.5), 0.15, 1);
      this.ctx.enemies.damage(enemy, damage * k, enemy.pos.clone().setY(enemy.pos.y + enemy.def.height * 0.5), false, 'blast');
      const push = _v.copy(enemy.pos).sub(pos).setY(0.4).normalize().multiplyScalar(14 * k);
      enemy.vel.x += push.x; enemy.vel.z += push.z;
      enemy.stagger = Math.max(enemy.stagger, 0.4 * k);
    }
    // companions take a little blast damage too (they dodge most of it)
    if (this.ctx.squad) {
      for (const c of this.ctx.squad.members) {
        const d = c.pos.distanceTo(pos);
        if (d < radius) c.damage(damage * 0.25 * clamp(1 - d / radius, 0.15, 1), pos);
      }
    }
  }

  aetherPulse(pos, radius, damage) {
    this.ctx.particles?.explosion(pos.clone().setY(pos.y + 1), radius * 0.8, 0x7fe9ff);
    // expanding ring
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.6, 1.0, 48),
      new THREE.MeshBasicMaterial({ color: 0x9ff4ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(pos).setY(pos.y + 0.4);
    this.group.add(ring);
    const anim = { t: 0, mesh: ring, radius };
    (this.rings = this.rings || []).push(anim);
    const list = this.ctx.enemies?.inRadius(pos, radius, this.hits) || [];
    for (const { enemy, distance } of list) {
      const k = clamp(1 - distance / radius, 0.2, 1);
      this.ctx.enemies.damage(enemy, damage * k, enemy.pos.clone().setY(enemy.pos.y + 1), false, 'pulse');
      const push = _v.copy(enemy.pos).sub(pos).setY(0.5).normalize().multiplyScalar(26 * k);
      enemy.vel.x += push.x; enemy.vel.z += push.z;
      enemy.stagger = Math.max(enemy.stagger, 1.1 * k);
      enemy.slow = Math.max(enemy.slow, 2.5 * k);
    }
  }

  update(dt) {
    this.updateProjectiles(dt);
    if (this.rings && this.rings.length) {
      for (let i = this.rings.length - 1; i >= 0; i--) {
        const r = this.rings[i];
        r.t += dt * 1.6;
        const s = 1 + r.t * r.radius;
        r.mesh.scale.setScalar(s);
        r.mesh.material.opacity = Math.max(0, 0.9 - r.t);
        if (r.t >= 1) {
          this.group.remove(r.mesh);
          r.mesh.geometry.dispose();
          r.mesh.material.dispose();
          this.rings.splice(i, 1);
        }
      }
    }
  }
}
