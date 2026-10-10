/**
 * worldgen.worker.js — deterministic procedural world generation.
 *
 * Pipeline
 *   1. macro relief (low res, warped fbm + ridged mountains + island mask)
 *   2. upsample + high frequency detail
 *   3. meteor impact crater
 *   4. river networks (steepest descent + channel carving)
 *   5. hydraulic (droplet) erosion
 *   6. point-of-interest placement + terrain flattening
 *   7. road network (A* over slope cost grid)
 *   8. splat / mask maps (biome weights, moisture, scorch, river proximity)
 *   9. vegetation + rock scatter, meteor nest placement
 *
 * Everything is seeded so the same seed always produces the same world.
 */
import { Rng, Noise, mulberry32, clamp, lerp, smoothstep } from '../core/rng.js';
import { WORLD, BIOME } from './constants.js';

const N = WORLD.N;
const SIZE = WORLD.SIZE;
const CELL = WORLD.CELL;
const SN = WORLD.SPLAT_N;
const SCELL = WORLD.SPLAT_CELL;

const idx = (i, j) => j * N + i;
const sidx = (i, j) => j * SN + i;

function sampleH(h, x, z) {
  // x,z in grid space (float)
  let fx = x, fz = z;
  if (fx < 0) fx = 0; else if (fx > N - 1.001) fx = N - 1.001;
  if (fz < 0) fz = 0; else if (fz > N - 1.001) fz = N - 1.001;
  const i = fx | 0, j = fz | 0;
  const tx = fx - i, tz = fz - j;
  const h00 = h[j * N + i], h10 = h[j * N + i + 1];
  const h01 = h[(j + 1) * N + i], h11 = h[(j + 1) * N + i + 1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}

/* ============================================================ 1. macro relief */
function buildMacro(seed) {
  const M = 513;
  const m = new Float32Array(M * M);
  const noise = new Noise(seed);
  const noise2 = new Noise(seed ^ 0x9e3779b9);
  for (let j = 0; j < M; j++) {
    const nz = (j / (M - 1)) * 2 - 1;
    for (let i = 0; i < M; i++) {
      const nx = (i / (M - 1)) * 2 - 1;
      const d = Math.sqrt(nx * nx + nz * nz);

      // continent shape (warped fbm) with noisy coastline
      const coast = noise.fbm(nx * 2.1 + 5, nz * 2.1 - 3, 4) * 0.22;
      const island = 1 - smoothstep(0.52, 1.0, d + coast);
      const cont = noise.warped(nx * 1.55, nz * 1.55, 34, 5) * 0.5 + 0.5;
      const land = smoothstep(0.26, 0.56, cont * (0.50 + 0.72 * island));

      // mountain ranges
      const rangeField = noise2.ridged(nx * 2.3 + 11.7, nz * 2.3 - 4.3, 4);
      const mask = Math.pow(smoothstep(0.28, 0.76, rangeField * 0.72 + cont * 0.5), 1.22) * land;
      const ridge = noise2.ridged(nx * 5.2 + 21, nz * 5.2 + 8, 7);
      const mountains = Math.pow(ridge, 1.18) * mask * 880;

      // rolling hills + fine structure
      const hills = (noise.fbm(nx * 8.5 + 31, nz * 8.5 + 17, 5) * 0.5 + 0.5);
      const base = -78 + land * (70 + hills * 46);

      let hgt = base + mountains + hills * 12 * land;
      hgt -= Math.pow(smoothstep(0.72, 1.06, d), 2) * 170; // deep ocean rim
      m[j * M + i] = hgt;
    }
  }
  return m;
}

function upsample(src, M, dst, N2) {
  const step = (M - 1) / (N2 - 1);
  for (let j = 0; j < N2; j++) {
    const sy = j * step;
    const j0 = Math.min(M - 1, sy | 0), j1 = Math.min(M - 1, j0 + 1), tj = sy - j0;
    for (let i = 0; i < N2; i++) {
      const sx = i * step;
      const i0 = Math.min(M - 1, sx | 0), i1 = Math.min(M - 1, i0 + 1), ti = sx - i0;
      const a = src[j0 * M + i0] * (1 - ti) + src[j0 * M + i1] * ti;
      const b = src[j1 * M + i0] * (1 - ti) + src[j1 * M + i1] * ti;
      dst[j * N2 + i] = a * (1 - tj) + b * tj;
    }
  }
}

/* ============================================================== 2. hi detail */
function addDetail(h, seed) {
  const noise = new Noise(seed ^ 0x1234abcd);
  const inv = 1 / SIZE;
  for (let j = 0; j < N; j++) {
    const wz = j * CELL - WORLD.HALF;
    for (let i = 0; i < N; i++) {
      const wx = i * CELL - WORLD.HALF;
      const k = j * N + i;
      const land = smoothstep(-14, 12, h[k]);
      if (land <= 0.001) { h[k] -= Math.abs(noise.fbm(wx * 0.0016, wz * 0.0016, 3)) * 14; continue; }
      const d1 = noise.fbm(wx * 0.0068, wz * 0.0068, 4) * 7.5;
      const d2 = noise.fbm(wx * 0.021, wz * 0.021, 3) * 2.6;
      const d3 = noise.noise2(wx * 0.075, wz * 0.075) * 0.55;
      h[k] += (d1 + d2 + d3) * land;
    }
  }
}

/* ================================================================ 3. crater */
function carveCrater(h, cx, cz, radius, depth, rng) {
  const noise = new Noise(0xc0ffee ^ rng.int(0, 9999));
  const R = radius / CELL;
  const ci = cx / CELL + (N - 1) / 2;
  const cj = cz / CELL + (N - 1) / 2;
  const i0 = Math.max(0, Math.floor(ci - R * 2.6)), i1 = Math.min(N - 1, Math.ceil(ci + R * 2.6));
  const j0 = Math.max(0, Math.floor(cj - R * 2.6)), j1 = Math.min(N - 1, Math.ceil(cj + R * 2.6));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const dx = i - ci, dz = j - cj;
      const d = Math.sqrt(dx * dx + dz * dz) / R;
      const k = j * N + i;
      const rough = noise.fbm(i * 0.06, j * 0.06, 3) * 0.22;
      const dr = d * (1 + rough * 0.35);
      if (dr < 1.0) {
        // parabolic bowl
        h[k] -= depth * (1 - dr * dr) * (1 - 0.25 * dr);
      } else if (dr < 1.75) {
        // raised, irregular ejecta rim
        const t = (dr - 1) / 0.75;
        const rim = (1 - t * t) * (1 - t * 0.35);
        h[k] += depth * 0.42 * rim * (1 + rough);
      } else if (dr < 3.2) {
        const t = (dr - 1.75) / 1.45;
        h[k] += depth * 0.10 * (1 - t) * (0.4 + noise.fbm(i * 0.13, j * 0.13, 2) * 0.6);
      }
    }
  }
}

/* ================================================================= 4. rivers */
function buildRivers(h, rng) {
  const rivers = [];
  const riverDist = new Uint8Array(N * N); // 0..255 => 0..60 m from a river
  const attempts = 90;
  const want = 8;
  let made = 0;
  for (let a = 0; a < attempts && made < want; a++) {
    // find a high source
    let bi = 0, bj = 0, bh = 0;
    for (let t = 0; t < 24; t++) {
      const i = rng.int(80, N - 80), j = rng.int(80, N - 80);
      const hv = h[j * N + i] + rng.range(-40, 40);
      if (hv > bh) { bh = hv; bi = i; bj = j; }
    }
    if (bh < 190) continue;

    let i = bi, j = bj, dirX = 0, dirZ = 0;
    const path = [i, j];
    for (let step = 0; step < 3000; step++) {
      let ni = i, nj = j, best = Infinity;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ii = i + di, jj = j + dj;
          if (ii < 2 || jj < 2 || ii > N - 3 || jj > N - 3) continue;
          const dot = (di * dirX + dj * dirZ) / Math.hypot(di, dj);
          const v = h[jj * N + ii] - dot * 2.4; // inertia keeps channels straight
          if (v < best) { best = v; ni = ii; nj = jj; }
        }
      }
      if (ni === i && nj === j) break;
      dirX = (ni - i) * 0.55 + dirX * 0.45;
      dirZ = (nj - j) * 0.55 + dirZ * 0.45;
      i = ni; j = nj;
      path.push(i, j);
      if (h[j * N + i] < 1.0) break;
    }
    const nPts = path.length / 2;
    if (nPts < 90) continue;

    // --- bed profile: strictly descending, then smoothed
    const bed = new Float32Array(nPts);
    for (let k = 0; k < nPts; k++) bed[k] = h[path[2 * k + 1] * N + path[2 * k]];
    for (let k = 1; k < nPts; k++) bed[k] = Math.min(bed[k], bed[k - 1] - 0.02);
    for (let pass = 0; pass < 6; pass++) {
      const cp = bed.slice();
      for (let k = 1; k < nPts - 1; k++) bed[k] = cp[k - 1] * 0.25 + cp[k] * 0.5 + cp[k + 1] * 0.25;
    }

    // --- carve the channel (widens downstream)
    const pts = new Float32Array(nPts * 4); // x, z, y, width
    let ok = true;
    for (let k = 0; k < nPts; k++) {
      const t = k / (nPts - 1);
      const w = lerp(2.5, 30, Math.pow(t, 0.75));
      const gi = path[2 * k], gj = path[2 * k + 1];
      const wx = gi * CELL - WORLD.HALF, wz = gj * CELL - WORLD.HALF;
      pts[k * 4 + 0] = wx;
      pts[k * 4 + 1] = wz;
      pts[k * 4 + 2] = bed[k];
      pts[k * 4 + 3] = w;
      const rc = w / CELL + 1;
      const depth = lerp(1.4, 6.5, t);
      for (let dj = -Math.ceil(rc); dj <= Math.ceil(rc); dj++) {
        for (let di = -Math.ceil(rc); di <= Math.ceil(rc); di++) {
          const ii = gi + di, jj = gj + dj;
          if (ii < 1 || jj < 1 || ii > N - 2 || jj > N - 2) continue;
          const d = Math.hypot(di, dj) / rc;
          if (d > 1.15) continue;
          const kk = jj * N + ii;
          const profile = d < 1 ? (1 - d * d * 0.85) : (1 - (d - 1) / 0.15) * 0.15;
          const target = bed[k] - depth * profile;
          h[kk] = Math.min(h[kk], h[kk] * (1 - profile * 0.95) + target * profile * 0.95);
          const near = Math.max(0, 1 - (Math.hypot(di, dj) * CELL) / 55);
          const v = (near * 255) | 0;
          if (v > riverDist[kk]) riverDist[kk] = v;
        }
      }
    }
    if (!ok) continue;
    rivers.push({ pts, count: nPts });
    made++;
  }
  return { rivers, riverDist };
}

/* =============================================================== 5. erosion */
function erode(h, seed, drops) {
  const rnd = mulberry32(seed ^ 0x5eed);
  const r = 3;
  const brush = [];
  let wsum = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d = Math.hypot(dx, dy);
      if (d <= r) { const w = 1 - d / (r + 0.6); brush.push(dx, dy, w); wsum += w; }
    }
  }
  const inertia = 0.05, capacity = 5.2, minSlope = 0.006, deposit = 0.28, erodeAmt = 0.28, gravity = 4.2, evap = 0.012;

  for (let d = 0; d < drops; d++) {
    let px = 2 + rnd() * (N - 5);
    let pz = 2 + rnd() * (N - 5);
    let dirX = 0, dirZ = 0, speed = 1, water = 1, sediment = 0;

    for (let s = 0; s < 56; s++) {
      const gi = px | 0, gj = pz | 0;
      const fx = px - gi, fz = pz - gj;
      if (gi < 1 || gj < 1 || gi > N - 3 || gj > N - 3) break;
      const h00 = h[gj * N + gi], h10 = h[gj * N + gi + 1];
      const h01 = h[(gj + 1) * N + gi], h11 = h[(gj + 1) * N + gi + 1];
      const gx = (h10 - h00) * (1 - fz) + (h11 - h01) * fz;
      const gz = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;
      const hOld = (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
      if (hOld < 0.5) break; // stop at the sea

      dirX = dirX * inertia - gx * (1 - inertia);
      dirZ = dirZ * inertia - gz * (1 - inertia);
      const len = Math.hypot(dirX, dirZ);
      if (len < 1e-6) break;
      dirX /= len; dirZ /= len;
      px += dirX; pz += dirZ;
      if (px < 2 || pz < 2 || px > N - 4 || pz > N - 4) break;

      const hNew = sampleH(h, px, pz);
      const dh = hNew - hOld;
      const cap = Math.max(-dh, minSlope) * speed * water * capacity;

      if (sediment > cap || dh > 0) {
        const amount = dh > 0 ? Math.min(dh, sediment) : (sediment - cap) * deposit;
        sediment -= amount;
        // deposit at the previous position
        const bi = gi, bj = gj;
        for (let b = 0; b < brush.length; b += 3) {
          const ii = bi + brush[b], jj = bj + brush[b + 1];
          if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
          const w = brush[b + 2] / wsum;
          h[jj * N + ii] += amount * w;
        }
      } else {
        const amount = Math.min((cap - sediment) * erodeAmt, -dh);
        for (let b = 0; b < brush.length; b += 3) {
          const ii = gi + brush[b], jj = gj + brush[b + 1];
          if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
          const w = brush[b + 2] / wsum;
          const k = jj * N + ii;
          const take = Math.min(amount * w, Math.max(0, h[k] - (-70)));
          h[k] -= take;
          sediment += take;
        }
      }
      speed = Math.sqrt(Math.max(0.01, speed * speed - dh * gravity));
      water *= 1 - evap;
    }
  }
}

/* =============================================================== 6. flatten */
function flatten(h, cx, cz, radius, strength) {
  const ci = cx / CELL + (N - 1) / 2, cj = cz / CELL + (N - 1) / 2;
  const R = radius / CELL;
  // average height
  let sum = 0, n = 0;
  const i0 = Math.max(0, Math.floor(ci - R)), i1 = Math.min(N - 1, Math.ceil(ci + R));
  const j0 = Math.max(0, Math.floor(cj - R)), j1 = Math.min(N - 1, Math.ceil(cj + R));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (Math.hypot(i - ci, j - cj) > R) continue;
      sum += h[j * N + i]; n++;
    }
  }
  if (!n) return 0;
  const avg = sum / n;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const d = Math.hypot(i - ci, j - cj) / R;
      if (d > 1) continue;
      const t = smoothstep(1.0, 0.35, d) * strength;
      const k = j * N + i;
      h[k] = lerp(h[k], avg, t);
    }
  }
  return avg;
}

/* =============================================================== 7. roads */
function buildRoads(h, pois, rng) {
  const G = 160; // cost grid resolution
  const gc = SIZE / G;
  const cost = new Float32Array(G * G);
  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G; i++) {
      const wx = (i + 0.5) * gc - WORLD.HALF, wz = (j + 0.5) * gc - WORLD.HALF;
      const gi = wx / CELL + (N - 1) / 2, gj = wz / CELL + (N - 1) / 2;
      const h0 = sampleH(h, gi, gj);
      const hx = sampleH(h, gi + 6, gj), hz = sampleH(h, gi, gj + 6);
      const slope = Math.hypot(hx - h0, hz - h0) / (6 * CELL);
      let c = 1 + slope * 26;
      if (h0 < 2.5) c += 220;      // avoid water
      if (h0 > 380) c += 12;       // avoid high mountains
      cost[j * G + i] = c;
    }
  }
  const toG = (wx, wz) => [clamp(Math.floor((wx + WORLD.HALF) / gc), 0, G - 1), clamp(Math.floor((wz + WORLD.HALF) / gc), 0, G - 1)];
  const toW = (i, j) => [(i + 0.5) * gc - WORLD.HALF, (j + 0.5) * gc - WORLD.HALF];

  function astar(a, b) {
    const [ai, aj] = toG(a.x, a.z), [bi, bj] = toG(b.x, b.z);
    const open = [[0, ai, aj]];
    const gScore = new Float32Array(G * G).fill(Infinity);
    const from = new Int32Array(G * G).fill(-1);
    const closed = new Uint8Array(G * G);
    const s0 = aj * G + ai;
    gScore[s0] = 0;
    const heur = (i, j) => Math.hypot(i - bi, j - bj);
    let guard = 0;
    while (open.length && guard++ < 60000) {
      // simple binary-heap-less approach: sort occasionally (grids are small)
      let bestI = 0;
      for (let k = 1; k < open.length; k++) if (open[k][0] < open[bestI][0]) bestI = k;
      const [f, i, j] = open.splice(bestI, 1)[0];
      const s = j * G + i;
      if (closed[s]) continue;
      closed[s] = 1;
      if (i === bi && j === bj) break;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= G || nj >= G) continue;
          const ns = nj * G + ni;
          if (closed[ns]) continue;
          const step = (di && dj) ? 1.4142 : 1;
          const g = gScore[s] + cost[ns] * step;
          if (g < gScore[ns]) {
            gScore[ns] = g;
            from[ns] = s;
            open.push([g + heur(ni, nj) * 1.05, ni, nj]);
          }
        }
      }
    }
    const path = [];
    let s = bj * G + bi;
    if (from[s] === -1 && s !== s0) return null;
    let guard2 = 0;
    while (s !== -1 && guard2++ < 4000) {
      path.push([s % G, (s / G) | 0]);
      if (s === s0) break;
      s = from[s];
    }
    path.reverse();
    return path.map(([i, j]) => toW(i, j));
  }

  // connect main settlements with a minimum spanning tree + a few loops
  const main = pois.filter((p) => p.kind === 'village' || p.kind === 'temple' || p.kind === 'palace' || p.kind === 'monastery');
  const roads = [];
  const connected = [main[0]];
  const pending = main.slice(1);
  while (pending.length && connected.length) {
    let best = null;
    for (const a of connected) {
      for (let k = 0; k < pending.length; k++) {
        const d = Math.hypot(a.x - pending[k].x, a.z - pending[k].z);
        if (!best || d < best.d) best = { d, a, b: pending[k], k };
      }
    }
    if (!best) break;
    const path = astar(best.a, best.b);
    if (path) roads.push(path);
    connected.push(best.b);
    pending.splice(best.k, 1);
  }
  // a couple of extra links so the network has loops
  for (let k = 0; k < 3 && main.length > 3; k++) {
    const a = main[rng.int(0, main.length - 1)], b = main[rng.int(0, main.length - 1)];
    if (a === b) continue;
    const path = astar(a, b);
    if (path) roads.push(path);
  }
  // spur roads to some camps / outposts
  for (const p of pois) {
    if (p.kind !== 'camp' && p.kind !== 'outpost') continue;
    if (!rng.bool(0.45)) continue;
    let nearest = null, nd = Infinity;
    for (const m of main) {
      const d = Math.hypot(m.x - p.x, m.z - p.z);
      if (d < nd) { nd = d; nearest = m; }
    }
    if (nearest && nd < 2600) { const path = astar(nearest, p); if (path) roads.push(path); }
  }

  // smooth (chaikin) and resample onto the heightfield
  const out = [];
  for (let path of roads) {
    let pts = path;
    for (let pass = 0; pass < 3; pass++) {
      const np = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        np.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
        np.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
      }
      np.push(pts[pts.length - 1]);
      pts = np;
    }
    // resample every ~14 m
    const resampled = [];
    let acc = 0;
    resampled.push(pts[0]);
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      acc += d;
      if (acc >= 14) { resampled.push(pts[i]); acc = 0; }
    }
    if (resampled.length < 4) continue;
    const arr = new Float32Array(resampled.length * 4);
    for (let i = 0; i < resampled.length; i++) {
      const [wx, wz] = resampled[i];
      const gi = wx / CELL + (N - 1) / 2, gj = wz / CELL + (N - 1) / 2;
      arr[i * 4 + 0] = wx;
      arr[i * 4 + 1] = wz;
      arr[i * 4 + 2] = sampleH(h, gi, gj);
      arr[i * 4 + 3] = 6 + 2 * Math.sin(i * 0.3); // half width
    }
    out.push({ pts: arr, count: resampled.length });
  }
  return out;
}

/* ======================================================= 8. splat and masks */
function buildSplat(h, riverDist, seed, crater, pois) {
  const splat = new Uint8Array(SN * SN * 4);
  const mask = new Uint8Array(SN * SN * 4);
  const noise = new Noise(seed ^ 0xa17e);
  const moistureN = new Noise(seed ^ 0x7717);
  const step = (N - 1) / (SN - 1);

  for (let j = 0; j < SN; j++) {
    for (let i = 0; i < SN; i++) {
      const gi = i * step, gj = j * step;
      const k0 = idx(Math.min(N - 1, gi | 0), Math.min(N - 1, gj | 0));
      const hgt = sampleH(h, gi, gj);
      const hx = sampleH(h, gi + 1.5, gj) - sampleH(h, gi - 1.5, gj);
      const hz = sampleH(h, gi, gj + 1.5) - sampleH(h, gi, gj - 1.5);
      const slope = Math.hypot(hx, hz) / (3 * CELL);

      const wx = i * SCELL - WORLD.HALF, wz = j * SCELL - WORLD.HALF;
      const moist = clamp(moistureN.fbm(wx * 0.0012, wz * 0.0012, 4) * 0.5 + 0.5 + (riverDist[k0] / 255) * 0.55, 0, 1);
      const snowNoise = noise.fbm(wx * 0.004, wz * 0.004, 3) * 70;
      const snowLine = WORLD.SNOW_LINE + snowNoise;

      // layer weights
      let wSnow = smoothstep(snowLine - 90, snowLine + 60, hgt) * (1 - smoothstep(0.55, 0.95, slope));
      let wRock = smoothstep(0.42, 0.78, slope) + smoothstep(320, 560, hgt) * 0.45;
      let wGrass = (1 - smoothstep(0.28, 0.55, slope)) * smoothstep(0.18, 0.55, moist) * (1 - smoothstep(0.02, 0.35, slope * 0.4));
      wGrass *= 1 - smoothstep(300, 520, hgt) * 0.85; // less grass high up
      let wDirt = 1;

      // beaches / river banks
      const beach = (1 - smoothstep(1.6, 5.5, hgt)) * (1 - smoothstep(0.05, 0.35, slope)) * smoothstep(-3.5, -0.5, hgt);
      wDirt = Math.max(wDirt, beach * 1.4);
      wGrass *= 1 - beach * 0.85;

      // river bed → wet dirt
      const rv = riverDist[k0] / 255;
      if (rv > 0.02) {
        wDirt += rv * 1.6;
        wGrass *= 1 - rv * 0.7;
        wRock *= 1 - rv * 0.5;
      }

      wSnow = clamp(wSnow, 0, 1);
      wRock = clamp(wRock * (1 - wSnow), 0, 1);
      wGrass = clamp(wGrass * (1 - wSnow) * (1 - wRock * 0.8), 0, 1);
      wDirt = clamp(wDirt, 0, 1);

      let total = wGrass + wDirt + wRock + wSnow;
      if (total < 0.0001) { wDirt = 1; total = 1; }
      const s = sidx(i, j) * 4;
      splat[s + 0] = clamp((wGrass / total) * 255, 0, 255);
      splat[s + 1] = clamp((wDirt / total) * 255, 0, 255);
      splat[s + 2] = clamp((wRock / total) * 255, 0, 255);
      splat[s + 3] = clamp((wSnow / total) * 255, 0, 255);

      // mask: R road, G river wetness, B scorch/ash, A moisture
      const scorch = crater ? clamp(1 - Math.hypot(wx - crater.x, wz - crater.z) / (crater.radius * 3.4), 0, 1) : 0;
      for (const p of pois) {
        if (p.corrupt) {
          const d = Math.hypot(wx - p.x, wz - p.z);
          if (d < p.radius * 2.2) {
            // handled later: nests paint corruption
          }
        }
      }
      mask[s + 0] = 0;
      mask[s + 1] = clamp(rv * 255, 0, 255);
      mask[s + 2] = clamp(scorch * 255, 0, 255);
      mask[s + 3] = clamp(moist * 255, 0, 255);
    }
  }
  return { splat, mask };
}

/* ====================================================== 9. scatter & nests */
const NAME_A = ['Ash', 'Bram', 'Cal', 'Dorn', 'Eld', 'Fen', 'Grim', 'Hal', 'Iri', 'Kael', 'Lor', 'Mor', 'Nym', 'Orin', 'Pyre', 'Quen', 'Rho', 'Syl', 'Tor', 'Ul', 'Ves', 'Wren', 'Yor', 'Zer'];
const NAME_B = ['fall', 'mere', 'gard', 'holme', ' reach', 'watch', 'ford', 'dale', 'stead', 'bourne', 'crest', 'hollow', 'spire', 'moor', 'vale', 'wick', 'ridge', 'gate', 'haven', 'hammer'];

function poiName(rng) {
  return rng.pick(NAME_A) + rng.pick(NAME_B);
}

function placePOIs(h, rng, crater, riverDist) {
  const pois = [];
  const plan = [
    { kind: 'palace', count: 1, minH: 12, maxH: 180, maxSlope: 0.10, spacing: 2200, radius: 130, flatten: 0.85 },
    { kind: 'temple', count: 3, minH: 45, maxH: 400, maxSlope: 0.20, spacing: 1300, radius: 90, flatten: 0.8 },
    { kind: 'monastery', count: 1, minH: 260, maxH: 520, maxSlope: 0.28, spacing: 1400, radius: 70, flatten: 0.75 },
    { kind: 'village', count: 6, minH: 4, maxH: 230, maxSlope: 0.13, spacing: 950, radius: 95, flatten: 0.8 },
    { kind: 'outpost', count: 6, minH: 20, maxH: 430, maxSlope: 0.30, spacing: 700, radius: 42, flatten: 0.92 },
    { kind: 'ruins', count: 9, minH: 2, maxH: 380, maxSlope: 0.28, spacing: 480, radius: 45, flatten: 0.8 },
    { kind: 'camp', count: 12, minH: 2, maxH: 300, maxSlope: 0.20, spacing: 420, radius: 28, flatten: 0.85 },
    { kind: 'shrine', count: 10, minH: 2, maxH: 480, maxSlope: 0.30, spacing: 320, radius: 16, flatten: 0.9 },
  ];

  const fits = (x, z, slope, hgt, spec, spacing) => {
    if (hgt < spec.minH || hgt > spec.maxH) return false;
    if (slope > spec.maxSlope) return false;
    if (riverDist && riverDist[idx((x / CELL + (N - 1) / 2) | 0, (z / CELL + (N - 1) / 2) | 0)] > 140) return false;
    if (Math.hypot(x - crater.x, z - crater.z) < crater.radius * 3.2 + 260) return false;
    for (const p of pois) if (Math.hypot(x - p.x, z - p.z) < spacing) return false;
    return true;
  };

  for (const spec of plan) {
    let tries = 0, placed = 0;
    while (placed < spec.count && tries++ < 4000) {
      const x = rng.range(-WORLD.HALF + 500, WORLD.HALF - 500);
      const z = rng.range(-WORLD.HALF + 500, WORLD.HALF - 500);
      const gi = x / CELL + (N - 1) / 2, gj = z / CELL + (N - 1) / 2;
      const h0 = sampleH(h, gi, gj);
      const sx = sampleH(h, gi + 4, gj) - sampleH(h, gi - 4, gj);
      const sz = sampleH(h, gi, gj + 4) - sampleH(h, gi, gj - 4);
      const slope = Math.hypot(sx, sz) / (8 * CELL);
      const spacing = Math.max(spec.spacing, placed === 0 ? 0 : spec.spacing);
      if (!fits(x, z, slope, h0, spec, spacing)) continue;
      pois.push({
        kind: spec.kind,
        name: poiName(rng) + (spec.kind === 'village' ? '' : ''),
        x, z, y: h0,
        radius: spec.radius,
        rot: rng.range(0, Math.PI * 2),
        seed: rng.int(0, 1e9),
        spacing: spec.spacing,
      });
      placed++;
    }
  }
  return pois;
}

function scatterVegetation(h, splatRiver, seed, pois, crater) {
  const out = { pine: [], tree: [], dead: [], twisted: [], rock: [], pebble: [], drift: [] };
  const rng = new Rng(seed ^ 0x51de);
  const noise = new Noise(seed ^ 0x2b2b);
  const step = 3;
  const area = (step * CELL) * (step * CELL);
  const poiR = pois.map((p) => ({ x: p.x, z: p.z, r: p.radius * (p.kind === 'camp' || p.kind === 'shrine' ? 0.5 : 1.15) + 12 }));

  for (let j = 1; j < N - 1; j += step) {
    for (let i = 1; i < N - 1; i += step) {
      const k = j * N + i;
      const hgt = h[k];
      if (hgt < 1.2) continue;
      const gi = i, gj = j;
      const hx = h[j * N + i + 1] - h[j * N + i - 1];
      const hz = h[(j + 1) * N + i] - h[(j - 1) * N + i];
      const slope = Math.hypot(hx, hz) / (2 * CELL);
      const wx = i * CELL - WORLD.HALF, wz = j * CELL - WORLD.HALF;
      const rv = splatRiver[k] / 255;

      // crashed-meteor blast zone: nothing survives nearby
      const dc = Math.hypot(wx - crater.x, wz - crater.z);
      if (dc < crater.radius * 1.7) continue;
      let inPoi = false;
      for (const p of poiR) if (Math.hypot(wx - p.x, wz - p.z) < p.r) { inPoi = true; break; }
      if (inPoi) continue;

      const moist = noise.fbm(wx * 0.0012, wz * 0.0012, 4) * 0.5 + 0.5 + rv * 0.5;
      const dens = noise.fbm(wx * 0.006, wz * 0.006, 3) * 0.5 + 0.5;
      const alt = smoothstep(120, 420, hgt);
      const snowy = smoothstep(WORLD.SNOW_LINE - 60, WORLD.SNOW_LINE + 60, hgt);

      // --- trees
      let treeDensity = 0;
      if (hgt < WORLD.TREE_LINE) {
        const forest = clamp(moist * 1.15 - 0.18, 0, 1) * (1 - slope * 1.5) * (1 - alt * 0.75);
        treeDensity = forest * 0.048 + (slope < 0.2 ? dens * 0.009 : 0);
        treeDensity *= 1 - snowy * 0.8;
      }
      if (treeDensity > 0) {
        const n = treeDensity * area;
        let count = Math.floor(n);
        if (rng.float() < n - count) count++;
        for (let c = 0; c < count; c++) {
          const ox = wx + rng.range(-step * CELL * 0.5, step * CELL * 0.5);
          const oz = wz + rng.range(-step * CELL * 0.5, step * CELL * 0.5);
          const sx = ox / CELL + (N - 1) / 2, sz = oz / CELL + (N - 1) / 2;
          const oy = sampleH(h, sx, sz);
          if (oy < 1.4) continue;
          const sc = rng.range(0.75, 1.35) * (1 + alt * 0.2);
          const roll = rng.float();
          const pineFactor = clamp(alt * 0.8 + rng.range(-0.25, 0.25) + 0.35, 0, 1);
          let key;
          if (roll < 0.03) key = 'dead';
          else if (roll < 0.10) key = 'twisted';
          else if (rng.float() < pineFactor) key = 'pine';
          else key = 'tree';
          out[key].push(ox, oy - 0.25, oz, sc, rng.range(0, Math.PI * 2));
        }
      }

      // --- rocks and pebbles
      let rockDensity = 0.00035 + slope * 0.0022 + alt * 0.0009 + snowy * 0.0014;
      if (hgt > WORLD.TREE_LINE - 90) rockDensity += 0.0012;
      const rn = rockDensity * area;
      let rcount = Math.floor(rn);
      if (rng.float() < rn - rcount) rcount++;
      for (let c = 0; c < rcount; c++) {
        const ox = wx + rng.range(-step * CELL * 0.5, step * CELL * 0.5);
        const oz = wz + rng.range(-step * CELL * 0.5, step * CELL * 0.5);
        const sx = ox / CELL + (N - 1) / 2, sz = oz / CELL + (N - 1) / 2;
        const oy = sampleH(h, sx, sz);
        if (oy < 0.4) continue;
        const sc = rng.range(0.5, 2.2);
        const key = sc < 0.9 ? 'pebble' : 'rock';
        out[key].push(ox, oy - 0.15 * sc, oz, sc, rng.range(0, Math.PI * 2));
      }
    }
  }
  const result = {};
  for (const [k, v] of Object.entries(out)) result[k] = new Float32Array(v);
  return result;
}

function placeNests(h, rng, pois, crater) {
  const nests = [];
  let tries = 0;
  while (nests.length < 34 && tries++ < 5000) {
    const x = rng.range(-WORLD.HALF + 400, WORLD.HALF - 400);
    const z = rng.range(-WORLD.HALF + 400, WORLD.HALF - 400);
    const gi = x / CELL + (N - 1) / 2, gj = z / CELL + (N - 1) / 2;
    const h0 = sampleH(h, gi, gj);
    if (h0 < 2 || h0 > 520) continue;
    let ok = true;
    for (const n of nests) if (Math.hypot(x - n.x, z - n.z) < 420) { ok = false; break; }
    if (ok) for (const p of pois) if (Math.hypot(x - p.x, z - p.z) < p.radius + 190) { ok = false; break; }
    if (Math.hypot(x - crater.x, z - crater.z) < crater.radius * 2.2) ok = false;
    if (!ok) continue;
    const dist = Math.hypot(x - crater.x, z - crater.z);
    nests.push({
      x, z, y: h0, seed: rng.int(0, 1e9),
      tier: dist < 1400 ? 3 : dist < 2800 ? 2 : 1,
      radius: 34 + rng.range(0, 22),
    });
  }
  return nests;
}

/* ==================================================================== main */
function generate(seed) {
  const t0 = Date.now();
  const rng = new Rng(seed);
  const report = (stage, pct) => self.postMessage({ type: 'progress', stage, pct });

  report('shaping continents', 0.03);
  const macro = buildMacro(seed);
  const h = new Float32Array(N * N);
  upsample(macro, 513, h, N);

  report('carving detail', 0.10);
  addDetail(h, seed);

  report('meteor impact', 0.18);
  // choose the crash site: a flat-ish place on land, away from the rim
  let crater = null;
  for (let t = 0; t < 3000; t++) {
    const x = rng.range(-WORLD.HALF * 0.55, WORLD.HALF * 0.55);
    const z = rng.range(-WORLD.HALF * 0.55, WORLD.HALF * 0.55);
    const gi = x / CELL + (N - 1) / 2, gj = z / CELL + (N - 1) / 2;
    const h0 = sampleH(h, gi, gj);
    const sx = sampleH(h, gi + 8, gj) - sampleH(h, gi - 8, gj);
    const sz = sampleH(h, gi, gj + 8) - sampleH(h, gi, gj - 8);
    const slope = Math.hypot(sx, sz) / (16 * CELL);
    if (h0 > 12 && h0 < 190 && slope < 0.10) { crater = { x, z, y: h0, radius: 120, depth: 62 }; break; }
  }
  if (!crater) crater = { x: 0, z: 0, y: 40, radius: 120, depth: 62 };
  carveCrater(h, crater.x, crater.z, crater.radius, crater.depth, rng);

  report('flowing rivers', 0.26);
  const { rivers, riverDist } = buildRivers(h, rng);

  report('eroding terrain', 0.38);
  erode(h, seed, 90000);

  report('placing settlements', 0.62);
  const pois = placePOIs(h, rng, crater, riverDist);
  for (const p of pois) {
    const y = flatten(h, p.x, p.z, p.radius, p.flatten ?? 0.7);
    p.y = y;
  }
  // soften the crash site floor a bit so it is playable
  flatten(h, crater.x, crater.z, crater.radius * 0.75, 0.25);

  report('laying roads', 0.72);
  const roads = buildRoads(h, pois, rng);

  report('painting biomes', 0.84);
  const { splat, mask } = buildSplat(h, riverDist, seed, crater, pois);

  report('growing forests', 0.90);
  const veg = scatterVegetation(h, riverDist, seed, pois, crater);

  report('seeding the infestation', 0.96);
  const nests = placeNests(h, rng, pois, crater);

  // player start: just outside the crater rim, on the side facing the map centre
  let start = null;
  let bestScore = Infinity;
  for (let k = 0; k < 48; k++) {
    const ang = (k / 48) * Math.PI * 2;
    for (const rr of [2.0, 2.4, 2.8]) {
      const x = crater.x + Math.cos(ang) * crater.radius * rr;
      const z = crater.z + Math.sin(ang) * crater.radius * rr;
      const gi = x / CELL + (N - 1) / 2, gj = z / CELL + (N - 1) / 2;
      if (gi < 20 || gj < 20 || gi > N - 20 || gj > N - 20) continue;
      const y0 = sampleH(h, gi, gj);
      if (y0 < 2) continue;
      const sx = sampleH(h, gi + 6, gj) - sampleH(h, gi - 6, gj);
      const sz = sampleH(h, gi, gj + 6) - sampleH(h, gi, gj - 6);
      const slope = Math.hypot(sx, sz) / (12 * CELL);
      const score = slope * 220 + Math.abs(y0 - crater.y) * 0.7;
      if (score < bestScore) { bestScore = score; start = { x, z, y: y0 }; }
    }
  }
  if (!start) start = { x: crater.x + crater.radius * 2.2, z: crater.z, y: crater.y };

  report('done', 1);
  return { h, splat, mask, rivers, roads, pois, veg, nests, crater, start, seed, time: Date.now() - t0 };
}

self.onmessage = (e) => {
  const { seed } = e.data;
  try {
    const res = generate(seed);
    const transfer = [res.h.buffer, res.splat.buffer, res.mask.buffer];
    for (const r of res.rivers) transfer.push(r.pts.buffer);
    for (const r of res.roads) transfer.push(r.pts.buffer);
    for (const k of Object.keys(res.veg)) transfer.push(res.veg[k].buffer);
    self.postMessage({ type: 'done', data: res }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message + '\n' + err.stack });
  }
};
