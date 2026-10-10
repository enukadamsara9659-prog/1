// Interactive world objects: the fallen meteor, shard nests, beacons, caches,
// NPCs and loot drops. Everything the player can walk up to and press E on.
import * as THREE from 'three';
import assets from '../core/assets.js';
import { Character } from '../entities/character.js';
import { Rng, clamp, lerp } from '../core/rng.js';

const _v = new THREE.Vector3();
const _push = { x: 0, z: 0 };

function crackTexture(size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  const rng = new Rng(77);
  g.lineCap = 'round';
  for (let i = 0; i < 60; i++) {
    let x = rng.float() * size, y = rng.float() * size;
    let a = rng.float() * Math.PI * 2;
    const segs = 6 + (rng.int ? rng.int(14) : 8);
    g.strokeStyle = `rgba(255,${120 + rng.float() * 80 | 0},60,${0.35 + rng.float() * 0.6})`;
    g.lineWidth = 0.6 + rng.float() * 2.6;
    g.beginPath();
    g.moveTo(x, y);
    for (let s = 0; s < segs; s++) {
      a += (rng.float() - 0.5) * 1.1;
      x += Math.cos(a) * (6 + rng.float() * 22);
      y += Math.sin(a) * (6 + rng.float() * 22);
      g.lineTo(x, y);
    }
    g.stroke();
  }
  // soften
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] * 0.9;
    d[i] = v; d[i + 1] = v * 0.45; d[i + 2] = v * 0.2;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class WorldObjects {
  constructor(ctx) {
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'worldobjects';
    ctx.scene.add(this.group);
    this.rng = new Rng(555);
    this.interactables = [];   // { pos, radius, kind, label, data, object }
    this.nests = [];
    this.pickups = [];
    this.npcs = [];
    this.beacons = [];
    this.time = 0;
  }

  build() {
    this.buildMeteor();
    this.buildNests();
    this.buildBeacons();
    this.buildCaches();
    this.buildNPCs();
    return this;
  }

  // ------------------------------------------------------------- the meteor
  buildMeteor() {
    const { world } = this.ctx;
    const c = world.crater;
    if (!c) return;
    const g = new THREE.IcosahedronGeometry(1, 3);
    const pos = g.attributes.position;
    const rng = this.rng;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = Math.sin(v.x * 3.1) * Math.cos(v.y * 2.7) * Math.sin(v.z * 3.4);
      const n2 = Math.sin(v.x * 7.3 + 1.2) * Math.cos(v.z * 6.1) * 0.4;
      v.multiplyScalar(1 + n * 0.16 + n2 * 0.08 + rng.range(-0.03, 0.03));
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    const rockCol = assets.tex('terrain.rock.color');
    const rockNr = assets.tex('terrain.rock.nr');
    if (rockCol) { rockCol.wrapS = rockCol.wrapT = THREE.RepeatWrapping; }
    if (rockNr) { rockNr.wrapS = rockNr.wrapT = THREE.RepeatWrapping; }
    this.crack = crackTexture(512);
    this.crack.repeat.set(3, 3);

    const mat = new THREE.MeshStandardMaterial({
      color: 0x2a2622,
      map: rockCol || null,
      normalMap: rockNr || null,
      normalScale: new THREE.Vector2(1, 1),
      emissive: 0xff6a1e,
      emissiveMap: this.crack,
      emissiveIntensity: 2.4,
      roughness: 0.92,
      metalness: 0.12,
    });
    const meteor = new THREE.Mesh(g, mat);
    const R = Math.max(16, c.radius * 0.32);
    meteor.scale.set(R, R * 0.86, R);
    meteor.position.set(c.x, world.heightAt(c.x, c.z) + R * 0.52, c.z);
    meteor.rotation.set(0.4, 0.9, -0.25);
    meteor.castShadow = true;
    meteor.receiveShadow = true;
    this.group.add(meteor);
    this.meteor = meteor;

    // buried ring of shard spires
    const spireGeo = new THREE.ConeGeometry(1, 1, 5);
    const spireMat = new THREE.MeshStandardMaterial({
      color: 0x1a1613, emissive: 0xff7a2a, emissiveIntensity: 2.2, roughness: 0.6, metalness: 0.3,
    });
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + rng.range(-0.1, 0.1);
      const rr = R * rng.range(1.05, 1.9);
      const x = c.x + Math.cos(a) * rr, z = c.z + Math.sin(a) * rr;
      const s = new THREE.Mesh(spireGeo, spireMat);
      const h = rng.range(4, 13);
      s.scale.set(rng.range(0.8, 2.1), h, rng.range(0.8, 2.1));
      s.position.set(x, world.heightAt(x, z) + h * 0.32, z);
      s.rotation.set(rng.range(-0.2, 0.2), rng.float() * 6, rng.range(-0.2, 0.2));
      s.castShadow = true;
      this.group.add(s);
    }

    // the wound: a pool of molten light in the crater
    const light = new THREE.PointLight(0xff7a30, 900, 340, 2);
    light.position.set(c.x, world.heightAt(c.x, c.z) + 8, c.z);
    this.group.add(light);
    this.meteorLight = light;

    this.addInteract(meteor.position.clone(), 26, 'meteor', 'Examine the fallen star', { meteor: true });
  }

  // ------------------------------------------------------------- nests
  buildNests() {
    const { world } = this.ctx;
    const rng = this.rng;
    const crystalGeo = new THREE.ConeGeometry(1, 1, 6);
    for (const nest of world.nests) {
      const g = new THREE.Group();
      const y = world.heightAt(nest.x, nest.z);
      g.position.set(nest.x, y, nest.z);
      const coreMat = new THREE.MeshStandardMaterial({
        color: 0x0d2a26, emissive: 0x2fffc4, emissiveIntensity: 2.6, roughness: 0.25, metalness: 0.4,
      });
      const shards = [];
      const n = 5 + Math.floor(rng.float() * 4);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
        const rr = rng.range(0.5, 2.4);
        const m = new THREE.Mesh(crystalGeo, coreMat);
        const h = rng.range(2.2, 5.4);
        m.scale.set(rng.range(0.4, 0.9), h, rng.range(0.4, 0.9));
        m.position.set(Math.cos(a) * rr, h * 0.4, Math.sin(a) * rr);
        m.rotation.set(rng.range(-0.25, 0.25), rng.float() * 6, rng.range(-0.25, 0.25));
        m.castShadow = true;
        g.add(m);
        shards.push(m);
      }
      // scorched mound
      const mound = new THREE.Mesh(
        new THREE.SphereGeometry(1, 16, 12),
        new THREE.MeshStandardMaterial({ color: 0x241f1c, roughness: 1 })
      );
      mound.scale.set(rng.range(4, 7), rng.range(1.2, 2.2), rng.range(4, 7));
      mound.position.y = -0.4;
      mound.receiveShadow = true;
      g.add(mound);
      const light = new THREE.PointLight(0x2fffc4, 60, 46, 2);
      light.position.y = 3;
      g.add(light);
      this.group.add(g);
      const nestObj = {
        x: nest.x, z: nest.z, y, group: g, shards, light, coreMat,
        hp: 420, maxHp: 420, destroyed: false, emberT: 0,
      };
      this.nests.push(nestObj);
      this.addInteract(_v.set(nest.x, y + 2, nest.z).clone(), 6, 'nest', 'Destroy shard nest', { nest: nestObj });
    }
  }

  nearestNest(pos) {
    let best = null, bd = Infinity;
    for (const n of this.nests) {
      if (n.destroyed) continue;
      const d = Math.hypot(n.x - pos.x, n.z - pos.z);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  damageNest(nest, amount) {
    if (nest.destroyed) return;
    nest.hp -= amount;
    nest.coreMat.emissiveIntensity = 2.6 + Math.sin(performance.now() * 0.02) * 3;
    this.ctx.particles?.sparks(_v.set(nest.x, nest.y + 2, nest.z), 6);
    if (nest.hp <= 0) this.destroyNest(nest);
  }

  destroyNest(nest) {
    nest.destroyed = true;
    const pos = new THREE.Vector3(nest.x, nest.y + 2.4, nest.z);
    this.ctx.particles?.explosion(pos, 9, 0x53ffc8);
    this.ctx.combat?.explosion(pos, 12, 120, null);
    this.ctx.audio?.play('explosion', { pos });
    for (const s of nest.shards) {
      s.userData.fall = { v: new THREE.Vector3((Math.random() - 0.5) * 6, 4 + Math.random() * 5, (Math.random() - 0.5) * 6), t: 0 };
    }
    const p = this.ctx.player;
    if (p) { p.aether += 2; p.addXp(180); }
    this.ctx.events?.emit('nest:destroyed', nest);
    this.ctx.enemies?.spawnWave(6, 'spawnling', 26, { x: nest.x, z: nest.z });
  }

  // ------------------------------------------------------------- beacons
  buildBeacons() {
    const { world, assets: A } = this.ctx;
    const col = assets.gltf('graveyard', 'pillar-obelisk') || assets.gltf('graveyard', 'pillar-large');
    for (const poi of world.pois) {
      const g = new THREE.Group();
      const y = world.heightAt(poi.x + 8, poi.z + 8);
      g.position.set(poi.x + 8, y, poi.z + 8);
      if (col) {
        const m = assets.model('graveyard', col === assets.gltf('graveyard', 'pillar-obelisk') ? 'pillar-obelisk' : 'pillar-large');
        m.scale.setScalar(2.2);
        m.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
        g.add(m);
      }
      const orb = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.7, 1),
        new THREE.MeshStandardMaterial({ color: 0x9ff4ff, emissive: 0x4fd6ff, emissiveIntensity: 3, roughness: 0.2 })
      );
      orb.position.y = 5.4;
      g.add(orb);
      const light = new THREE.PointLight(0x6fdcff, 40, 40, 2);
      light.position.y = 5.4;
      g.add(light);
      this.group.add(g);
      const b = { x: g.position.x, z: g.position.z, y, poi, orb, light, attuned: false, group: g };
      this.beacons.push(b);
      this.addInteract(new THREE.Vector3(b.x, b.y + 2, b.z), 5, 'beacon', 'Attune beacon', { beacon: b });
    }
  }

  // ------------------------------------------------------------- caches
  buildCaches() {
    const { world } = this.ctx;
    const hasChest = assets.has('props', 'chest');
    for (const poi of world.pois) {
      if (poi.kind === 'camp' || poi.kind === 'ruins' || poi.kind === 'outpost' || poi.kind === 'village') {
        const a = this.rng.float() * Math.PI * 2;
        const x = poi.x + Math.cos(a) * 12, z = poi.z + Math.sin(a) * 12;
        const y = world.heightAt(x, z);
        const g = new THREE.Group();
        g.position.set(x, y, z);
        g.rotation.y = this.rng.float() * 6;
        if (hasChest) {
          const m = assets.model('props', 'chest');
          m.scale.setScalar(1.6);
          g.add(m);
        } else {
          const box = new THREE.Mesh(
            new THREE.BoxGeometry(1.2, 0.8, 0.8),
            new THREE.MeshStandardMaterial({ color: 0x5a3f27, roughness: 0.8 })
          );
          box.position.y = 0.4;
          box.castShadow = true;
          g.add(box);
        }
        this.group.add(g);
        this.addInteract(new THREE.Vector3(x, y + 0.6, z), 3.2, 'cache', 'Open supply cache', { cache: { x, y, z, looted: false, group: g } });
      }
    }
  }

  // ------------------------------------------------------------- NPCs
  buildNPCs() {
    const { world } = this.ctx;
    const models = ['michelle', 'xbot', 'soldier'];
    const names = [
      ['Elder Saren', 'The sky has been falling for three nights. You came from the light — so tell me, was it mercy or just aim?', 'caravan'],
      ['Quartermaster Vey', 'Take what you need. Shards are endless, but good steel is not.', 'shards'],
      ['Warden Ilsa', 'The pines have stopped singing. Something in there is eating the silence.', 'hunt'],
    ];
    let i = 0;
    for (const poi of world.pois) {
      if (poi.kind !== 'village' && poi.kind !== 'camp' && poi.kind !== 'monastery') continue;
      const [name, line, quest] = names[i % names.length];
      i++;
      const modelName = models[i % models.length];
      const a = this.rng.float() * Math.PI * 2;
      const x = poi.x + Math.cos(a) * 9, z = poi.z + Math.sin(a) * 9;
      const y = world.heightAt(x, z);
      const npc = new Character({ model: modelName, height: modelName === 'xbot' ? 1.88 : 1.72, name });
      npc.group.position.set(x, y, z);
      npc.group.rotation.y = this.rng.float() * 6;
      this.group.add(npc.group);
      const n = { char: npc, name, line, quest, x, y, z, pos: new THREE.Vector3(x, y, z) };
      this.npcs.push(n);
      this.addInteract(new THREE.Vector3(x, y + 1, z), 3.4, 'npc', 'Talk to ' + name, { npc: n });
    }
  }

  addInteract(pos, radius, kind, label, data) {
    this.interactables.push({ pos: pos.clone(), radius, kind, label, data });
  }

  // ------------------------------------------------------------- loot
  dropLoot(pos, kind = 'shard', amount = 1) {
    const geo = kind === 'core' ? new THREE.OctahedronGeometry(0.42, 0) : new THREE.TetrahedronGeometry(0.22, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: kind === 'core' ? 0x0d2a26 : 0xbff7e6,
      emissive: kind === 'core' ? 0x2fffc4 : 0x8ffbe0,
      emissiveIntensity: 2.8, roughness: 0.2, metalness: 0.5,
    });
    for (let i = 0; i < amount; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(pos.x + this.rng.range(-1.2, 1.2), pos.y + 1.2, pos.z + this.rng.range(-1.2, 1.2));
      m.castShadow = false;
      this.group.add(m);
      this.pickups.push({
        mesh: m, kind, t: 0, collected: false,
        vel: new THREE.Vector3(this.rng.range(-2, 2), this.rng.range(2, 5), this.rng.range(-2, 2)),
        pos: m.position.clone(),
      });
    }
  }

  // ------------------------------------------------------------- frame
  update(dt, player) {
    this.time += dt;
    const t = this.time;

    // meteor pulse
    if (this.meteor) {
      const k = 2.1 + Math.sin(t * 1.3) * 0.5 + Math.sin(t * 0.41) * 0.3;
      this.meteor.material.emissiveIntensity = k;
      if (this.meteorLight) this.meteorLight.intensity = 700 + Math.sin(t * 1.7) * 260;
      if (Math.random() < dt * 6) {
        const c = this.ctx.world.crater;
        this.ctx.particles?.embers(_v.set(
          c.x + (Math.random() - 0.5) * 30, this.ctx.world.heightAt(c.x, c.z) + 2, c.z + (Math.random() - 0.5) * 30), 1);
      }
    }

    // nests
    for (const n of this.nests) {
      if (!n.destroyed) {
        const k = 2.2 + Math.sin(t * 2.2 + n.x) * 0.8;
        n.coreMat.emissiveIntensity = k;
        n.light.intensity = 45 + Math.sin(t * 3 + n.z) * 20;
        n.emberT -= dt;
        if (n.emberT <= 0) {
          n.emberT = 0.25;
          this.ctx.particles?.embers(_v.set(n.x + (Math.random() - 0.5) * 4, n.y + 1, n.z + (Math.random() - 0.5) * 4), 1);
        }
      } else {
        for (const s of n.shards) {
          const f = s.userData.fall;
          if (!f) continue;
          f.t += dt;
          f.v.y -= 18 * dt;
          s.position.addScaledVector(f.v, dt);
          s.rotation.x += dt * 3;
          if (f.t > 4) s.visible = false;
        }
        n.light.intensity = Math.max(0, n.light.intensity - dt * 60);
      }
    }

    // beacons
    for (const b of this.beacons) {
      b.orb.position.y = 5.4 + Math.sin(t * 1.6 + b.x) * 0.25;
      b.orb.rotation.y += dt * 0.8;
      b.light.intensity = (b.attuned ? 70 : 34) + Math.sin(t * 2.4 + b.z) * 12;
      b.orb.material.emissiveIntensity = b.attuned ? 4.5 : 2.4;
    }

    // NPCs idle
    for (const n of this.npcs) {
      n.char.update(dt, null);
      n.char.setSpeed(0);
    }

    // pickups: magnet + collect
    const p = player.pos;
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const k = this.pickups[i];
      k.t += dt;
      const d = k.pos.distanceTo(p);
      if (d < 9) {
        const dir = _v.copy(p).setY(p.y + 1).sub(k.pos).normalize();
        k.vel.addScaledVector(dir, 60 * dt);
      } else {
        k.vel.y -= 16 * dt;
      }
      k.pos.addScaledVector(k.vel, dt);
      const gy = this.ctx.world.heightAt(k.pos.x, k.pos.z);
      if (k.pos.y < gy + 0.2) { k.pos.y = gy + 0.2; k.vel.y = Math.abs(k.vel.y) * 0.35; k.vel.x *= 0.7; k.vel.z *= 0.7; }
      k.mesh.position.copy(k.pos);
      k.mesh.rotation.y += dt * 3;
      k.mesh.position.y += Math.sin(k.t * 4) * 0.08;
      if (d < 2.2 || k.t > 60) {
        if (d < 2.2) this.collect(k, player);
        this.group.remove(k.mesh);
        this.pickups.splice(i, 1);
      }
    }

    // nearest interactable
    let best = null, bd = Infinity;
    for (const it of this.interactables) {
      const d = Math.hypot(it.pos.x - p.x, it.pos.z - p.z);
      if (d < it.radius && d < bd) {
        if (it.kind === 'nest' && it.data.nest.destroyed) continue;
        if (it.kind === 'cache' && it.data.cache.looted) continue;
        bd = d; best = it;
      }
    }
    this.nearest = best;
    if (this.ctx.hud) this.ctx.hud.prompt(best ? best.label : null);
  }

  collect(k, player) {
    if (k.kind === 'shard') {
      const n = 1 + Math.floor(Math.random() * 3);
      player.shards += Math.round(n * (player.derived?.gain || 1));
      this.ctx.audio?.play('pickup', { gain: 0.4 });
      this.ctx.events?.emit('pickup', 'shard');
    } else if (k.kind === 'core') {
      player.aether += 1;
      player.shards += 25;
      this.ctx.audio?.play('pickup', { gain: 0.7 });
      this.ctx.events?.emit('pickup', 'core');
      this.ctx.hud?.note('SHARD CORE SECURED', 'good');
    }
  }

  interact(player) {
    const it = this.nearest;
    if (!it) return false;
    switch (it.kind) {
      case 'nest': {
        this.damageNest(it.data.nest, 9999);
        return true;
      }
      case 'beacon': {
        const b = it.data.beacon;
        b.attuned = true;
        b.poi.discovered = true;
        this.ctx.hud?.note(`BEACON ATTUNED — ${(b.poi.name || b.poi.kind).toUpperCase()}`, 'good');
        this.ctx.audio?.play('levelup', { gain: 0.5 });
        player.addXp(60);
        return true;
      }
      case 'cache': {
        const c = it.data.cache;
        c.looted = true;
        player.shards += 40 + Math.floor(Math.random() * 60);
        player.grenades = Math.min(player.grenadeMax || 3, player.grenades + 2);
        player.addXp(70);
        this.ctx.particles?.burst(new THREE.Vector3(c.x, c.y + 0.8, c.z), { count: 20, speed: 3, color: 0xffd479, life: 0.9, size: 0.14 });
        this.ctx.audio?.play('pickup', { gain: 0.8 });
        this.ctx.hud?.note('SUPPLY CACHE — +shards, +2 grenades', 'good');
        return true;
      }
      case 'npc': {
        const n = it.data.npc;
        this.ctx.hud?.subtitle(n.name, n.line);
        this.ctx.events?.emit('npc:talk', n);
        const quests = this.ctx.quests;
        if (quests && n.quest && !quests.active.find((q) => q.id === n.quest) && !quests.done.has(n.quest)) {
          quests.start(n.quest);
        }
        return true;
      }
      case 'meteor': {
        this.ctx.hud?.subtitle('The Shard', 'Still warm. Still whispering.');
        this.ctx.events?.emit('npc:talk', { name: 'The Shard', line: 'Still warm. Still whispering.', quest: null });
        return true;
      }
    }
    return false;
  }

  save() {
    return {
      nests: this.nests.map((n) => (n.destroyed ? 1 : 0)),
      beacons: this.beacons.map((b) => (b.attuned ? 1 : 0)),
    };
  }

  load(data) {
    if (!data) return;
    (data.nests || []).forEach((v, i) => {
      if (this.nests[i] && v) {
        const n = this.nests[i];
        n.destroyed = true;
        n.hp = 0;
        n.light.intensity = 0;
        for (const s of n.shards) s.visible = false;
      }
    });
    (data.beacons || []).forEach((v, i) => {
      if (this.beacons[i] && v) { this.beacons[i].attuned = true; this.beacons[i].poi.discovered = true; }
    });
  }
}
