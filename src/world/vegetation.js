// Instanced vegetation: trees, rocks (from worldgen) + streamed undergrowth.
import * as THREE from 'three';
import { WORLD } from './constants.js';
import settings from '../core/settings.js';
import { Rng } from '../core/rng.js';

const SECTORS = 8;
const SECTOR_SIZE = WORLD.SIZE / SECTORS;

// species → (asset, target height in metres, shadow casting)
const SPECIES_DEF = {
  pine: { group: 'nature', model: 'pine', height: 15, wind: 1.0, shadow: true },
  tree: { group: 'nature', model: 'tree', height: 13, wind: 1.0, shadow: true },
  twisted: { group: 'nature', model: 'twisted_tree', height: 8.5, wind: 1.15, shadow: true },
  dead: { group: 'nature', model: 'dead_tree', height: 9, wind: 0.45, shadow: true },
  rock: { group: 'nature', model: 'rock_medium', height: 2.4, wind: 0, shadow: true },
  pebble: { group: 'nature', model: 'pebble_round', height: 0.55, wind: 0, shadow: false },
};

const UNDER_DEF = {
  grass: { group: 'nature', model: 'grass', height: 0.55, wind: 1.4, density: 0.55 },
  tallgrass: { group: 'nature', model: 'tall_grass', height: 1.0, wind: 1.7, density: 0.28 },
  fern: { group: 'nature', model: 'fern', height: 0.85, wind: 1.2, density: 0.16 },
  plant: { group: 'nature', model: 'plant', height: 0.6, wind: 1.1, density: 0.14 },
  plantbig: { group: 'nature', model: 'plant_big', height: 1.1, wind: 1.3, density: 0.07 },
  bush: { group: 'nature', model: 'bush', height: 1.3, wind: 0.9, density: 0.05 },
  flower: { group: 'nature', model: 'flower_group', height: 0.4, wind: 1.0, density: 0.06 },
  mushroom: { group: 'nature', model: 'mushroom', height: 0.3, wind: 0.2, density: 0.03 },
};

const VEG_PARTS = /* glsl */ `
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
varying vec3 vTint;
varying float vHeightRatio;
`;

export class Vegetation {
  constructor(scene, world, assets) {
    this.scene = scene;
    this.world = world;
    this.assets = assets;
    this.group = new THREE.Group();
    this.group.name = 'vegetation';
    scene.add(this.group);
    this.meshes = [];           // { mesh, sector, species, count }
    this.materials = new Map();
    this.time = 0;
    this.wind = new THREE.Vector2(1, 0.35);
    this.windStrength = 1;
    this.trunks = null;         // spatial hash for collision
    this.under = [];            // streamed undergrowth meshes
    this.underCell = null;
    this.dummy = new THREE.Object3D();
  }

  /** extract geometry + material from a glb, normalised to a target height */
  static extract(assets, group, name, targetHeight) {
    const gltf = assets.gltf(group, name);
    if (!gltf) return null;
    let mesh = null;
    gltf.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
    if (!mesh) return null;
    const geo = mesh.geometry.clone();
    if (!geo.attributes.uv) {
      const count = geo.attributes.position.count;
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const h = Math.max(0.001, bb.max.y - bb.min.y);
    const scale = targetHeight / h;
    geo.translate(0, -bb.min.y, 0);
    geo.scale(scale, scale, scale);
    geo.computeBoundingSphere();
    const mat = mesh.material.clone();
    return { geo, mat, scale };
  }

  patchMaterial(mat, windAmount) {
    if (mat.userData.__vegPatched) return mat;
    mat.userData.__vegPatched = true;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uniforms.uTime;
      shader.uniforms.uWindDir = this.uniforms.uWindDir;
      shader.uniforms.uWindStrength = this.uniforms.uWindStrength;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + VEG_PARTS)
        .replace('#include <begin_vertex>', `
          #include <begin_vertex>
          #ifdef USE_INSTANCING
            vec3 iorigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          #else
            vec3 iorigin = vec3(0.0);
          #endif
          float tintHash = fract(sin(dot(iorigin.xz, vec2(12.9898, 78.233))) * 43758.5453);
          float tintHash2 = fract(sin(dot(iorigin.zx + 3.1, vec2(39.346, 11.135))) * 24634.6345);
          vTint = vec3(
            0.82 + tintHash * 0.36,
            0.86 + tintHash2 * 0.30,
            0.80 + (1.0 - tintHash) * 0.34
          );
          vHeightRatio = clamp(position.y * 0.12, 0.0, 1.0);
          if (${windAmount.toFixed(2)} > 0.0) {
            float ph = uTime * 1.9 + dot(iorigin.xz, vec2(0.017, 0.023));
            float gust = 0.65 + 0.35 * sin(uTime * 0.31 + dot(iorigin.xz, vec2(0.0031, 0.0027)));
            float bend = max(transformed.y, 0.0) * 0.028 * ${windAmount.toFixed(2)} * uWindStrength * gust;
            float s = sin(ph) * 0.6 + sin(ph * 2.37 + 1.1) * 0.4;
            transformed.x += uWindDir.x * bend * s;
            transformed.z += uWindDir.y * bend * s;
            transformed.y -= bend * 0.18 * abs(s);
          }
        `);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTint;\nvarying float vHeightRatio;')
        .replace('#include <map_fragment>', `
          #include <map_fragment>
          diffuseColor.rgb *= mix(vec3(1.0), vTint, 0.55);
        `);
    };
    mat.needsUpdate = true;
    return mat;
  }

  build() {
    this.uniforms = {
      uTime: { value: 0 },
      uWindDir: { value: new THREE.Vector2(1, 0.35) },
      uWindStrength: { value: 1 },
    };
    const densityScale = settings.q('vegDensity');

    // ---- static scatter (trees + rocks)
    const buckets = new Map(); // key `${sx},${sz},${species}` -> arrays
    const veg = this.world.veg;
    for (const [species, def] of Object.entries(SPECIES_DEF)) {
      const data = veg[species];
      if (!data || !data.length) continue;
      const ext = Vegetation.extract(this.assets, def.group, def.model, def.height);
      if (!ext) { console.warn('missing vegetation model', species); continue; }
      const mat = this.patchMaterial(ext.mat, def.wind);
      const count = data.length / 5;
      for (let i = 0; i < count; i++) {
        // density cull (deterministic hash)
        const h = ((i * 2654435761) >>> 0) / 4294967296;
        if (h > densityScale) continue;
        const x = data[i * 5], y = data[i * 5 + 1], z = data[i * 5 + 2], s = data[i * 5 + 3], r = data[i * 5 + 4];
        const sx = Math.floor((x + WORLD.HALF) / SECTOR_SIZE);
        const sz = Math.floor((z + WORLD.HALF) / SECTOR_SIZE);
        const key = `${sx},${sz},${species}`;
        let b = buckets.get(key);
        if (!b) buckets.set(key, (b = []));
        b.push(x, y, z, s, r);
      }
      this.materials.set(species, { ext, mat, def });
    }

    const dummy = this.dummy;
    for (const [key, arr] of buckets) {
      const [sx, sz, species] = key.split(',');
      const { ext, mat, def } = this.materials.get(species);
      const n = arr.length / 5;
      const im = new THREE.InstancedMesh(ext.geo, mat, n);
      im.castShadow = def.shadow;
      im.receiveShadow = true;
      im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      for (let i = 0; i < n; i++) {
        dummy.position.set(arr[i * 5], arr[i * 5 + 1], arr[i * 5 + 2]);
        dummy.rotation.set(0, arr[i * 5 + 4], 0);
        const s = arr[i * 5 + 3];
        // slight random tilt so nothing looks stamped
        dummy.rotation.x = (Math.sin(arr[i * 5] * 0.31) * 0.03);
        dummy.rotation.z = (Math.cos(arr[i * 5 + 2] * 0.27) * 0.03);
        dummy.scale.set(s, s * (0.9 + ((i * 37) % 20) / 100), s);
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
      }
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.userData.sector = { x: +sx, z: +sz, size: SECTOR_SIZE };
      im.userData.species = species;
      this.group.add(im);
      this.meshes.push(im);
    }
    this.buildTrunkGrid();

    // ---- streamed undergrowth pools
    for (const [name, def] of Object.entries(UNDER_DEF)) {
      const ext = Vegetation.extract(this.assets, def.group, def.model, def.height);
      if (!ext) continue;
      const mat = this.patchMaterial(ext.mat, def.wind);
      mat.shadowSide = THREE.DoubleSide;
      const cap = Math.round(def.density * 26000 * Math.min(1.4, densityScale)) + 400;
      const im = new THREE.InstancedMesh(ext.geo, mat, cap);
      im.count = 0;
      im.castShadow = false;
      im.receiveShadow = true;
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.userData.def = def;
      this.group.add(im);
      this.under.push(im);
    }
    return this;
  }

  /** simple uniform grid of trunk positions for cheap collision */
  buildTrunkGrid() {
    const cell = 8;
    const map = new Map();
    const add = (x, z, r) => {
      const k = `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
      let a = map.get(k);
      if (!a) map.set(k, (a = []));
      a.push(x, z, r);
    };
    for (const species of ['pine', 'tree', 'twisted', 'dead']) {
      const data = this.world.veg[species];
      if (!data) continue;
      const n = data.length / 5;
      for (let i = 0; i < n; i++) {
        const h = ((i * 2654435761) >>> 0) / 4294967296;
        if (h > settings.q('vegDensity')) continue;
        add(data[i * 5], data[i * 5 + 2], Math.max(0.35, data[i * 5 + 3] * 0.55));
      }
    }
    this.trunks = { cell, map };
  }

  /** returns a push-out vector if (x,z) is inside a trunk */
  trunkPush(x, z, radius = 0.5, out = { x: 0, z: 0 }) {
    out.x = 0; out.z = 0;
    if (!this.trunks) return out;
    const { cell, map } = this.trunks;
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const a = map.get(`${cx + dx},${cz + dz}`);
        if (!a) continue;
        for (let i = 0; i < a.length; i += 3) {
          const dxp = x - a[i], dzp = z - a[i + 1];
          const rr = a[i + 2] + radius;
          const d2 = dxp * dxp + dzp * dzp;
          if (d2 < rr * rr) {
            const d = Math.sqrt(d2);
            const push = rr - d;
            if (d < 1e-4) out.x += push;            // dead centre: shove sideways
            else { out.x += (dxp / d) * push; out.z += (dzp / d) * push; }
          }
        }
      }
    }
    return out;
  }

  /** rebuild the undergrowth around the camera (deterministic per cell) */
  refreshUnder(camPos) {
    const dist = settings.q('grassDistance');
    if (!settings.q('grass')) { for (const m of this.under) m.count = 0; return; }
    const cell = 3.0;
    const cx = Math.floor(camPos.x / cell), cz = Math.floor(camPos.z / cell);
    if (this.underCell && this.underCell.x === cx && this.underCell.z === cz) return;
    this.underCell = { x: cx, z: cz };
    const world = this.world;
    const rng = new Rng(1337);
    const dummy = this.dummy;
    const counts = this.under.map(() => 0);
    const radiusCells = Math.ceil(dist / cell);
    const noise = new Rng(99);

    for (const m of this.under) m.count = 0;
    for (let dz = -radiusCells; dz <= radiusCells; dz++) {
      for (let dx = -radiusCells; dx <= radiusCells; dx++) {
        const d = Math.hypot(dx, dz) * cell;
        if (d > dist) continue;
        const gx = cx + dx, gz = cz + dz;
        rng.next = ((gx * 73856093) ^ (gz * 19349663) ^ 0x5eed) >>> 0;
        // reseed the generator deterministically for this cell
        let s = (Math.imul(gx, 374761393) ^ Math.imul(gz, 668265263) ^ 0x9e3779b9) >>> 0;
        const cellRng = {
          f: () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; },
        };
        const wx = gx * cell + cellRng.f() * cell;
        const wz = gz * cell + cellRng.f() * cell;
        const y = world.heightAt(wx, wz);
        if (y < 1.5) continue;
        const slope = world.slopeAt(wx, wz);
        if (slope > 0.62) continue;
        const moist = world.moistureAt(wx, wz);
        const scorch = world.scorchAt(wx, wz);
        if (scorch > 0.4 && cellRng.f() < 0.85) continue;
        const rv = world.riverAt(wx, wz);
        const alt = y;
        const fade = 1 - Math.pow(d / dist, 2);
        if (cellRng.f() > fade) continue;

        let idx = 0;
        for (const m of this.under) {
          const def = m.userData.def;
          let p = def.density;
          // biome shaping
          if (def.height > 0.9) p *= 0.35 + moist * 1.2;              // tall grass likes moisture
          if (def === UNDER_DEF.grass) p *= 0.6 + moist * 0.9;
          if (def === UNDER_DEF.flower) p *= (moist > 0.4 ? 1.0 : 0.35);
          if (def === UNDER_DEF.mushroom) p *= (moist > 0.55 ? 2.2 : 0.2);
          if (def === UNDER_DEF.bush) p *= (alt < 300 ? 1 : 0.3);
          p *= 1 - Math.min(0.85, slope * 1.1);
          p *= 0.4 + rv * 1.6;
          const r = cellRng.f();
          if (r < p && counts[idx] < m.instanceMatrix.count) {
            dummy.position.set(wx + (cellRng.f() - 0.5) * cell, y - 0.08, wz + (cellRng.f() - 0.5) * cell);
            dummy.rotation.set((cellRng.f() - 0.5) * 0.15, cellRng.f() * Math.PI * 2, (cellRng.f() - 0.5) * 0.15);
            const sc = 0.7 + cellRng.f() * 0.8;
            dummy.scale.set(sc, sc * (0.85 + cellRng.f() * 0.4), sc);
            dummy.updateMatrix();
            m.setMatrixAt(counts[idx]++, dummy.matrix);
          }
          idx++;
        }
      }
    }
    this.under.forEach((m, i) => { m.count = counts[i]; m.instanceMatrix.needsUpdate = true; });
  }

  update(dt, camera) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    this.uniforms.uWindDir.value.copy(this.wind);
    this.uniforms.uWindStrength.value = this.windStrength;

    const maxDist = settings.q('vegDistance');
    const px = camera.position.x, pz = camera.position.z;
    for (const im of this.meshes) {
      const s = im.userData.sector;
      const cx = -WORLD.HALF + (s.x + 0.5) * s.size;
      const cz = -WORLD.HALF + (s.z + 0.5) * s.size;
      const dx = Math.max(0, Math.abs(px - cx) - s.size * 0.5);
      const dz = Math.max(0, Math.abs(pz - cz) - s.size * 0.5);
      const d = Math.hypot(dx, dz);
      im.visible = d < maxDist;
    }
    this.refreshUnder(camera.position);
  }
}
