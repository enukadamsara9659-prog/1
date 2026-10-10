// Procedural architecture: villages, temples, palace, camps, ruins, roads, bridges.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { surfaceMaterial, makeBox, makePrism, makeCylinder } from './surfacemat.js';
import { TEXGEN } from './proctex.js';
import { Rng, clamp, lerp } from '../core/rng.js';
import { WORLD } from './constants.js';

const KIT_SCALE = 2.6;   // Kenney modules are authored on a 1 m grid → scale up

/* ------------------------------------------------------------------ kit ---- */
class Kit {
  constructor(assets, group, scale = KIT_SCALE) {
    this.group = group;
    this.scale = scale;
    this.models = new Map();
    this.material = null;
    const all = assets.group(group);
    for (const [name, gltf] of Object.entries(all)) {
      let mesh = null;
      gltf.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
      if (!mesh) continue;
      const geo = cleanGeo(mesh.geometry.clone());
      geo.scale(scale, scale, scale);
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      this.models.set(name, geo);
      const src = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      // prefer a textured source material (Kenney kits share one colormap atlas)
      if (!this.material || (!this.material.map && src && src.map)) {
        const mat = new THREE.MeshStandardMaterial({
          map: src.map || null,
          color: 0xffffff,
          roughness: 0.82,
          metalness: 0,
          side: THREE.FrontSide,
        });
        if (src.map) { src.map.colorSpace = THREE.SRGBColorSpace; src.map.wrapS = src.map.wrapT = THREE.RepeatWrapping; }
        if (this.material) { mat.map = src.map || this.material.map; }
        this.material = mat;
      }
    }
  }
  has(name) { return this.models.has(name); }
  get(name) { return this.models.get(name); }
  names() { return [...this.models.keys()]; }
}

function cleanGeo(geo) {
  for (const key of Object.keys(geo.attributes)) {
    if (!['position', 'normal', 'uv'].includes(key)) geo.deleteAttribute(key);
  }
  if (!geo.attributes.normal) geo.computeVertexNormals();
  if (!geo.attributes.uv) {
    const n = geo.attributes.position.count;
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  if (geo.index) geo = geo.toNonIndexed();
  return geo;
}

/* -------------------------------------------------------------- builder ---- */
/** mergeGeometries needs a consistent attribute + index layout */
const _compatCache = new WeakMap();
function compatible(geo) {
  let out = _compatCache.get(geo);
  if (out) return out;
  out = geo;
  for (const key of Object.keys(out.attributes)) {
    if (!['position', 'normal', 'uv'].includes(key)) out.deleteAttribute(key);
  }
  if (!out.attributes.normal) out.computeVertexNormals();
  if (!out.attributes.uv) {
    const n = out.attributes.position.count;
    out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  if (!out.index) {
    const n = out.attributes.position.count;
    const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    out.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return out;
}
class PartBuilder {
  constructor() { this.groups = new Map(); this.dummy = new THREE.Object3D(); }
  add(key, geo, pos, rot = 0, scale = 1, yOffset = 0) {
    const d = this.dummy;
    d.position.set(pos.x, pos.y + yOffset, pos.z);
    d.rotation.set(0, rot, 0);
    d.scale.setScalar(scale);
    d.updateMatrix();
    const g = compatible(geo.clone()).applyMatrix4(d.matrix);
    let arr = this.groups.get(key);
    if (!arr) this.groups.set(key, (arr = []));
    arr.push(g);
    return this;
  }
  addM(key, geo, matrix) {
    const g = compatible(geo.clone()).applyMatrix4(matrix);
    let arr = this.groups.get(key);
    if (!arr) this.groups.set(key, (arr = []));
    arr.push(g);
    return this;
  }
  finish(parent, materials) {
    const meshes = [];
    for (const [key, geos] of this.groups) {
      if (!geos.length) continue;
      const mat = materials[key];
      if (!mat) { console.warn('no material for', key); continue; }
      let merged;
      try { merged = mergeGeometries(geos, false); } catch (e) { console.warn('merge failed', key, e.message); continue; }
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      parent.add(mesh);
      meshes.push(mesh);
      for (const g of geos) g.dispose();
    }
    this.groups.clear();
    return meshes;
  }
}

/* ============================================================ structures === */
export class Structures {
  constructor(scene, world, assets) {
    this.scene = scene;
    this.world = world;
    this.assets = assets;
    this.group = new THREE.Group();
    this.group.name = 'structures';
    scene.add(this.group);
    this.colliders = [];           // { x, z, hw, hd, y0, y1, rot }
    this.floors = [];              // { x, z, hw, hd, y, rot }
    this.pois = [];                // built POI descriptors for gameplay
    this.lights = [];              // lamps / braziers
    this.kits = {};
  }

  build() {
    this.buildMaterials();
    this.kits = {
      town: new Kit(this.assets, 'town'),
      castle: new Kit(this.assets, 'castle'),
      props: new Kit(this.assets, 'props'),
      graveyard: new Kit(this.assets, 'graveyard'),
      nat: new Kit(this.assets, 'kenney_nature'),
      mini: new Kit(this.assets, 'miniforest'),
    };
    this.buildRoads();
    for (const poi of this.world.pois) this.buildPOI(poi);
    this.buildCrashSite();
    return this;
  }

  buildMaterials() {
    const a = this.assets;
    const surf = (k, o) => surfaceMaterial(a.tex(`surf.${k}.color`), a.tex(`surf.${k}.nr`), o);
    const gen = (name, o) => { const t = TEXGEN[name](); return surfaceMaterial(t.color, t.nr, o); };

    const plaster = surf('plaster', { roughness: 1 });
    const plaster2 = surf('plaster', { roughness: 1, color: 0xe0d2b4 });
    const plaster3 = surf('plaster', { roughness: 1, color: 0xc9b79a });
    this.mats = {
      plaster, plaster2, plaster3,
      stone: surf('stone', { roughness: 1 }),
      brick: surf('brick', { roughness: 1 }),
      wood: surf('wood', { roughness: 1 }),
      concrete: surf('concrete', { roughness: 1 }),
      metal: surf('metal', { roughness: 0.55, metalness: 0.9, roughScale: 0.8 }),
      roof: gen('roofTile', { roughness: 1 }),
      thatch: gen('thatch', { roughness: 1 }),
      cobble: gen('cobble', { roughness: 1 }),
      marble: gen('marble', { roughness: 0.55, roughScale: 0.7 }),
      stoneblock: gen('stoneblock', { roughness: 1 }),
      planks: gen('woodplanks', { roughness: 1 }),
      dirt: gen('dirtpath', { roughness: 1 }),
      darkwood: surf('wood', { roughness: 1, color: 0x6a5138 }),
      glass: new THREE.MeshStandardMaterial({ color: 0x141c24, roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.7 }),
      cloth: new THREE.MeshStandardMaterial({ color: 0x8c2f2f, roughness: 0.95, side: THREE.DoubleSide }),
      cloth2: new THREE.MeshStandardMaterial({ color: 0x2f4f8c, roughness: 0.95, side: THREE.DoubleSide }),
      ember: new THREE.MeshStandardMaterial({ color: 0x120806, roughness: 1, emissive: 0xff5a1e, emissiveIntensity: 2.2 }),
    };
  }

  /* ------------------------------------------------------------- helpers --- */
  addCollider(x, z, hw, hd, y0, y1, rot = 0) {
    this.colliders.push({ x, z, hw, hd, y0, y1, rot });
  }

  /** walkable surface (floors, platforms, bridge decks) */
  addFloor(x, z, hw, hd, y, rot = 0) {
    this.floors.push({ x, z, hw, hd, y, rot });
  }

  groundY(x, z) { return this.world.heightAt(x, z); }

  /** wall with rectangular openings, decomposed into boxes */
  addWallWithOpenings(B, matKey, w, h, t, openings, x, y, z, rot, uvScale = 0.42) {
    // openings in local wall coords: { u, v, w, h } origin bottom-left
    const xs = new Set([0, w]), ys = new Set([0, h]);
    for (const o of openings) {
      xs.add(clamp(o.u, 0, w)); xs.add(clamp(o.u + o.w, 0, w));
      ys.add(clamp(o.v, 0, h)); ys.add(clamp(o.v + o.h, 0, h));
    }
    const X = [...xs].sort((a, b) => a - b);
    const Y = [...ys].sort((a, b) => a - b);
    for (let i = 0; i < X.length - 1; i++) {
      for (let j = 0; j < Y.length - 1; j++) {
        const cw = X[i + 1] - X[i], ch = Y[j + 1] - Y[j];
        if (cw < 0.01 || ch < 0.01) continue;
        const cu = X[i] + cw / 2, cv = Y[j] + ch / 2;
        // inside an opening?
        let inside = false;
        for (const o of openings) {
          if (cu > o.u && cu < o.u + o.w && cv > o.v && cv < o.v + o.h) { inside = true; break; }
        }
        if (inside) continue;
        // place: local u along +X (rotated), v along +Y
        const lx = cu - w / 2, ly = cv;
        const c = Math.cos(rot), s = Math.sin(rot);
        const wx = x + lx * c, wz = z - lx * s;
        B.add(matKey, makeBox(cw, ch, t, uvScale), { x: wx, y: y + ly, z: wz }, rot);
      }
    }
  }

  /* --------------------------------------------------------------- house --- */
  buildHouse(B, poi, rng, cx, cz, rot, opts = {}) {
    const w = opts.w ?? rng.range(5.5, 9);
    const d = opts.d ?? rng.range(5, 8);
    const wallH = opts.wallH ?? rng.range(3.0, 3.6);
    const floors = opts.floors ?? (rng.bool(0.45) ? 2 : 1);
    const gy = this.groundY(cx, cz);
    const style = opts.style ?? rng.int(0, 2);
    const wallMat = ['plaster', 'plaster2', 'plaster3'][style];
    const roofMat = rng.bool(0.72) ? 'roof' : 'thatch';
    const timber = rng.bool(0.5);

    // stone foundation
    B.add('stoneblock', makeBox(w + 0.7, 0.55, d + 0.7, 0.4), { x: cx, y: gy + 0.05, z: cz }, rot);
    let baseY = gy + 0.5;

    for (let f = 0; f < floors; f++) {
      const y = baseY + f * wallH;
      const isGround = f === 0;
      // four walls
      const sides = [
        { len: w, ang: rot, ox: 0, oz: d / 2 },
        { len: w, ang: rot + Math.PI, ox: 0, oz: -d / 2 },
        { len: d, ang: rot + Math.PI / 2, ox: w / 2, oz: 0 },
        { len: d, ang: rot - Math.PI / 2, ox: -w / 2, oz: 0 },
      ];
      sides.forEach((sd, i) => {
        const c = Math.cos(rot), s = Math.sin(rot);
        const wx = cx + sd.ox * c + sd.oz * s;
        const wz = cz - sd.ox * s + sd.oz * c;
        const openings = [];
        if (isGround && i === 0) {
          openings.push({ u: sd.len * 0.5 - 0.6, v: 0, w: 1.2, h: 2.15 });       // door
          if (sd.len > 6) openings.push({ u: sd.len * 0.5 + 1.8, v: 0.9, w: 1.1, h: 1.3 });
        } else if (sd.len > 4.5) {
          const n = Math.floor(sd.len / 3.2);
          for (let k = 0; k < n; k++) {
            openings.push({ u: (k + 0.5) * (sd.len / n) - 0.55, v: isGround ? 1.0 : 0.8, w: 1.1, h: 1.25 });
          }
        }
        this.addWallWithOpenings(B, wallMat, sd.len, wallH, 0.34, openings, wx, y, wz, sd.ang, 0.42);
        // timber framing
        if (timber) {
          B.add('darkwood', makeBox(sd.len + 0.2, 0.22, 0.4, 0.4), { x: wx, y: y + wallH - 0.15, z: wz }, sd.ang);
          if (isGround) B.add('darkwood', makeBox(sd.len + 0.2, 0.18, 0.4, 0.4), { x: wx, y: y + 0.1, z: wz }, sd.ang);
        }
      });
      // floor slab for upper floors
      if (f > 0) B.add('planks', makeBox(w + 0.5, 0.25, d + 0.5, 0.4), { x: cx, y: y - 0.12, z: cz }, rot);
      // windows (glass panes)
      const wy = y + (isGround ? 1.55 : 1.35);
      this.addWindows(B, w, d, wy, cx, cz, rot, rng);
    }

    // roof
    const roofY = baseY + floors * wallH;
    const overhang = 0.45;
    const rw = w + overhang * 2, rd = d + overhang * 2;
    const gableH = rng.range(1.5, 2.3);
    const slopeLen = Math.hypot(rd / 2, gableH);
    const pitch = Math.atan2(gableH, rd / 2);
    for (const side of [-1, 1]) {
      const c = Math.cos(rot), s = Math.sin(rot);
      const oz = side * (rd / 4);
      const ox = 0;
      const wx = cx + ox * c + oz * s;
      const wz = cz - ox * s + oz * c;
      const dummy = new THREE.Object3D();
      dummy.position.set(wx, roofY + gableH / 2, wz);
      dummy.rotation.set(0, rot, 0);
      dummy.rotateX(side * pitch);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      B.addM(roofMat, makeBox(rw, 0.22, slopeLen, 0.45), dummy.matrix);
    }
    // gable ends
    for (const side of [0, 1]) {
      const ang = rot + (side ? Math.PI / 2 : -Math.PI / 2);
      const c = Math.cos(rot), s = Math.sin(rot);
      const oz = side ? rd / 2 : -rd / 2;
      const wx = cx + oz * s, wz = cz + oz * c;
      const dummy = new THREE.Object3D();
      dummy.position.set(wx, roofY, wz);
      dummy.rotation.set(0, ang, 0);
      dummy.updateMatrix();
      B.addM(wallMat, makePrism(rw * 0.98, gableH, 0.3, 0.42), dummy.matrix);
    }
    B.add(roofMat, makeBox(rw + 0.1, 0.16, 0.34, 0.4), { x: cx, y: roofY + gableH - 0.04, z: cz }, rot);

    // chimney
    if (rng.bool(0.65)) {
      const c = Math.cos(rot), s = Math.sin(rot);
      const ox = rng.range(-w * 0.3, w * 0.3), oz = rng.range(-d * 0.3, d * 0.3);
      const chx = cx + ox * c + oz * s, chz = cz - ox * s + oz * c;
      B.add('stoneblock', makeBox(0.7, gableH + 1.2, 0.7, 0.5), { x: chx, y: roofY, z: chz }, rot);
      B.add('stoneblock', makeBox(0.95, 0.18, 0.95, 0.5), { x: chx, y: roofY + gableH + 1.15, z: chz }, rot);
    }

    // collider
    this.addCollider(cx, cz, w / 2 + 0.3, d / 2 + 0.3, gy, roofY + gableH, rot);
    for (let f = 0; f < floors; f++) this.addFloor(cx, cz, w / 2, d / 2, gy + 0.75 + f * wallH, rot);
    return { x: cx, z: cz, y: gy, rot, w, d };
  }

  addWindows(B, w, d, y, cx, cz, rot, rng) {
    const mk = (lx, lz, ang) => {
      const c = Math.cos(rot), s = Math.sin(rot);
      const wx = cx + lx * c + lz * s, wz = cz - lx * s + lz * c;
      B.add('darkwood', makeBox(1.35, 1.6, 0.12, 0.5), { x: wx, y, z: wz }, ang);
      B.add('glass', makeBox(1.05, 1.25, 0.06, 1), { x: wx, y, z: wz }, ang);
    };
    mk(0, d / 2, rot);
    mk(0, -d / 2, rot + Math.PI);
    if (w > 6) { mk(w / 2, 0, rot + Math.PI / 2); mk(-w / 2, 0, rot - Math.PI / 2); }
  }

  /* --------------------------------------------------------------- POIs ---- */
  buildPOI(poi) {
    const rng = new Rng(poi.seed);
    const B = new PartBuilder();
    const before = this.colliders.length;
    let info = { kind: poi.kind, name: poi.name, x: poi.x, z: poi.z, y: poi.y, radius: poi.radius, buildings: [] };

    switch (poi.kind) {
      case 'village': info = { ...info, ...this.buildVillage(B, poi, rng) }; break;
      case 'temple': info = { ...info, ...this.buildTemple(B, poi, rng) }; break;
      case 'palace': info = { ...info, ...this.buildPalace(B, poi, rng) }; break;
      case 'monastery': info = { ...info, ...this.buildMonastery(B, poi, rng) }; break;
      case 'outpost': info = { ...info, ...this.buildOutpost(B, poi, rng) }; break;
      case 'ruins': info = { ...info, ...this.buildRuins(B, poi, rng) }; break;
      case 'camp': info = { ...info, ...this.buildCamp(B, poi, rng) }; break;
      case 'shrine': info = { ...info, ...this.buildShrine(B, poi, rng) }; break;
      default: break;
    }

    const holder = new THREE.Group();
    holder.name = `poi_${poi.kind}_${poi.name}`;
    holder.position.set(0, 0, 0);
    B.finish(holder, this.mats);
    // kenney props merged per kit
    this.finishKits(holder, poi);
    this.group.add(holder);
    info.colliderStart = before;
    info.object = holder;
    this.pois.push(info);
  }

  kitParts = new Map();  // poi -> {kitName: geometries[]}

  kit(name, model, x, y, z, rot = 0, scale = 1, yOff = 0) {
    if (!this.kitParts.has(this._curPOI)) this.kitParts.set(this._curPOI, new Map());
    const map = this.kitParts.get(this._curPOI);
    const kit = this.kits[name];
    if (!kit || !kit.has(model)) return;
    const geo = kit.get(model);
    const d = new THREE.Object3D();
    d.position.set(x, y + yOff, z);
    d.rotation.set(0, rot, 0);
    d.scale.setScalar(scale);
    d.updateMatrix();
    let arr = map.get(name);
    if (!arr) map.set(name, (arr = []));
    arr.push(geo.clone().applyMatrix4(d.matrix));
  }

  finishKits(parent, poi) {
    const map = this.kitParts.get(poi);
    if (!map) return;
    for (const [kitName, geos] of map) {
      const kit = this.kits[kitName];
      if (!kit || !geos.length) continue;
      let merged;
      try { merged = mergeGeometries(geos, false); } catch (e) { continue; }
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, kit.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      parent.add(mesh);
      for (const g of geos) g.dispose();
    }
    this.kitParts.delete(poi);
  }

  beginPOI(poi) { this._curPOI = poi; }

  /* ------------------------------------------------------------- village --- */
  buildVillage(B, poi, rng) {
    this.beginPOI(poi);
    const cx = poi.x, cz = poi.z, gy = this.groundY(cx, cz);
    const R = poi.radius;
    // plaza
    B.add('cobble', makeBox(26, 0.3, 26, 0.35), { x: cx, y: gy + 0.02, z: cz }, rng.range(0, 0.4));
    // fountain
    this.kit('town', 'fountain-round', cx, gy + 0.2, cz, rng.range(0, 6));
    this.kit('town', 'fountain-center', cx, gy + 0.2, cz, 0);

    const houses = [];
    const count = rng.int(9, 14);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + rng.range(-0.25, 0.25);
      const rad = rng.range(R * 0.35, R * 0.92);
      const hx = cx + Math.cos(a) * rad, hz = cz + Math.sin(a) * rad;
      if (Math.hypot(hx - cx, hz - cz) < 15) continue;
      const rot = a + Math.PI / 2 + rng.range(-0.3, 0.3);
      houses.push(this.buildHouse(B, poi, rng, hx, hz, rot));
    }
    // market stalls
    for (let i = 0; i < rng.int(3, 5); i++) {
      const a = rng.range(0, Math.PI * 2), rad = rng.range(8, 15);
      const sx = cx + Math.cos(a) * rad, sz = cz + Math.sin(a) * rad;
      const m = rng.pick(['stall', 'stall-green', 'stall-red']);
      this.kit('town', m, sx, this.groundY(sx, sz), sz, rng.range(0, 6));
      this.kit('town', 'stall-bench', sx + rng.range(-2, 2), this.groundY(sx, sz), sz + rng.range(-2, 2), rng.range(0, 6));
    }
    // props: carts, barrels, crates, lanterns, fences
    for (let i = 0; i < rng.int(14, 22); i++) {
      const a = rng.range(0, Math.PI * 2), rad = rng.range(6, R);
      const px = cx + Math.cos(a) * rad, pz = cz + Math.sin(a) * rad;
      const y = this.groundY(px, pz);
      const pick = rng.float();
      if (pick < 0.2) this.kit('town', 'cart', px, y, pz, rng.range(0, 6));
      else if (pick < 0.35) this.kit('props', 'barrel', px, y, pz, rng.range(0, 6), 1.2);
      else if (pick < 0.5) this.kit('props', 'box', px, y, pz, rng.range(0, 6), 1.2);
      else if (pick < 0.62) this.kit('props', 'resource-wood', px, y, pz, rng.range(0, 6), 1.1);
      else if (pick < 0.74) this.kit('town', 'lantern', px, y, pz, rng.range(0, 6));
      else if (pick < 0.86) this.kit('town', 'hedge', px, y, pz, rng.range(0, 6));
      else this.kit('town', rng.pick(['tree', 'tree-high', 'tree-crooked']), px, y, pz, rng.range(0, 6), rng.range(0.8, 1.3));
    }
    // perimeter palisade
    const fenceN = Math.floor((Math.PI * 2 * R) / 7);
    for (let i = 0; i < fenceN; i++) {
      const a = (i / fenceN) * Math.PI * 2;
      const fx = cx + Math.cos(a) * (R + 4), fz = cz + Math.sin(a) * (R + 4);
      if (Math.hypot(fx - cx, fz - cz) < 14) continue;
      this.kit('props', 'fence', fx, this.groundY(fx, fz), fz, a + Math.PI / 2, 1.15);
    }
    return {
      kind: 'village',
      buildings: houses,
      npcSpots: houses.slice(0, 6).map((h) => ({ x: h.x + Math.cos(h.rot) * (h.w * 0.5 + 1.5), z: h.z - Math.sin(h.rot) * (h.w * 0.5 + 1.5), y: h.y })),
      merchant: { x: cx + 6, z: cz + 6, y: gy },
      workbench: { x: cx - 8, z: cz - 5, y: gy },
      center: { x: cx, z: cz, y: gy },
    };
  }

  /* -------------------------------------------------------------- temple --- */
  buildTemple(B, poi, rng) {
    this.beginPOI(poi);
    const cx = poi.x, cz = poi.z, gy = this.groundY(cx, cz);
    const rot = poi.rot;
    const W = 22, D = 30;
    // platform + steps
    for (let i = 0; i < 3; i++) {
      const s = 1.4;
      B.add('stoneblock', makeBox(W + 6 - i * s * 2, 0.55, D + 6 - i * s * 2, 0.35), { x: cx, y: gy - 0.1 + i * 0.5, z: cz }, rot);
    }
    const py = gy + 1.4;
    B.add('marble', makeBox(W + 2, 0.5, D + 2, 0.3), { x: cx, y: py, z: cz }, rot);
    this.addCollider(cx, cz, (W + 6) / 2, (D + 6) / 2, gy, py + 0.6, rot);
    this.addFloor(cx, cz, (W + 6) / 2, (D + 6) / 2, py + 0.6, rot);

    // steps front
    for (let i = 0; i < 5; i++) {
      const c = Math.cos(rot), s = Math.sin(rot);
      const oz = D / 2 + 3 - i * 0.9;
      B.add('stoneblock', makeBox(9, 0.32, 0.9, 0.4), { x: cx + oz * s, y: gy + 0.15 + i * 0.3, z: cz + oz * c }, rot);
    }

    // columns
    const cols = 6, rows = 4;
    const colH = 7.5;
    for (let r = 0; r < rows; r++) {
      for (let cI = 0; cI < cols; cI++) {
        if (r > 0 && r < rows - 1 && cI > 0 && cI < cols - 1) continue; // hollow interior
        const lx = -W / 2 + 1.6 + (cI / (cols - 1)) * (W - 3.2);
        const lz = -D / 2 + 2 + (r / (rows - 1)) * (D - 4);
        const cc = Math.cos(rot), ss = Math.sin(rot);
        const wx = cx + lx * cc + lz * ss, wz = cz - lx * ss + lz * cc;
        B.add('marble', makeCylinder(0.62, 0.72, colH, 14, 0.6), { x: wx, y: py + 0.25 + colH / 2, z: wz }, 0);
        B.add('marble', makeBox(1.6, 0.35, 1.6, 0.5), { x: wx, y: py + 0.25, z: wz }, rot);
        B.add('marble', makeBox(1.7, 0.45, 1.7, 0.5), { x: wx, y: py + 0.25 + colH, z: wz }, rot);
      }
    }
    // entablature + pediment + roof
    B.add('marble', makeBox(W + 1, 1.1, D + 1, 0.35), { x: cx, y: py + colH + 0.9, z: cz }, rot);
    B.add('roof', makeBox(W + 3, 0.3, D + 3, 0.35), { x: cx, y: py + colH + 1.6, z: cz }, rot);
    // altar + statue
    B.add('marble', makeBox(4, 1.2, 2.4, 0.5), { x: cx, y: py + 0.5, z: cz }, rot);
    this.kit('graveyard', 'pillar-obelisk', cx, py + 1.7, cz - D / 2 + 4, rot + Math.PI, 0.9);
    this.kit('graveyard', 'altar-stone', cx, py + 0.5, cz + 2, rot, 0.8);
    // braziers
    for (const side of [-1, 1]) {
      const cc = Math.cos(rot), ss = Math.sin(rot);
      const wx = cx + side * (W / 2 - 1) * cc, wz = cz - side * (W / 2 - 1) * ss;
      this.kit('graveyard', 'fire-basket', wx, py + 0.5, wz, 0, 0.7);
      this.lights.push({ x: wx, y: py + 1.4, z: wz, color: 0xff8a3c, intensity: 6, distance: 16, type: 'fire' });
    }
    return {
      kind: 'temple', center: { x: cx, z: cz, y: py },
      npcSpots: [{ x: cx + 5, z: cz + 8, y: py }],
      seal: { x: cx, z: cz, y: py + 1.7 },
    };
  }

  /* -------------------------------------------------------------- palace --- */
  buildPalace(B, poi, rng) {
    this.beginPOI(poi);
    const cx = poi.x, cz = poi.z, gy = this.groundY(cx, cz);
    const rot = poi.rot;
    const S = 46; // courtyard half size
    B.add('cobble', makeBox(S * 2, 0.4, S * 2, 0.3), { x: cx, y: gy + 0.05, z: cz }, rot);
    this.addFloor(cx, cz, S, S, gy + 0.3, rot);

    // curtain walls
    const spacing = 3.4;
    const perSide = Math.floor((S * 2) / spacing);
    for (let i = 0; i < perSide; i++) {
      const u = -S + (i + 0.5) * spacing;
      for (const [dx, dz, ang] of [[-S, u, Math.PI / 2], [S, u, Math.PI / 2], [u, -S, 0], [u, S, 0]]) {
        const cc = Math.cos(rot), ss = Math.sin(rot);
        const wx = cx + dx * cc + dz * ss, wz = cz - dx * ss + dz * cc;
        if (Math.abs(u) < 7 && (Math.abs(dx) > S - 1 || Math.abs(dz) > S - 1)) continue; // gate gap
        this.kit('castle', 'wall', wx, this.groundY(wx, wz), wz, rot + ang, 1.35);
      }
    }
    // corner towers
    for (const [dx, dz] of [[-S, -S], [S, -S], [-S, S], [S, S]]) {
      const cc = Math.cos(rot), ss = Math.sin(rot);
      const wx = cx + dx * cc + dz * ss, wz = cz - dx * ss + dz * cc;
      const y = this.groundY(wx, wz);
      const seg = KIT_SCALE * 1.15;
      this.kit('castle', 'tower-square-base', wx, y, wz, rot, 1.15);
      this.kit('castle', 'tower-square-mid', wx, y, wz, rot, 1.15, seg);
      this.kit('castle', 'tower-square-mid-windows', wx, y, wz, rot, 1.15, seg * 2);
      this.kit('castle', 'tower-square-top', wx, y, wz, rot, 1.15, seg * 3);
      this.kit('castle', 'tower-square-roof', wx, y, wz, rot, 1.15, seg * 4);
      this.kit('castle', 'flag', wx, y, wz, rot, 1.15, seg * 5.2);
      this.addCollider(wx, wz, 4.5, 4.5, y, y + seg * 5);
    }
    // gatehouse on the +Z face
    const gx = cx + S * Math.sin(rot), gz = cz + S * Math.cos(rot);
    this.kit('castle', 'gate', gx, this.groundY(gx, gz), gz, rot, 1.5);
    this.kit('castle', 'tower-square-base', gx - 6 * Math.cos(rot), this.groundY(gx, gz), gz + 6 * Math.sin(rot), rot, 1.15);
    this.kit('castle', 'tower-square-base', gx + 6 * Math.cos(rot), this.groundY(gx, gz), gz - 6 * Math.sin(rot), rot, 1.15);

    // keep (procedural marble hall)
    const KW = 34, KD = 26, KH = 12;
    B.add('stoneblock', makeBox(KW + 4, 1.6, KD + 4, 0.3), { x: cx, y: gy, z: cz }, rot);
    B.add('marble', makeBox(KW, KH, KD, 0.28), { x: cx, y: gy + 0.8 + KH / 2, z: cz }, rot);
    B.add('roof', makeBox(KW + 3, 0.6, KD + 3, 0.3), { x: cx, y: gy + 0.8 + KH, z: cz }, rot);
    this.addCollider(cx, cz, KW / 2, KD / 2, gy, gy + KH + 1, rot);
    this.addFloor(cx, cz, KW / 2, KD / 2, gy + KH, rot);
    // throne hall columns + banners
    for (let i = 0; i < 8; i++) {
      const lx = -KW / 2 + 2 + (i % 4) * (KW - 4) / 3;
      const lz = i < 4 ? KD / 2 + 2.5 : -KD / 2 - 2.5;
      const cc = Math.cos(rot), ss = Math.sin(rot);
      const wx = cx + lx * cc + lz * ss, wz = cz - lx * ss + lz * cc;
      B.add('marble', makeCylinder(0.8, 0.9, 10, 16, 0.5), { x: wx, y: gy + 1.6 + 5, z: wz }, 0);
    }
    for (let i = 0; i < 6; i++) {
      const lx = -KW / 2 - 1 + i * ((KW + 2) / 5);
      const cc = Math.cos(rot), ss = Math.sin(rot);
      const wx = cx + lx * cc + (KD / 2 + 1) * ss, wz = cz - lx * ss + (KD / 2 + 1) * cc;
      this.kit('castle', rng.pick(['flag-banner-long', 'flag-banner-short', 'flag']), wx, gy + 1.6, wz, rot, 0.9);
    }
    // inner courtyard props
    for (let i = 0; i < 18; i++) {
      const a = rng.range(0, 6.28), rad = rng.range(20, S - 8);
      const px = cx + Math.cos(a) * rad, pz = cz + Math.sin(a) * rad;
      const y = this.groundY(px, pz);
      this.kit('props', rng.pick(['barrel', 'box', 'box-large', 'resource-stone']), px, y, pz, rng.range(0, 6), 1.2);
    }
    return {
      kind: 'palace', center: { x: cx, z: cz, y: gy },
      npcSpots: [{ x: cx, z: cz + 20, y: gy }, { x: cx + 14, z: cz - 10, y: gy }],
      throne: { x: cx, z: cz - 6, y: gy + 1.6 },
    };
  }

  /* ----------------------------------------------------------- monastery --- */
  buildMonastery(B, poi, rng) {
    this.beginPOI(poi);
    const cx = poi.x, cz = poi.z, gy = this.groundY(cx, cz), rot = poi.rot;
    const W = 40, D = 40;
    B.add('stoneblock', makeBox(W, 0.6, D, 0.35), { x: cx, y: gy, z: cz }, rot);
    // cloister: four ranges of buildings
    for (const [ox, oz, w, d] of [[0, -D / 2 + 6, W, 11], [0, D / 2 - 6, W, 11], [-W / 2 + 6, 0, 11, D - 22], [W / 2 - 6, 0, 11, D - 22]]) {
      const cc = Math.cos(rot), ss = Math.sin(rot);
      const wx = cx + ox * cc + oz * ss, wz = cz - ox * ss + oz * cc;
      const y = this.groundY(wx, wz);
      this.buildHouse(B, poi, rng, wx, wz, rot + (w > d ? 0 : Math.PI / 2), { w, d, wallH: 4.2, floors: 2, style: 0 });
    }
    // bell tower
    const bx = cx + 0 * Math.cos(rot) + (D / 2 - 4) * Math.sin(rot);
    const bz = cz + (D / 2 - 4) * Math.cos(rot);
    B.add('stoneblock', makeBox(7, 20, 7, 0.4), { x: bx, y: gy + 10, z: bz }, rot);
    B.add('roof', makeBox(9, 0.5, 9, 0.4), { x: bx, y: gy + 20, z: bz }, rot);
    this.addCollider(bx, bz, 4, 4, gy, gy + 21);
    for (let i = 0; i < 8; i++) {
      const a = rng.range(0, 6.28), rad = rng.range(4, 16);
      const px = cx + Math.cos(a) * rad, pz = cz + Math.sin(a) * rad;
      this.kit('graveyard', 'candle', px, this.groundY(px, pz) + 0.4, pz, 0, 0.5);
    }
    return { kind: 'monastery', center: { x: cx, z: cz, y: gy }, npcSpots: [{ x: cx, z: cz, y: gy }] };
  }

  /* ------------------------------------------------------------- outpost --- */
  buildOutpost(B, poi, rng) {
    this.beginPOI(poi);
    const cx = poi.x, cz = poi.z, gy = this.groundY(cx, cz);
    B.add('dirt', makeBox(30, 0.25, 30, 0.45), { x: cx, y: gy + 0.02, z: cz }, 0);
    // watch tower
    const th = 9;
    for (const [ox, oz] of [[-2.2, -2.2], [2.2, -2.2], [-2.2, 2.2], [2.2, 2.2]]) {
      B.add('planks', makeBox(0.45, th, 0.45, 0.5), { x: cx + ox, y: gy + th / 2, z: cz + oz }, 0);
    }
    B.add('planks', makeBox(6.2, 0.35, 6.2, 0.45), { x: cx, y: gy + th, z: cz }, 0);
    B.add('planks', makeBox(6.6, 0.9, 6.6, 0.45), { x: cx, y: gy + th + 1.6, z: cz }, 0);
    B.add('roof', makeBox(7.6, 0.3, 7.6, 0.4), { x: cx, y: gy + th + 3.4, z: cz }, 0);
    this.addCollider(cx, cz, 3.2, 3.2, gy, gy + th + 3.6);
    // palisade
    const R = 14;
    const n = Math.floor((Math.PI * 2 * R) / 3.4);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      if (Math.abs(a - Math.PI / 2) < 0.2) continue; // gate
      const px = cx + Math.cos(a) * R, pz = cz + Math.sin(a) * R;
      this.kit('props', 'fence-fortified', px, this.groundY(px, pz), pz, a + Math.PI / 2, 1.1);
    }
    // camp + supplies
    this.kit('props', 'campfire-pit', cx - 6, this.groundY(cx - 6, cz - 6), cz - 6, 0, 1.4);
    this.lights.push({ x: cx - 6, y: this.groundY(cx - 6, cz - 6) + 1.2, z: cz - 6, color: 0xff8a3c, intensity: 5, distance: 14, type: 'fire' });
    for (let i = 0; i < 6; i++) {
      const a = rng.range(0, 6.28), rad = rng.range(4, 10);
      const px = cx + Math.cos(a) * rad, pz = cz + Math.sin(a) * rad;
      this.kit('props', rng.pick(['barrel', 'box', 'resource-wood', 'bedroll']), px, this.groundY(px, pz), pz, rng.range(0, 6), 1.2);
    }
    this.kit('props', 'workbench', cx + 5, this.groundY(cx + 5, cz + 5), cz + 5, 0, 1.1);
    return { kind: 'outpost', center: { x: cx, z: cz, y: gy }, npcSpots: [{ x: cx + 4, z: cz + 4, y: gy }], workbench: { x: cx + 5, z: cz + 5, y: this.groundY(cx + 5, cz + 5) } };
  }

  /* --------------------------------------------------------------- ruins --- */
  buildRuins(B, poi, rng) {
    this.beginPOI(poi);
    const cx = poi.x, cz = poi.z, gy = this.groundY(cx, cz), rot = poi.rot;
    const W = rng.range(16, 26), D = rng.range(12, 20);
    B.add('stoneblock', makeBox(W + 3, 0.4, D + 3, 0.35), { x: cx, y: gy, z: cz }, rot);
    // broken walls
    for (let i = 0; i < 4; i++) {
      const side = i;
      const len = side < 2 ? W : D;
      const ang = rot + (side < 2 ? (side ? Math.PI : 0) : (side === 2 ? Math.PI / 2 : -Math.PI / 2));
      const oz = side < 2 ? (side ? -D / 2 : D / 2) : 0;
      const ox = side < 2 ? 0 : (side === 2 ? W / 2 : -W / 2);
      const cc = Math.cos(rot), ss = Math.sin(rot);
      const wx = cx + ox * cc + oz * ss, wz = cz - ox * ss + oz * cc;
      const segs = Math.max(2, Math.floor(len / 3));
      for (let k = 0; k < segs; k++) {
        if (rng.bool(0.35)) continue;
        const u = (k + 0.5) * (len / segs) - len / 2;
        const h = rng.range(1.2, 5.4);
        const px = wx + u * Math.cos(ang), pz = wz - u * Math.sin(ang);
        this.addWallWithOpenings(B, 'stoneblock', len / segs - 0.3, h, 0.9, rng.bool(0.4) ? [{ u: (len / segs) * 0.3, v: h * 0.35, w: 1.1, h: 1.6 }] : [], px, this.groundY(px, pz), pz, ang, 0.35);
      }
    }
    // fallen columns
    for (let i = 0; i < rng.int(3, 7); i++) {
      const a = rng.range(0, 6.28), rad = rng.range(2, Math.max(W, D) * 0.5);
      const px = cx + Math.cos(a) * rad, pz = cz + Math.sin(a) * rad;
      const d = new THREE.Object3D();
      d.position.set(px, this.groundY(px, pz) + 0.7, pz);
      d.rotation.set(Math.PI / 2, rng.range(0, 6.28), 0);
      d.updateMatrix();
      B.addM('marble', makeCylinder(0.55, 0.6, rng.range(3, 7), 12, 0.5), d.matrix);
    }
    for (let i = 0; i < rng.int(4, 9); i++) {
      const a = rng.range(0, 6.28), rad = rng.range(3, Math.max(W, D) * 0.6);
      const px = cx + Math.cos(a) * rad, pz = cz + Math.sin(a) * rad;
      this.kit('graveyard', rng.pick(['debris', 'debris-wood', 'gravestone-broken', 'gravestone-debris']), px, this.groundY(px, pz), pz, rng.range(0, 6), 1.3);
    }
    return { kind: 'ruins', center: { x: cx, z: cz, y: gy }, npcSpots: [], loot: { x: cx, z: cz, y: gy } };
  }

  /* ---------------------------------------------------------------- camp --- */
  buildCamp(B, poi, rng) {
    this.beginPOI(poi);
    const cx = poi.x, cz = poi.z, gy = this.groundY(cx, cz);
    B.add('dirt', makeBox(poi.radius * 2, 0.22, poi.radius * 2, 0.5), { x: cx, y: gy + 0.02, z: cz }, 0);
    const tents = rng.int(2, 4);
    for (let i = 0; i < tents; i++) {
      const a = rng.range(0, 6.28), rad = rng.range(2, poi.radius * 0.6);
      const px = cx + Math.cos(a) * rad, pz = cz + Math.sin(a) * rad;
      this.kit('props', rng.pick(['tent', 'tent-canvas', 'structure-canvas']), px, this.groundY(px, pz), pz, rng.range(0, 6), 1.6);
    }
    this.kit('props', 'campfire-pit', cx, gy, cz, 0, 1.5);
    this.lights.push({ x: cx, y: gy + 1.1, z: cz, color: 0xff8a3c, intensity: 5.5, distance: 15, type: 'fire' });
    for (let i = 0; i < rng.int(3, 7); i++) {
      const a = rng.range(0, 6.28), rad = rng.range(1.5, poi.radius * 0.8);
      const px = cx + Math.cos(a) * rad, pz = cz + Math.sin(a) * rad;
      this.kit('props', rng.pick(['box', 'barrel', 'bedroll', 'resource-wood', 'resource-stone']), px, this.groundY(px, pz), pz, rng.range(0, 6), 1.2);
    }
    return { kind: 'camp', center: { x: cx, z: cz, y: gy }, npcSpots: [{ x: cx + 2, z: cz + 2, y: gy }] };
  }

  /* -------------------------------------------------------------- shrine --- */
  buildShrine(B, poi, rng) {
    this.beginPOI(poi);
    const cx = poi.x, cz = poi.z, gy = this.groundY(cx, cz), rot = poi.rot;
    B.add('stoneblock', makeBox(8, 0.5, 8, 0.4), { x: cx, y: gy, z: cz }, rot);
    for (const [ox, oz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) {
      B.add('marble', makeCylinder(0.32, 0.36, 3.2, 10, 0.7), { x: cx + ox, y: gy + 0.5 + 1.6, z: cz + oz }, 0);
      B.add('marble', makeBox(0.9, 0.25, 0.9, 0.5), { x: cx + ox, y: gy + 0.5 + 3.2, z: cz + oz }, rot);
    }
    B.add('roof', makeBox(8.4, 0.35, 8.4, 0.4), { x: cx, y: gy + 0.5 + 3.6, z: cz }, rot);
    B.add('marble', makeBox(2.4, 1.1, 1.4, 0.6), { x: cx, y: gy + 0.5 + 0.55, z: cz }, rot);
    this.kit('graveyard', 'pillar-obelisk', cx, gy + 1.6, cz, rot, 0.5);
    this.kit('graveyard', 'candle-multiple', cx + 1, gy + 1.8, cz + 0.4, rot, 0.5);
    this.lights.push({ x: cx, y: gy + 2.4, z: cz, color: 0xffb066, intensity: 2.2, distance: 8, type: 'fire' });
    return { kind: 'shrine', center: { x: cx, z: cz, y: gy }, npcSpots: [] };
  }

  /* ---------------------------------------------------------- crash site --- */
  buildCrashSite() {
    const c = this.world.crater;
    const rng = new Rng(90210);
    const B = new PartBuilder();
    this.beginPOI(c);
    const cy = this.world.heightAt(c.x, c.z);
    // meteor fragments
    for (let i = 0; i < 14; i++) {
      const a = rng.range(0, 6.28), rad = rng.range(c.radius * 0.15, c.radius * 1.5);
      const px = c.x + Math.cos(a) * rad, pz = c.z + Math.sin(a) * rad;
      const y = this.world.heightAt(px, pz);
      const s = rng.range(1.2, 4.5);
      const d = new THREE.Object3D();
      d.position.set(px, y + s * 0.3, pz);
      d.rotation.set(rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0, 6.28));
      d.scale.set(s, s * rng.range(0.6, 1.2), s);
      d.updateMatrix();
      B.addM('stone', new THREE.IcosahedronGeometry(1, 0), d.matrix);
    }
    // the core
    const d = new THREE.Object3D();
    d.position.set(c.x, cy + 3.2, c.z);
    d.rotation.set(0.3, 0.7, 0.2);
    d.scale.setScalar(4.2);
    d.updateMatrix();
    B.addM('ember', new THREE.IcosahedronGeometry(1.2, 1), d.matrix);
    B.finish(this.group, this.mats);
    this.crash = { x: c.x, y: cy, z: c.z, radius: c.radius };
  }

  /* --------------------------------------------------------------- roads --- */
  buildRoads() {
    const B = new PartBuilder();
    this.beginPOI('__roads');
    const world = this.world;
    for (const road of world.roads) {
      const pts = road.pts, n = road.count;
      for (let i = 0; i < n - 1; i++) {
        const x0 = pts[i * 4], z0 = pts[i * 4 + 1], y0 = pts[i * 4 + 2];
        const x1 = pts[(i + 1) * 4], z1 = pts[(i + 1) * 4 + 1], y1 = pts[(i + 1) * 4 + 2];
        const w = pts[i * 4 + 3];
        const dx = x1 - x0, dz = z1 - z0;
        const len = Math.hypot(dx, dz);
        if (len < 0.1) continue;
        const ang = Math.atan2(dz, dx);
        const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
        const my = world.heightAt(mx, mz);
        // road slab (slightly wider, sunk a touch to avoid z-fighting)
        B.add('dirt', makeBox(len + 0.6, 0.3, w * 2, 0.35), { x: mx, y: my + 0.06, z: mz }, -ang);
      }
      // bridges where the road crosses a river
      for (let i = 2; i < n - 2; i++) {
        const x = pts[i * 4], z = pts[i * 4 + 1];
        const rv = world.riverAt(x, z);
        if (rv > 0.55 && !this._bridgePlaced?.has(`${Math.round(x / 30)},${Math.round(z / 30)}`)) {
          (this._bridgePlaced ||= new Set()).add(`${Math.round(x / 30)},${Math.round(z / 30)}`);
          const ang = Math.atan2(pts[(i + 1) * 4 + 1] - z, pts[(i + 1) * 4] - x);
          const y = world.heightAt(x, z);
          this.kit('nat', 'bridge_wood', x, y + 0.4, z, -ang, 1.9);
          this.kit('nat', 'bridge_wood', x + Math.cos(ang) * 5.2, world.heightAt(x + Math.cos(ang) * 5.2, z + Math.sin(ang) * 5.2) + 0.4, z + Math.sin(ang) * 5.2, -ang, 1.9);
        }
      }
    }
    const holder = new THREE.Group();
    holder.name = 'roads';
    B.finish(holder, this.mats);
    this.finishKits(holder, '__roads');
    this.group.add(holder);
  }

  /** OBB collision query: returns the push-out vector for a circle at (x,z) */
  resolveCollisions(x, z, radius, out = null) {
    let px = 0, pz = 0;
    for (const b of this.colliders) {
      // transform into box space
      const c = Math.cos(-b.rot), s = Math.sin(-b.rot);
      const dx = x - b.x, dz = z - b.z;
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      const ex = b.hw + radius, ez = b.hd + radius;
      if (Math.abs(lx) < ex && Math.abs(lz) < ez) {
        // push out along the smallest penetration axis
        const ox = ex - Math.abs(lx);
        const oz = ez - Math.abs(lz);
        let wx = 0, wz = 0;
        if (ox < oz) wx = (lx >= 0 ? 1 : -1) * ox;
        else wz = (lz >= 0 ? 1 : -1) * oz;
        const c2 = Math.cos(b.rot), s2 = Math.sin(b.rot);
        px += wx * c2 - wz * s2;
        pz += wx * s2 + wz * c2;
      }
    }
    if (out) { out.x = px; out.z = pz; return out; }
    return { x: px, z: pz };
  }

  /** highest walkable structure surface under (x,z) below y — floors, bridges, ramps */
  floorAt(x, z, y = 1e9) {
    let best = -Infinity;
    for (const f of this.floors || []) {
      if (y < f.y - 0.6) continue;
      const c = Math.cos(-f.rot), s = Math.sin(-f.rot);
      const dx = x - f.x, dz = z - f.z;
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) < f.hw && Math.abs(lz) < f.hd && f.y > best && f.y <= y + 1.2) best = f.y;
    }
    return best;
  }

  /** ray vs the structure OBBs within [t0, t0+len]; returns {distance, point, normal} */
  rayBoxes(origin, dir, t0, len) {
    let best = null;
    const t1 = t0 + len;
    for (const b of this.colliders) {
      const c = Math.cos(-b.rot), s = Math.sin(-b.rot);
      const ox = origin.x - b.x, oz = origin.z - b.z;
      const lox = ox * c - oz * s, loz = ox * s + oz * c;
      const ldx = dir.x * c - dir.z * s, ldz = dir.x * s + dir.z * c;
      // slab test in 3D (y is axis aligned)
      let tmin = t0, tmax = t1, axis = -1, sign = 1;
      const test = (o, d, lo, hi, ax) => {
        if (Math.abs(d) < 1e-6) return (o >= lo && o <= hi);
        let n = (lo - o) / d, f = (hi - o) / d, sg = -1;
        if (n > f) { const tmp = n; n = f; f = tmp; sg = 1; }
        if (n > tmin) { tmin = n; axis = ax; sign = sg; }
        if (f < tmax) tmax = f;
        return tmax >= tmin;
      };
      if (!test(lox, ldx, -b.hw, b.hw, 0)) continue;
      if (!test(loz, ldz, -b.hd, b.hd, 1)) continue;
      if (!test(origin.y, dir.y, b.y0, b.y1, 2)) continue;
      if (tmin < t0 || tmin > t1) continue;
      if (!best || tmin < best.distance) {
        const p = new THREE.Vector3(origin.x + dir.x * tmin, origin.y + dir.y * tmin, origin.z + dir.z * tmin);
        const n = new THREE.Vector3();
        if (axis === 0) { n.set(sign, 0, 0); const cc = Math.cos(b.rot), ss = Math.sin(b.rot); n.set(sign * cc, 0, sign * ss); }
        else if (axis === 1) { const cc = Math.cos(b.rot), ss = Math.sin(b.rot); n.set(-sign * ss, 0, sign * cc); }
        else n.set(0, sign, 0);
        best = { distance: tmin, point: p, normal: n.normalize(), kind: 'stone' };
      }
    }
    return best;
  }

  /** is the point inside a building footprint? (used to block spawning) */
  insideBuilding(x, z, y) {
    for (const b of this.colliders) {
      if (y < b.y0 - 1 || y > b.y1 + 3) continue;
      const c = Math.cos(-b.rot), s = Math.sin(-b.rot);
      const dx = x - b.x, dz = z - b.z;
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) < b.hw && Math.abs(lz) < b.hd) return true;
    }
    return false;
  }
}
