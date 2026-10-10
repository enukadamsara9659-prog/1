// Player: third-person character controller, camera rig and combat state.
import * as THREE from 'three';
import { Character } from './character.js';
import { Weapon, WEAPONS } from '../combat/weapons.js';
import { Rng, clamp, lerp, damp } from '../core/rng.js';
import { WORLD } from '../world/constants.js';
import settings from '../core/settings.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _muzzleZero = new THREE.Vector3();
const _muzzleUp = new THREE.Vector3(0, 1.35, 0);
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

export class Player {
  constructor(ctx) {
    this.ctx = ctx; // { scene, camera, world, terrain, structures, vegetation, input, events, particles, audio, combat }
    this.group = new THREE.Group();
    this.group.name = 'player';
    ctx.scene.add(this.group);

    this.pos = new THREE.Vector3(ctx.world.start.x, ctx.world.start.y, ctx.world.start.z);
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.radius = 0.42;
    this.height = 1.8;
    this.eye = 1.62;
    this.grounded = true;
    this.slope = 0;
    this.swimming = false;
    this.crouch = 0;
    this.slideTime = 0;
    this.dodgeTime = -1;
    this.dodgeDir = new THREE.Vector3();
    this.vaultTime = -1;
    this.look = new THREE.Vector3(0, 0, 1);
    this.aimPoint = new THREE.Vector3();

    // ---- vitals
    this.maxHealth = 100;
    this.health = 100;
    this.maxShield = 60;
    this.shield = 60;
    this.shieldDelay = 0;
    this.maxStamina = 100;
    this.stamina = 100;
    this.staminaDelay = 0;
    this.invuln = 0;
    this.dead = false;
    this.downed = false;
    this.reviveProgress = 0;

    // ---- progression
    this.level = 1;
    this.xp = 0;
    this.xpNext = 250;
    this.skillPoints = 0;
    this.skills = {};
    this.shards = 0;
    this.aether = 0;
    this.kills = 0;
    this.headshots = 0;
    this.accuracyShots = 0;
    this.accuracyHits = 0;

    // ---- weapons
    this.weapons = ['rifle', 'shotgun', 'pistol', 'blade'].map((id) => new Weapon(id, { owner: this }));
    this.weaponIndex = 0;
    this.equip(0);
    this.ads = 0;
    this.wantAds = false;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.bobPhase = 0;

    // ---- abilities
    this.cooldowns = { pulse: 0, grenade: 0, stim: 0, ult: 0 };
    this.grenades = 3;

    // ---- character
    this.char = new Character({ model: 'soldier', height: 1.82, name: 'player' });
    this.group.add(this.char.group);
    this.char.group.position.set(0, 0, 0);
    this.bindWeaponToHand();

    // ---- camera
    this.camMode = 'third'; // 'third' | 'first'
    this.camDist = 4.4;
    this.camTarget = new THREE.Vector3();
    this.camPos = new THREE.Vector3().copy(this.pos);
    this.camShake = 0;
    this.camShakeVec = new THREE.Vector3();
    this.fovBase = settings.get('fov', 72);
    this.fov = this.fovBase;
    this.thirdPerson = true;
    this.cameraEnabled = true;

    this.stats = { move: 0 };
    this.rng = new Rng(4242);
    this.stepDist = 0;
  }

  get weapon() { return this.weapons[this.weaponIndex]; }

  equip(i) {
    if (i === this.weaponIndex && this.equipped) return;
    this.weaponIndex = ((i % this.weapons.length) + this.weapons.length) % this.weapons.length;
    this.equipped = true;
    this.swapTime = 0.45;
    if (this.ctx.events) this.ctx.events.emit('weapon:changed', this.weapon);
  }

  bindWeaponToHand() {
    for (const w of this.weapons) {
      if (!w.world) continue;
      w.world.visible = false;
      // gun models point their muzzle down -Z; the hand bone's +Y runs along the arm
      this.char.attachToHand(w.world, 'handR', new THREE.Vector3(0.0, -0.03, 0.02), new THREE.Vector3(Math.PI / 2, 0, Math.PI * 0.03));
    }
    this.showCurrentWeapon();
  }

  showCurrentWeapon() {
    for (const w of this.weapons) if (w.world) w.world.visible = false;
    const w = this.weapon;
    if (w && w.world) w.world.visible = true;
  }

  // ------------------------------------------------------------- vitals
  damage(amount, from, kind = 'hit') {
    if (this.dead || this.invuln > 0) return 0;
    let left = amount;
    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, left * 0.75);
      this.shield -= absorbed;
      left -= absorbed;
      this.ctx.events?.emit('shield:hit', absorbed);
    }
    this.health -= left;
    this.shieldDelay = 4.5;
    this.invuln = 0.12;
    this.camShake = Math.min(1.2, this.camShake + amount * 0.006);
    this.char.hitReact(from ? _v.copy(this.pos).sub(from).normalize() : null);
    this.ctx.events?.emit('player:damaged', { amount, from, kind });
    if (this.health <= 0) {
      this.health = 0;
      this.die();
    }
    return amount;
  }

  heal(amount) {
    this.health = Math.min(this.maxHealth, this.health + amount);
    this.ctx.events?.emit('player:healed', amount);
  }

  die() {
    if (this.downed) { this.dead = true; this.char.die(); this.ctx.events?.emit('player:dead'); return; }
    this.downed = true;
    this.downTimer = 22;
    this.char.die();
    this.ctx.events?.emit('player:downed');
  }

  revive() {
    this.downed = false;
    this.dead = false;
    this.health = this.maxHealth * 0.55;
    this.shield = this.maxShield * 0.4;
    this.char.revive();
    this.ctx.events?.emit('player:revived');
  }

  addXp(amount) {
    this.xp += amount;
    let ups = 0;
    while (this.xp >= this.xpNext) {
      this.xp -= this.xpNext;
      this.level++;
      this.xpNext = Math.round(this.xpNext * 1.35 + 60);
      this.skillPoints += 1;
      this.maxHealth += 6;
      this.health = this.maxHealth;
      ups++;
      this.ctx.events?.emit('player:levelup', this.level);
    }
    return ups;
  }

  // ------------------------------------------------------------- update
  update(dt, input) {
    const { world, structures, vegetation } = this.ctx;
    this.cooldowns.pulse = Math.max(0, this.cooldowns.pulse - dt);
    this.cooldowns.grenade = Math.max(0, this.cooldowns.grenade - dt);
    this.cooldowns.stim = Math.max(0, this.cooldowns.stim - dt);
    this.invuln = Math.max(0, this.invuln - dt);
    this.swapTime = Math.max(0, (this.swapTime || 0) - dt);

    if (this.dead) { this.updateCamera(dt); return; }

    // downed: crawl slowly, teammates can revive
    if (this.downed) {
      this.downTimer -= dt;
      this.reviveProgress = Math.max(0, this.reviveProgress - dt * 0.25);
      if (this.downTimer <= 0) { this.dead = true; this.ctx.events?.emit('player:dead'); }
    }

    // ---- look
    const sens = settings.get('sensitivity', 1) * 0.0022;
    const adsK = lerp(1, 0.55, this.ads);
    this.yaw -= input.mouseDX * sens * adsK;
    this.pitch = clamp(this.pitch - input.mouseDY * sens * adsK, -1.45, 1.45);
    this.recoilPitch = damp(this.recoilPitch, 0, 3.2, dt);
    this.recoilYaw = damp(this.recoilYaw, 0, 3.2, dt);
    this.look.set(
      Math.sin(this.yaw + this.recoilYaw) * Math.cos(this.pitch + this.recoilPitch),
      Math.sin(this.pitch + this.recoilPitch),
      Math.cos(this.yaw + this.recoilYaw) * Math.cos(this.pitch + this.recoilPitch)
    ).normalize();

    // ---- desired move (camera relative)
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
    const wish = new THREE.Vector3();
    if (!this.downed) {
      wish.addScaledVector(fwd, (input.codeDown('KeyW') ? 1 : 0) - (input.codeDown('KeyS') ? 1 : 0));
      wish.addScaledVector(right, (input.codeDown('KeyD') ? 1 : 0) - (input.codeDown('KeyA') ? 1 : 0));
      if (wish.lengthSq() > 0) wish.normalize();
    }

    // ---- states
    const wantSprint = input.codeDown('ShiftLeft') && wish.lengthSq() > 0 && !this.downed;
    const wantCrouch = input.codeDown('ControlLeft') || input.codeDown('KeyC');
    const staminaOk = this.stamina > 3;
    let maxSpeed = 2.1; // walk
    let accel = 22;
    if (this.downed) { maxSpeed = 0.7; accel = 8; }
    else if (this.dodgeTime >= 0) { maxSpeed = 11.5; accel = 60; }
    else if (this.slideTime > 0) { maxSpeed = 9.5; accel = 4; }
    else if (wantCrouch) { maxSpeed = 1.4; accel = 16; }
    else if (wantSprint && staminaOk && !this.ads) { maxSpeed = 6.6; accel = 26; }
    else if (wish.lengthSq() > 0) { maxSpeed = 3.6; accel = 20; }
    if (this.ads > 0.4) maxSpeed *= 0.55;
    if (this.weapon) maxSpeed *= this.weapon.def.movePenalty;
    if (this.swimming) maxSpeed *= 0.62;
    maxSpeed *= 1 + 0.04 * (this.skills.speed || 0);

    if (wantSprint && this.speed > 3 && !this.ads && !this.swimming && !this.downed) {
      this.stamina = Math.max(0, this.stamina - dt * 16);
      this.staminaDelay = 1.4;
    } else {
      this.staminaDelay = Math.max(0, this.staminaDelay - dt);
      if (this.staminaDelay <= 0) this.stamina = Math.min(this.maxStamina, this.stamina + dt * 22);
    }

    // dodge roll
    if (input.codePressed('Space') && this.grounded && this.dodgeTime < 0 && !this.downed) {
      if (input.codeDown('KeyA') || input.codeDown('KeyD') || input.codeDown('KeyS')) {
        this.dodgeTime = 0;
        this.dodgeDir.copy(wish.lengthSq() > 0 ? wish : fwd.clone().negate());
        this.stamina = Math.max(0, this.stamina - 22);
        this.ctx.audio?.play('dodge');
        this.ctx.events?.emit('player:dodge');
      } else if (this.canVault()) {
        this.vaultTime = 0;
        this.vel.y = 8.6;
        this.ctx.audio?.play('jump');
      } else if (this.grounded) {
        this.vel.y = 8.2;
        this.grounded = false;
        this.ctx.audio?.play('jump');
      }
    }

    // ---- horizontal velocity
    const target = _v.copy(wish).multiplyScalar(maxSpeed);
    const cur = _v2.set(this.vel.x, 0, this.vel.z);
    const diff = target.clone().sub(cur);
    const control = this.grounded ? 1 : 0.22;
    cur.addScaledVector(diff, clamp(accel * dt * control, 0, 1));
    if (wish.lengthSq() === 0 && this.grounded) {
      const f = Math.max(0, 1 - dt * (this.slideTime > 0 ? 1.6 : 11));
      cur.multiplyScalar(f);
    }
    this.vel.x = cur.x; this.vel.z = cur.z;

    // ---- vertical
    const gy = world.heightAt(this.pos.x, this.pos.z);
    this.swimming = gy < -1.3 && this.pos.y < -0.2;
    if (this.swimming) {
      this.vel.y += (-2.4 - this.vel.y) * dt * 3.2;
      if (input.codeDown('Space')) this.vel.y += dt * 14;
      this.vel.y = clamp(this.vel.y, -3.4, 3.6);
    } else {
      this.vel.y -= 26 * dt;
      this.vel.y = Math.max(this.vel.y, -58);
    }

    // ---- integrate
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.pos.y += this.vel.y * dt;

    // ---- collide horizontally (structures + trees)
    const push = _v.set(0, 0, 0);
    if (structures) structures.resolveCollisions(this.pos.x, this.pos.z, this.radius, push);
    if (vegetation) vegetation.trunkPush(this.pos.x, this.pos.z, this.radius, push);
    if (push.lengthSq() > 0) {
      this.pos.x += push.x;
      this.pos.z += push.z;
      // kill velocity into the wall
      const l = push.length();
      if (l > 0.0001) {
        const n = push.clone().divideScalar(l);
        const dot = this.vel.x * n.x + this.vel.z * n.z;
        if (dot < 0) { this.vel.x -= n.x * dot; this.vel.z -= n.z * dot; }
      }
    }

    // ---- ground
    const gy2 = world.heightAt(this.pos.x, this.pos.z);
    this.slope = world.slopeAt?.(this.pos.x, this.pos.z) ?? 0;
    const footTarget = Math.max(gy2, this.structureFloor(this.pos.x, this.pos.z, this.pos.y));
    if (this.swimming) {
      this.grounded = false;
      if (this.pos.y > -0.35) this.pos.y = -0.35;
    } else if (this.pos.y <= footTarget + 0.02) {
      if (!this.grounded && this.vel.y < -14) {
        const impact = clamp((-this.vel.y - 14) / 34, 0, 1);
        if (impact > 0.15) {
          this.ctx.particles?.dust(this.pos, 1.2 + impact);
          this.camShake += impact * 0.9;
          this.ctx.audio?.play('land', { gain: 0.3 + impact * 0.7 });
          if (impact > 0.75) this.damage(impact * 45, null, 'fall');
        }
      }
      this.pos.y = footTarget;
      this.vel.y = 0;
      this.grounded = true;
      this.coyote = 0.12;
    } else {
      this.grounded = false;
      this.coyote = Math.max(0, (this.coyote || 0) - dt);
    }
    // slope limit
    if (this.grounded && !this.swimming) {
      const n = world.normalAt(this.pos.x, this.pos.z, _v2);
      if (n.y < 0.55) {
        this.pos.x += n.x * dt * 6;
        this.pos.z += n.z * dt * 6;
      }
    }

    // ---- timers
    if (this.dodgeTime >= 0) { this.dodgeTime += dt; if (this.dodgeTime > 0.42) this.dodgeTime = -1; }
    if (this.slideTime > 0) this.slideTime -= dt;
    if (wantCrouch && this.speed > 4 && this.grounded && this.slideTime <= 0) { this.slideTime = 0.9; this.ctx.audio?.play('slide'); }
    this.crouch = damp(this.crouch, wantCrouch ? 1 : 0, 12, dt);

    // ---- shields regen
    this.shieldDelay = Math.max(0, this.shieldDelay - dt);
    if (this.shieldDelay <= 0 && this.shield < this.maxShield) {
      this.shield = Math.min(this.maxShield, this.shield + dt * (14 + 6 * (this.skills.shield || 0)));
      if (this.shield > 0.5 && this._shieldWasDown) this.ctx.events?.emit('shield:up');
    }
    this._shieldWasDown = this.shield <= 0.5;

    this.speed = Math.hypot(this.vel.x, this.vel.z);

    // ---- footsteps
    this.stepDist += this.speed * dt;
    const stride = this.speed > 4 ? 2.3 : 2.0;
    if (this.grounded && this.stepDist > stride) {
      this.stepDist = 0;
      const deep = this.swimming || gy2 < 0.2;
      this.ctx.audio?.play(deep ? 'step_water' : this.slope > 0.5 ? 'step_rock' : 'step_grass', { gain: clamp(0.2 + this.speed * 0.06, 0.15, 0.6) });
      if (this.speed > 5) this.ctx.particles?.dust(this.pos, 0.5);
    }

    // ---- weapons / actions
    this.updateActions(dt, input);
    this.updateWeapon(dt, input);

    // ---- character visual
    this.group.position.copy(this.pos);
    this.char.group.rotation.y = this.yaw - this.char.yawOffset;
    const aimDir = this.lookDir();
    this.char.aimWeight = damp(this.char.aimWeight, this.weapon && this.weapon.def.kind !== 'melee' ? 0.85 : 0.2, 10, dt);
    this.char.update(dt, aimDir);
    this.char.setSpeed(this.speed);

    this.updateCamera(dt);
  }

  structureFloor(x, z, y) {
    const s = this.ctx.structures;
    if (!s) return -Infinity;
    return s.floorAt ? s.floorAt(x, z, y) : -Infinity;
  }

  canVault() {
    const { world } = this.ctx;
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const h0 = world.heightAt(this.pos.x, this.pos.z);
    const h1 = world.heightAt(this.pos.x + fwd.x * 1.6, this.pos.z + fwd.z * 1.6);
    return h1 > h0 + 0.9 && h1 < h0 + 2.6;
  }

  lookDir(out = new THREE.Vector3()) {
    // when aiming, converge on the point under the crosshair
    return out.copy(this.aimPoint).sub(this.muzzleWorld(_v2)).normalize();
  }

  muzzleWorld(out = new THREE.Vector3()) {
    const w = this.weapon;
    if (w && w.world && w.world.visible && w.world.parent) {
      w.world.updateWorldMatrix(true, false);
      return out.copy(w.worldMuzzle || _muzzleZero).applyMatrix4(w.world.matrixWorld);
    }
    return out.copy(this.pos).add(_muzzleUp);
  }

  updateActions(dt, input) {
    // weapon switching
    for (let i = 0; i < 4; i++) if (input.codePressed('Digit' + (i + 1))) { this.equip(i); this.showCurrentWeapon(); }
    if (input.wheel) {
      this.equip(this.weaponIndex + (input.wheel > 0 ? 1 : -1));
      this.showCurrentWeapon();
    }
    if (input.codePressed('KeyR')) { if (this.weapon.startReload()) this.ctx.audio?.play('reload'); }
    if (input.codePressed('KeyV')) this.toggleCamera();
    if (input.codePressed('KeyF')) this.melee();
    if (input.codePressed('KeyQ')) this.ability('pulse');
    if (input.codePressed('KeyG')) this.ability('grenade');
    if (input.codePressed('KeyH')) this.ability('stim');
    if (input.codePressed('KeyE')) this.ctx.events?.emit('player:interact');
  }

  toggleCamera() {
    this.camMode = this.camMode === 'third' ? 'first' : 'third';
    this.thirdPerson = this.camMode === 'third';
    this.char.model.visible = this.thirdPerson;
    const w = this.weapon;
    if (w) {
      if (this.thirdPerson) { w.detach(this.ctx.camera); if (w.world) w.world.visible = true; }
      else { w.attach(this.ctx.camera); if (w.world) w.world.visible = false; }
    }
    this.ctx.events?.emit('camera:mode', this.camMode);
  }

  updateWeapon(dt, input) {
    const w = this.weapon;
    if (!w) return;
    this.wantAds = input.codeDown('Mouse2') && !this.downed && w.def.kind !== 'melee';
    this.ads = damp(this.ads, this.wantAds ? 1 : 0, 14, dt);

    if (this.downed) return;
    const held = input.codeDown('Mouse0');
    if (w.canFire(held) && this.swapTime <= 0) {
      if (w.def.kind === 'melee') { this.melee(); }
      else {
        this.ctx.combat?.fire(w, this);
        this.recoilPitch += w.def.recoil * 0.012;
        this.recoilYaw += (this.rng.float() - 0.5) * w.def.recoil * 0.01;
        this.camShake = Math.min(1.4, this.camShake + w.def.recoil * 0.05);
        this.char.fireRecoil(w.def.recoil);
        const mz = this.muzzleWorld(_v);
        this.ctx.particles?.muzzleSmoke(mz, this.lookDir(_v2));
        this.ctx.particles?.shell(_v.copy(this.pos).add(new THREE.Vector3(0, 1.3, 0)), _v2.set(-Math.sin(this.yaw), 0.2, -Math.cos(this.yaw)));
        this.ctx.audio?.play('shot_' + (w.def.kind === 'shotgun' ? 'shotgun' : w.def.kind === 'sniper' ? 'sniper' : 'rifle'), { gain: 0.55, rate: this.rng.range(0.94, 1.06) });
      }
    }
    if (w.empty && w.reloading <= 0) w.startReload();
    w.update(dt, {
      camera: this.ctx.camera, ads: this.ads > 0.5, speed: this.speed,
      time: this.ctx.elapsed || 0, pitch: this.pitch, lookX: input.mouseDX * 0.01,
    });
  }

  melee() {
    if (this.meleeCd > 0) return;
    this.meleeCd = 0.62;
    this.char.melee();
    this.ctx.events?.emit('melee:start');
    setTimeout(() => {
      if (!this.dead) this.ctx.combat?.meleeSwing(this, 3.6, 120 * (1 + 0.06 * (this.skills.melee || 0)));
    }, 160);
  }

  ability(kind) {
    if (this.cooldowns[kind] > 0 || this.downed) return;
    if (kind === 'pulse') {
      this.cooldowns.pulse = 14 - 2 * (this.skills.pulse || 0);
      this.ctx.combat?.aetherPulse(this.pos, 13 + 2 * (this.skills.pulse || 0), 45 + 15 * (this.skills.pulse || 0));
      this.ctx.audio?.play('pulse');
    } else if (kind === 'grenade') {
      if (this.grenades <= 0) { this.cooldowns.grenade = 0.4; return; }
      this.grenades--;
      this.cooldowns.grenade = 6;
      this.ctx.combat?.throwGrenade(this);
      this.ctx.audio?.play('throw');
    } else if (kind === 'stim') {
      this.cooldowns.stim = 26;
      this.heal(this.maxHealth * 0.45);
      this.stamina = this.maxStamina;
      this.speedBoost = 6;
      this.ctx.particles?.heal(this.pos);
      this.ctx.audio?.play('stim');
    }
    this.ctx.events?.emit('ability:used', kind);
  }

  // ------------------------------------------------------------- camera
  updateCamera(dt) {
    if (!this.cameraEnabled) return;
    const cam = this.ctx.camera;
    const headY = this.pos.y + this.eye - this.crouch * 0.42;
    this.aimPoint.copy(this.pos).addScaledVector(this.look, 220);

    // raycast forward to find the true aim point
    const hit = this.ctx.aimRay?.(this.pos.clone().setY(headY), this.look);
    if (hit) this.aimPoint.copy(hit.point);

    let desired;
    if (this.thirdPerson) {
      const dist = this.camDist * lerp(1, 0.45, this.ads) + this.crouch * 0.3;
      const shoulder = lerp(0.75, 0.42, this.ads);
      const back = _v.copy(this.look).setY(0).normalize().multiplyScalar(-dist);
      desired = _v2.copy(this.pos).add(back);
      desired.y = headY + 0.35 - this.crouch * 0.3;
      desired.x += Math.cos(this.yaw) * shoulder;
      desired.z += -Math.sin(this.yaw) * shoulder;
      // avoid clipping into terrain / walls
      const dir = desired.clone().sub(_v2.copy(this.pos).setY(headY));
      const len = dir.length();
      dir.divideScalar(len);
      const maxLen = this.camClip(_v2.copy(this.pos).setY(headY), dir, len);
      if (maxLen < len) desired.copy(_v2.copy(this.pos).setY(headY)).addScaledVector(dir, maxLen);
    } else {
      desired = _v2.set(this.pos.x, headY, this.pos.z);
    }

    // shake
    if (this.camShake > 0.001) {
      this.camShake = Math.max(0, this.camShake - dt * 2.6);
      const k = this.camShake * this.camShake * 0.28;
      this.camShakeVec.set((Math.random() - 0.5) * k, (Math.random() - 0.5) * k, (Math.random() - 0.5) * k);
    } else this.camShakeVec.multiplyScalar(0.8);

    const smooth = this.thirdPerson ? 1 - Math.pow(0.0025, dt) : 1;
    this.camPos.lerp(desired, smooth);
    cam.position.copy(this.camPos).add(this.camShakeVec);
    this.camTarget.lerp(_v2.copy(this.pos).setY(headY - 0.1).addScaledVector(this.look, 12), 1 - Math.pow(0.0005, dt));
    cam.lookAt(this.camTarget);
    if (this.camShakeVec.lengthSq() > 0) cam.rotateZ(this.camShakeVec.x * 0.6);

    // fov
    const targetFov = this.fovBase * lerp(1, 1 / Math.max(1, this.weapon?.def.zoom || 1), this.ads) + (this.speed > 5 ? 4 : 0) + (this.dodgeTime >= 0 ? 6 : 0);
    this.fov = damp(this.fov, targetFov, 8, dt);
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
  }

  camClip(origin, dir, len) {
    const { world } = this.ctx;
    const steps = 6;
    let last = 0.35;
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * len;
      const px = origin.x + dir.x * t, py = origin.y + dir.y * t, pz = origin.z + dir.z * t;
      const gy = world.heightAt(px, pz);
      if (py < gy + 0.45) return Math.max(0.5, t - 0.35);
      last = t;
    }
    return len;
  }
}
