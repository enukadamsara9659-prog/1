// Runtime-generated tiling 3D noise texture (Perlin-Worley style) for clouds.
import * as THREE from 'three';
import { ImprovedNoise } from 'three/examples/jsm/math/ImprovedNoise.js';

export function makeCloudNoise(size = 64, seed = 7) {
  const perlin = new ImprovedNoise();
  const data = new Uint8Array(size * size * size * 4);
  const inv = 1 / size;

  // --- worley feature points (tiling grid)
  const CELLS = 4;
  const feat = new Float32Array(CELLS * CELLS * CELLS * 3);
  let s = seed;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < CELLS * CELLS * CELLS * 3; i++) feat[i] = rnd();

  const cellIndex = (i, j, k) => ((((i % CELLS) + CELLS) % CELLS) * CELLS + (((j % CELLS) + CELLS) % CELLS)) * CELLS + (((k % CELLS) + CELLS) % CELLS);

  function worley(x, y, z) {
    const fx = x * CELLS, fy = y * CELLS, fz = z * CELLS;
    const ci = Math.floor(fx), cj = Math.floor(fy), ck = Math.floor(fz);
    let minD = 1e9;
    for (let dk = -1; dk <= 1; dk++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const gi = ci + di, gj = cj + dj, gk = ck + dk;
          const id = cellIndex(gi, gj, gk) * 3;
          const px = (gi + feat[id]) * (1 / CELLS);
          const py = (gj + feat[id + 1]) * (1 / CELLS);
          const pz = (gk + feat[id + 2]) * (1 / CELLS);
          let dx = px - x, dy = py - y, dz = pz - z;
          if (dx > 0.5) dx -= 1; else if (dx < -0.5) dx += 1;
          if (dy > 0.5) dy -= 1; else if (dy < -0.5) dy += 1;
          if (dz > 0.5) dz -= 1; else if (dz < -0.5) dz += 1;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < minD) minD = d;
        }
      }
    }
    return Math.sqrt(minD);
  }

  const fbm = (x, y, z, oct) => {
    let a = 0.5, f = 1, sum = 0, norm = 0;
    for (let o = 0; o < oct; o++) {
      sum += a * perlin.noise(x * f, y * f, z * f);
      norm += a;
      a *= 0.5; f *= 2.03;
    }
    return sum / norm; // -1..1
  };
  const billow = (x, y, z, oct) => {
    let a = 0.5, f = 1, sum = 0, norm = 0;
    for (let o = 0; o < oct; o++) {
      sum += a * Math.abs(perlin.noise(x * f, y * f, z * f));
      norm += a;
      a *= 0.5; f *= 2.07;
    }
    return sum / norm; // 0..1
  };

  let p = 0;
  for (let k = 0; k < size; k++) {
    const z = k * inv;
    for (let j = 0; j < size; j++) {
      const y = j * inv;
      for (let i = 0; i < size; i++) {
        const x = i * inv;
        // perlin-worley base (cauliflower shapes)
        const w = worley(x, y, z);                       // 0..~1
        const wf = Math.min(1, w * 2.1);
        const pf = fbm(x * 4, y * 4, z * 4, 4) * 0.5 + 0.5;
        let base = (pf - (1.0 - wf)) / Math.max(0.0001, wf);
        base = Math.max(0, Math.min(1, base));
        data[p++] = (base * 255) | 0;
        data[p++] = (billow(x * 8, y * 8, z * 8, 3) * 255) | 0;
        data[p++] = (billow(x * 16, y * 16, z * 16, 3) * 255) | 0;
        data[p++] = (billow(x * 32, y * 32, z * 32, 2) * 255) | 0;
      }
    }
  }

  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}
