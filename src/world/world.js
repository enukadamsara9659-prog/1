// Main-thread world: runs the generation worker and exposes fast sampling.
import * as THREE from 'three';
import { WORLD, BIOME } from './constants.js';

const N = WORLD.N;

export class World {
  constructor(renderer) {
    this.renderer = renderer;
    this.height = null;
    this.splat = null;
    this.mask = null;
    this.rivers = [];
    this.roads = [];
    this.pois = [];
    this.nests = [];
    this.veg = {};
    this.crater = null;
    this.start = { x: 0, y: 0, z: 0 };
  }

  generate(seed, onProgress = () => {}) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./worldgen.worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === 'progress') { onProgress(msg.pct, msg.stage); return; }
        if (msg.type === 'error') { reject(new Error(msg.message)); worker.terminate(); return; }
        const d = msg.data;
        this.height = d.h;
        this.splat = d.splat;
        this.mask = d.mask;
        this.rivers = d.rivers;
        this.roads = d.roads;
        this.pois = d.pois;
        this.nests = d.nests;
        this.veg = d.veg;
        this.crater = d.crater;
        this.start = d.start;
        this.seed = d.seed;
        this.buildTextures();
        console.log(`[world] generated in ${d.time} ms — ${this.pois.length} POIs, ${this.nests.length} nests`);
        worker.terminate();
        resolve(this);
      };
      worker.onerror = (err) => { reject(err); worker.terminate(); };
      worker.postMessage({ seed });
    });
  }

  buildTextures() {
    const renderer = this.renderer;
    const canLinearFloat = renderer.extensions.has('OES_texture_float_linear');

    // ---- heightmap
    let heightTex;
    if (canLinearFloat) {
      heightTex = new THREE.DataTexture(this.height, N, N, THREE.RedFormat, THREE.FloatType);
      heightTex.minFilter = THREE.LinearFilter;
      heightTex.magFilter = THREE.LinearFilter;
    } else {
      const half = new Uint16Array(N * N);
      for (let i = 0; i < N * N; i++) half[i] = THREE.DataUtils.toHalfFloat(this.height[i]);
      heightTex = new THREE.DataTexture(half, N, N, THREE.RedFormat, THREE.HalfFloatType);
      heightTex.minFilter = THREE.LinearFilter;
      heightTex.magFilter = THREE.LinearFilter;
    }
    heightTex.wrapS = heightTex.wrapT = THREE.ClampToEdgeWrapping;
    heightTex.generateMipmaps = false;
    heightTex.needsUpdate = true;
    this.heightTex = heightTex;

    // ---- splat + mask
    const mk = (data) => {
      const t = new THREE.DataTexture(data, WORLD.SPLAT_N, WORLD.SPLAT_N, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      return t;
    };
    this.splatTex = mk(this.splat);
    this.maskTex = mk(this.mask);
  }

  // --------------------------------------------------------------- sampling
  heightAt(x, z) {
    const h = this.height;
    if (!h) return 0;
    let fx = x / WORLD.CELL + (N - 1) / 2;
    let fz = z / WORLD.CELL + (N - 1) / 2;
    fx = Math.max(0, Math.min(N - 1.001, fx));
    fz = Math.max(0, Math.min(N - 1.001, fz));
    const i = fx | 0, j = fz | 0;
    const tx = fx - i, tz = fz - j;
    const h00 = h[j * N + i], h10 = h[j * N + i + 1];
    const h01 = h[(j + 1) * N + i], h11 = h[(j + 1) * N + i + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  normalAt(x, z, out = new THREE.Vector3()) {
    const c = WORLD.CELL;
    const hl = this.heightAt(x - c, z), hr = this.heightAt(x + c, z);
    const hd = this.heightAt(x, z - c), hu = this.heightAt(x, z + c);
    return out.set(hl - hr, 2 * c, hd - hu).normalize();
  }

  slopeAt(x, z) {
    const c = WORLD.CELL;
    const hl = this.heightAt(x - c, z), hr = this.heightAt(x + c, z);
    const hd = this.heightAt(x, z - c), hu = this.heightAt(x, z + c);
    return Math.hypot(hr - hl, hu - hd) / (2 * c);
  }

  /** 0..1 moisture */
  moistureAt(x, z) {
    const i = Math.floor(x / WORLD.SPLAT_CELL + (WORLD.SPLAT_N - 1) / 2);
    const j = Math.floor(z / WORLD.SPLAT_CELL + (WORLD.SPLAT_N - 1) / 2);
    if (!this.mask || i < 0 || j < 0 || i >= WORLD.SPLAT_N || j >= WORLD.SPLAT_N) return 0.5;
    return this.mask[(j * WORLD.SPLAT_N + i) * 4 + 3] / 255;
  }

  /** 0..1 distance-to-river factor */
  riverAt(x, z) {
    const i = Math.floor(x / WORLD.SPLAT_CELL + (WORLD.SPLAT_N - 1) / 2);
    const j = Math.floor(z / WORLD.SPLAT_CELL + (WORLD.SPLAT_N - 1) / 2);
    if (!this.mask || i < 0 || j < 0 || i >= WORLD.SPLAT_N || j >= WORLD.SPLAT_N) return 0;
    return this.mask[(j * WORLD.SPLAT_N + i) * 4 + 1] / 255;
  }

  scorchAt(x, z) {
    const i = Math.floor(x / WORLD.SPLAT_CELL + (WORLD.SPLAT_N - 1) / 2);
    const j = Math.floor(z / WORLD.SPLAT_CELL + (WORLD.SPLAT_N - 1) / 2);
    if (!this.mask || i < 0 || j < 0 || i >= WORLD.SPLAT_N || j >= WORLD.SPLAT_N) return 0;
    return this.mask[(j * WORLD.SPLAT_N + i) * 4 + 2] / 255;
  }

  biomeAt(x, z) {
    const h = this.heightAt(x, z);
    const slope = this.slopeAt(x, z);
    const m = this.moistureAt(x, z);
    if (h < -0.5) return BIOME.OCEAN;
    if (h < 3 && slope < 0.15) return BIOME.BEACH;
    if (h > WORLD.SNOW_LINE + 40) return BIOME.SNOW;
    if (slope > 0.55 || h > WORLD.TREE_LINE) return BIOME.ROCK;
    if (this.scorchAt(x, z) > 0.35) return BIOME.ASH;
    if (m > 0.55) return BIOME.FOREST;
    if (m > 0.35) return BIOME.PLAINS;
    return BIOME.SAVANNA;
  }

  /** nearest road distance (approximate, uses road polylines) */
  roadDistance(x, z) {
    let best = Infinity;
    for (const r of this.roads) {
      const p = r.pts;
      for (let i = 0; i < r.count - 1; i++) {
        const ax = p[i * 4], az = p[i * 4 + 1];
        const bx = p[(i + 1) * 4], bz = p[(i + 1) * 4 + 1];
        const dx = bx - ax, dz = bz - az;
        const l2 = dx * dx + dz * dz;
        let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + dx * t, pz = az + dz * t;
        const d = Math.hypot(x - px, z - pz);
        if (d < best) best = d;
      }
    }
    return best;
  }

  poiAt(x, z) {
    for (const p of this.pois) if (Math.hypot(x - p.x, z - p.z) < p.radius) return p;
    return null;
  }

  dispose() {
    this.heightTex?.dispose();
    this.splatTex?.dispose();
    this.maskTex?.dispose();
  }
}
