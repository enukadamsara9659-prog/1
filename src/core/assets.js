// Asset loading: manifest driven, concurrent, progress reporting.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import settings from './settings.js';

const MAX_PARALLEL = 12;

/**
 * Manifest paths are relative to public/assets/ (e.g. "tex/terrain/grass_color.jpg").
 * Resolve them against the app base so they work on any host / sub-path. Absolute
 * URLs and paths that already start with "/" or "assets/" are left alone.
 */
export function assetUrl(p) {
  if (!p || /^(https?:|blob:|data:)/.test(p) || p.startsWith('/')) return p;
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  return base + (p.startsWith('assets/') ? p : 'assets/' + p);
}

/**
 * Put a freshly loaded / cloned skinned model into its bind pose and refresh the
 * bone matrices. Without this, Box3.setFromObject() measures skinned meshes against
 * all-zero bone matrices and collapses to a point (characters end up 10x too big).
 */
export function prepSkins(root) {
  root.traverse((o) => {
    if (o.isSkinnedMesh && o.skeleton) {
      o.skeleton.pose();
      o.skeleton.update();
      o.boundingBox = null;
      o.boundingSphere = null;
    }
  });
  root.updateMatrixWorld(true);
  return root;
}

class Assets {
  constructor() {
    this.manifest = null;
    this.textures = new Map();
    this.models = new Map();   // "group/name" -> gltf
    this.hdr = new Map();
    this.gltfLoader = new GLTFLoader();
    this.stats = { loaded: 0, total: 0 };
  }

  async loadManifest(url = 'assets/manifest.json') {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`manifest ${url} -> HTTP ${res.status}`);
    this.manifest = await res.json();
    return this.manifest;
  }

  async loadAll(onProgress = () => {}) {
    const m = this.manifest;
    const jobs = [];

    // ---- textures -----------------------------------------------------------
    const texJobs = [];
    const addTex = (key, path, colorSpace) => texJobs.push({ key, path, colorSpace });
    for (const [layer, maps] of Object.entries(m.tex.terrain || {})) {
      addTex(`terrain.${layer}.color`, maps.color, THREE.SRGBColorSpace);
      addTex(`terrain.${layer}.nr`, maps.nr, THREE.NoColorSpace);
    }
    for (const [layer, maps] of Object.entries(m.tex.surf || {})) {
      addTex(`surf.${layer}.color`, maps.color, THREE.SRGBColorSpace);
      addTex(`surf.${layer}.nr`, maps.nr, THREE.NoColorSpace);
    }
    if (m.waternormals) addTex('waternormals', m.waternormals, THREE.NoColorSpace);
    if (m.grassDetail) addTex('grassDetail', m.grassDetail, THREE.SRGBColorSpace);
    for (const [k, p] of Object.entries(m.sprites || {})) addTex('sprite.' + k, p, THREE.SRGBColorSpace);

    // ---- models -------------------------------------------------------------
    const modelJobs = [];
    for (const [group, map] of Object.entries(m.models || {})) {
      for (const [name, path] of Object.entries(map)) modelJobs.push({ group, name, path });
    }
    // ---- hdri ---------------------------------------------------------------
    const hdrJobs = Object.entries(m.env || {}).map(([name, path]) => ({ name, path }));

    this.stats.total = texJobs.length + modelJobs.length + hdrJobs.length;
    this.stats.loaded = 0;
    const tick = () => {
      this.stats.loaded++;
      onProgress(this.stats.loaded / this.stats.total, '');
    };

    const texLoader = new THREE.TextureLoader();
    const loadTex = (j) =>
      new Promise((resolve) => {
        texLoader.load(
          assetUrl(j.path),
          (t) => {
            t.colorSpace = j.colorSpace;
            t.wrapS = t.wrapT = THREE.RepeatWrapping;
            t.anisotropy = settings.q('anisotropy');
            t.generateMipmaps = true;
            t.minFilter = THREE.LinearMipmapLinearFilter;
            this.textures.set(j.key, t);
            tick(); resolve();
          },
          undefined,
          () => { console.warn('texture failed', j.path); tick(); resolve(); }
        );
      });

    const loadModel = (j) =>
      fetch(assetUrl(j.path))
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
        .then((buf) => new Promise((resolve) => {
          // resource path = the model's own folder, so "Textures/colormap.png" resolves
          const dir = assetUrl(j.path).replace(/[^/]*$/, '');
          this.gltfLoader.parse(buf, dir, (gltf) => {
            // drop animation tracks aimed at bones this rig does not have (finger tips etc.)
            for (const clip of gltf.animations) {
              clip.tracks = clip.tracks.filter((t) => gltf.scene.getObjectByName(t.name.slice(0, t.name.lastIndexOf('.'))));
            }
            gltf.scene.traverse((o) => {
              if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = true; }
            });
            prepSkins(gltf.scene);
            this.models.set(`${j.group}/${j.name}`, gltf);
            tick(); resolve();
          }, () => { console.warn('model failed', j.path); tick(); resolve(); });
        }))
        .catch((e) => { console.warn('model failed', j.path, e && e.message); tick(); });

    const loadHdr = (j) =>
      new Promise((resolve) => {
        new HDRLoader().load(assetUrl(j.path), (tex) => {
          tex.mapping = THREE.EquirectangularReflectionMapping;
          this.hdr.set(j.name, tex);
          tick(); resolve();
        }, undefined, () => { tick(); resolve(); });
      });

    // run with limited concurrency
    const queue = [
      ...texJobs.map((j) => () => loadTex(j)),
      ...modelJobs.map((j) => () => loadModel(j)),
      ...hdrJobs.map((j) => () => loadHdr(j)),
    ];
    // models first (biggest) for nicer progress ordering
    queue.sort((a, b) => 0);
    let idx = 0;
    const workers = new Array(MAX_PARALLEL).fill(0).map(async () => {
      while (idx < queue.length) {
        const job = queue[idx++];
        await job();
      }
    });
    await Promise.all(workers);
    onProgress(1, 'done');
  }

  tex(key) {
    const t = this.textures.get(key);
    if (!t) console.warn('missing texture', key);
    return t || null;
  }

/** raw gltf (shared) */
  gltf(group, name) { return this.models.get(`${group}/${name}`); }

  /** clone of a model (skeleton-safe) */
  model(group, name) {
    const g = this.gltf(group, name);
    if (!g) { console.warn('missing model', group, name); return new THREE.Group(); }
    const clone = SkeletonUtils.clone(g.scene);
    clone.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    return prepSkins(clone);
  }

  /** all names of a group */
  group(group) {
    const out = {};
    for (const key of this.models.keys()) {
      if (key.startsWith(group + '/')) out[key.slice(group.length + 1)] = this.models.get(key);
    }
    return out;
  }

  has(group, name) { return this.models.has(`${group}/${name}`); }
}

export const assets = new Assets();
export default assets;
