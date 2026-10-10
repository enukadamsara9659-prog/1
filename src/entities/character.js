// Humanoid characters: skeletal animation + procedural aim / hit / death posing.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import assets, { prepSkins } from '../core/assets.js';
import { Rng, clamp, lerp } from '../core/rng.js';

const ALIAS = {
  idle: ['Idle', 'idle', 'Standing', 'stand'],
  walk: ['Walk', 'walk', 'Walking'],
  run: ['Run', 'run', 'Running', 'sprint'],
  death: ['Death', 'death', 'die'],
  punch: ['Punch', 'punch', 'attack'],
  jump: ['Jump', 'jump'],
  wave: ['Wave', 'wave'],
  dance: ['Dance', 'dance'],
};

const BONE_MAP = [
  [/hips/i, 'hips'],
  [/spine$/i, 'spine'],
  [/spine1/i, 'spine1'],
  [/spine2|chest/i, 'chest'],
  [/neck/i, 'neck'],
  [/head$/i, 'head'],
  [/shoulder.*r|RightShoulder/i, 'shoulderR'],
  [/arm.*r$|RightArm$|RightArm/i, 'armR'],
  [/forearm.*r|RightForeArm/i, 'foreArmR'],
  [/hand.*r$|RightHand/i, 'handR'],
  [/shoulder.*l|LeftShoulder/i, 'shoulderL'],
  [/arm.*l$|LeftArm$/i, 'armL'],
  [/forearm.*l|LeftForeArm/i, 'foreArmL'],
  [/hand.*l$|LeftHand/i, 'handL'],
  [/upleg.*r|RightUpLeg/i, 'legR'],
  [/upleg.*l|LeftUpLeg/i, 'legL'],
];

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

export class Character {
  constructor(opts = {}) {
    this.opts = opts;
    this.group = new THREE.Group();
    this.group.name = opts.name || 'character';
    this.height = opts.height ?? 1.8;
    this.tint = opts.tint ?? null;
    this.dead = false;
    this.ragdoll = 0;
    this.speed = 0;
    this.aimWeight = 0;
    this.aimPitch = 0;
    this.recoil = 0;
    this.hitTime = 0;
    this.meleeTime = -1;
    this.lookTarget = new THREE.Vector3();
    this.tmpObj = new THREE.Object3D();

    const modelName = opts.model || 'soldier';
    this.bones = {};      // always defined, so attachToHand() is safe even without a model
    this.skinned = [];
    const src = assets.gltf('characters', modelName);
    if (!src) { console.warn('missing character', modelName); return; }
    this.model = SkeletonUtils.clone(src.scene);
    this.model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = true;
      }
    });
    prepSkins(this.model);

    // ---- auto scale to the requested height
    const box = new THREE.Box3().setFromObject(this.model);
    const h = Math.max(0.2, box.max.y - box.min.y);
    const s = this.height / h;
    this.model.scale.multiplyScalar(s);
    this.group.add(this.model);

    // ---- bones
    this.bones = {};
    this.model.traverse((o) => {
      if (!o.isBone) return;
      for (const [re, key] of BONE_MAP) {
        if (!this.bones[key] && re.test(o.name)) this.bones[key] = o;
      }
      o.userData.rest = o.quaternion.clone();
    });
    this.skinned = [];
    this.model.traverse((o) => { if (o.isSkinnedMesh) this.skinned.push(o); });

    // ---- determine the model's forward axis from the bind pose
    this.model.updateMatrixWorld(true);
    const lh = this.bones.handL, rh = this.bones.handR;
    if (lh && rh && this.bones.hips) {
      const l = lh.getWorldPosition(new THREE.Vector3());
      const r = rh.getWorldPosition(new THREE.Vector3());
      const right = r.sub(l).normalize();
      right.y = 0; right.normalize();
      this.bindRight = right;
      this.bindForward = new THREE.Vector3().crossVectors(UP, right).normalize();
      this.yawOffset = Math.atan2(this.bindForward.x, this.bindForward.z);
    } else {
      this.bindRight = new THREE.Vector3(1, 0, 0);
      this.bindForward = new THREE.Vector3(0, 0, 1);
      this.yawOffset = 0;
    }

    // ---- animation clips (retarget from the soldier rig when needed)
    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = {};
    this.clips = {};
    const clips = src.animations || [];
    const pick = (names) => clips.find((c) => names.some((n) => c.name === n));
    for (const [key, names] of Object.entries(ALIAS)) {
      const clip = pick(names);
      if (clip) this.clips[key] = clip;
    }
    // retarget missing locomotion from the soldier rig
    if (!this.clips.idle || !this.clips.walk || !this.clips.run) {
      const donor = assets.gltf('characters', 'soldier');
      let donorSk = null;
      if (donor && donor !== src) {
        for (const key of ['idle', 'walk', 'run']) {
          if (this.clips[key]) continue;
          const dclip = donor.animations.find((c) => ALIAS[key].includes(c.name));
          if (!dclip) continue;
          try {
            const target = this.skinned[0];
            if (!target || !target.skeleton) throw new Error('target has no skeleton');
            if (!donorSk) {
              donor.scene.traverse((o) => { if (o.isSkinnedMesh && !donorSk) donorSk = o; });
            }
            const retargeted = SkeletonUtils.retargetClip(target, donorSk, dclip, {
              useFirstFramePosition: false, fps: 30, hip: 'mixamorig:Hips',
            });
            // tracks come back as ".bones[name].quaternion"; re-point them at the
            // bone nodes so a single mixer rooted on the model can drive them
            for (const track of retargeted.tracks) {
              const m = /^\.bones\[(.+?)\]\.(.+)$/.exec(track.name);
              if (m) track.name = `${m[1]}.${m[2]}`;
            }
            retargeted.resetDuration();
            this.clips[key] = retargeted;
          } catch (e) { console.warn('retarget failed', key, e.message); }
        }
      }
    }
    for (const [key, clip] of Object.entries(this.clips)) {
      const a = this.mixer.clipAction(clip);
      a.enabled = true;
      a.setEffectiveWeight(0);
      a.play();
      this.actions[key] = a;
    }
    if (this.actions.idle) this.actions.idle.setEffectiveWeight(1);
    this.current = 'idle';

    // ---- tint variants so the squad members look distinct
    if (this.tint) this.applyTint(this.tint);
  }

  applyTint(color) {
    this.model.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const isArr = Array.isArray(o.material);
      const src = isArr ? o.material : [o.material];
      const mats = src.map((m) => {
        const c = m.clone();
        if (c.map) c.color = new THREE.Color(color);
        c.needsUpdate = true;
        return c;
      });
      o.material = isArr ? mats : mats[0];
    });
  }

  /** pose a bone so that its "along bone" axis points along worldDir */
  poseBone(key, worldDir, weight, roll = 0) {
    const bone = this.bones[key];
    if (!bone || !bone.userData.rest) return;
    const parent = bone.parent;
    if (!parent) return;
    parent.updateWorldMatrix(true, false);
    _q1.copy(parent.getWorldQuaternion(new THREE.Quaternion()).invert());
    _v1.copy(worldDir).applyQuaternion(_q1).normalize();
    _v2.set(0, 1, 0).applyQuaternion(bone.userData.rest).normalize();
    const delta = new THREE.Quaternion().setFromUnitVectors(_v2, _v1);
    if (roll) delta.multiply(new THREE.Quaternion().setFromAxisAngle(UP, roll));
    _q2.copy(bone.userData.rest).premultiply(delta);
    bone.quaternion.slerp(_q2, clamp(weight, 0, 1));
  }

  setSpeed(speed) {
    this.speed = speed;
    const target = speed > 3.2 ? 'run' : speed > 0.25 ? 'walk' : 'idle';
    if (target !== this.current) {
      const from = this.actions[this.current], to = this.actions[target];
      const fade = target === 'idle' ? 0.28 : 0.18;
      if (to) {
        to.enabled = true;
        to.setEffectiveWeight(1);
        to.time = 0;
        if (from) from.crossFadeTo(to, fade, false);
      }
      this.current = target;
    }
    // match foot speed
    const a = this.actions[this.current];
    if (a) {
      if (this.current === 'walk') a.timeScale = clamp(speed / 1.45, 0.6, 2.2);
      else if (this.current === 'run') a.timeScale = clamp(speed / 5.2, 0.6, 1.8);
      else a.timeScale = 1;
    }
  }

  playOnce(key, fade = 0.1) {
    const a = this.actions[key];
    if (!a) return;
    a.reset();
    a.setEffectiveWeight(1);
    a.fadeIn(fade);
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.play();
    this.oneShot = key;
  }

  attachToHand(obj, bone = 'handR', offset = null, rot = null) {
    const b = this.bones && this.bones[bone];
    if (!b) { this.group.add(obj); return; }
    b.add(obj);
    obj.position.copy(offset || new THREE.Vector3(0, -0.02, 0.02));
    obj.rotation.set(rot ? rot.x : -Math.PI / 2, rot ? rot.y : 0, rot ? rot.z : 0);
    // rigs export their armature at 0.01 (centimetres) or 100; cancel that out
    // so the prop keeps its authored metric size once it is in world space
    b.updateWorldMatrix(true, false);
    const bs = Math.abs(_v2.setFromMatrixScale(b.matrixWorld).x) || 1;
    const inv = 1 / bs;
    obj.scale.setScalar(inv);
    obj.position.multiplyScalar(inv);   // offsets are authored in metres
  }

  fireRecoil(amount = 1) { this.recoil = Math.min(1.4, this.recoil + amount); }
  melee() { this.meleeTime = 0; }
  hitReact(dir) { this.hitTime = 0.35; if (dir) this.hitDir = dir.clone(); }

  die() {
    if (this.dead) return;
    this.dead = true;
    this.deathTime = 0;
    const a = this.actions.death;
    if (a) this.playOnce('death', 0.12);
  }

  revive() {
    this.dead = false;
    this.deathTime = 0;
    if (this.actions.death) this.actions.death.stop();
    if (this.actions.idle) { this.actions.idle.reset().setEffectiveWeight(1).play(); }
    this.current = 'idle';
  }

  /** dir: world direction the character should aim at (or null) */
  update(dt, aimDir = null) {
    if (this.mixer) this.mixer.update(dt);
    if (this.dead) {
      this.deathTime = (this.deathTime || 0) + dt;
      if (!this.actions.death) {
        // procedural collapse
        const t = Math.min(1, this.deathTime * 2.2);
        this.model.rotation.x = lerp(0, -Math.PI / 2.1, t * t);
        this.model.position.y = lerp(0, -this.height * 0.42, t);
      }
      return;
    }

    const w = this.aimWeight;
    if (w > 0.01 && aimDir) {
      this.poseBone('armR', aimDir, w, 0);
      this.poseBone('foreArmR', aimDir, w * 0.95, 0);
      if (this.bones.armL) {
        _v1.copy(aimDir).addScaledVector(this.bindRight, -0.28).normalize();
        this.poseBone('armL', _v1, w * 0.9, 0);
        this.poseBone('foreArmL', _v1, w * 0.85, 0);
      }
      // spine pitch
      if (this.bones.spine1) {
        const bone = this.bones.spine1;
        const pitch = Math.asin(clamp(-aimDir.y, -1, 1)) * 0.45;
        _q1.setFromAxisAngle(new THREE.Vector3(1, 0, 0).applyQuaternion(this.group.getWorldQuaternion(new THREE.Quaternion())), -pitch);
        _q2.copy(bone.userData.rest).premultiply(_q1);
        bone.quaternion.slerp(_q2, w * 0.8);
      }
      if (this.bones.head) {
        _v1.copy(aimDir);
        this.poseBone('head', _v1, w * 0.5);
      }
    }

    // recoil kick
    if (this.recoil > 0.001) {
      this.recoil = Math.max(0, this.recoil - dt * 5.5);
      const k = this.recoil * 0.16;
      for (const key of ['armR', 'foreArmR', 'spine1']) {
        const bone = this.bones[key];
        if (!bone) continue;
        _q1.setFromAxisAngle(new THREE.Vector3(1, 0, 0).applyQuaternion(this.group.getWorldQuaternion(new THREE.Quaternion())), -k);
        bone.quaternion.premultiply(_q1);
      }
    }

    // melee swing
    if (this.meleeTime >= 0) {
      this.meleeTime += dt;
      const t = clamp(this.meleeTime / 0.45, 0, 1);
      const swing = Math.sin(t * Math.PI) * 1.5;
      if (this.bones.armR) {
        _v1.copy(this.bindForward).applyQuaternion(this.group.getWorldQuaternion(_q2));
        _v2.set(0, 1, 0).applyQuaternion(this.group.getWorldQuaternion(_q2));
        _v1.applyAxisAngle(_v2, swing).normalize();
        this.poseBone('armR', _v1, 0.95);
        this.poseBone('foreArmR', _v1, 0.9);
      }
      if (t >= 1) this.meleeTime = -1;
    }

    // hit reaction
    if (this.hitTime > 0) {
      this.hitTime -= dt;
      const k = Math.sin((this.hitTime / 0.35) * Math.PI) * 0.28;
      if (this.bones.chest || this.bones.spine1) {
        const bone = this.bones.chest || this.bones.spine1;
        _q1.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -k);
        bone.quaternion.premultiply(_q1);
      }
    }
  }

  /** world position of a bone (hand, head, ...) */
  bonePosition(key, out = new THREE.Vector3()) {
    const b = this.bones[key];
    if (!b) return out.copy(this.group.position);
    return b.getWorldPosition(out);
  }

  dispose() {
    this.group.removeFromParent();
    if (this.mixer) this.mixer.stopAllAction();
  }
}

/** Load-friendly helper that builds a whole squad of distinct characters. */
export const SQUAD_DEFS = [
  { id: 'kael', name: 'Kael Voss', model: 'soldier', role: 'assault', tint: null, color: 0xffffff, height: 1.82 },
  { id: 'mira', name: 'Mira Sol', model: 'michelle', role: 'marksman', tint: 0xd8c7b0, color: 0xd8c7b0, height: 1.72 },
  { id: 'dorn', name: 'Dorn Halvard', model: 'xbot', role: 'support', tint: 0xb9c4d0, color: 0xb9c4d0, height: 1.86 },
  { id: 'nyx', name: 'Nyx Ardyn', model: 'soldier', role: 'engineer', tint: 0x9fb0c8, color: 0x9fb0c8, height: 1.78 },
];
