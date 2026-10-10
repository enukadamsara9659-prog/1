// Seeded random + noise utilities (deterministic world generation).

export function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed = 1337) {
    this.seed = seed >>> 0;
    this.next = mulberry32(this.seed);
  }
  float() { return this.next(); }
  range(a, b) { return a + this.next() * (b - a); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  bool(p = 0.5) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length) % arr.length]; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  gauss() {
    let u = 0, v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

// ---------------------------------------------------------------- hash noise
export function hash2(x, y, seed = 0) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRAD = [1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 1, 0, -1, 0, 0, 1, 0, -1, 0, 1, 0, -1];

/** Classic 2D simplex noise, seeded permutation table. */
export class Noise {
  constructor(seed = 1337) {
    this.seed = seed >>> 0;
    const r = mulberry32(this.seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    this.perm = new Uint8Array(512);
    this.permMod12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  noise2(xin, yin) {
    const perm = this.perm, permMod12 = this.permMod12;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const X0 = i - t, Y0 = j - t;
    const x0 = xin - X0, y0 = yin - Y0;
    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n0 = 0, n1 = 0, n2 = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = permMod12[ii + perm[jj]] * 2;
      t0 *= t0;
      n0 = t0 * t0 * (GRAD[g] * x0 + GRAD[g + 1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = permMod12[ii + i1 + perm[jj + j1]] * 2;
      t1 *= t1;
      n1 = t1 * t1 * (GRAD[g] * x1 + GRAD[g + 1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = permMod12[ii + 1 + perm[jj + 1]] * 2;
      t2 *= t2;
      n2 = t2 * t2 * (GRAD[g] * x2 + GRAD[g + 1] * y2);
    }
    return 70 * (n0 + n1 + n2);
  }

  /** fractal brownian motion, returns roughly [-1,1] */
  fbm(x, y, oct = 5, lac = 2.0, gain = 0.5) {
    let a = 1, f = 1, sum = 0, norm = 0;
    for (let o = 0; o < oct; o++) {
      sum += a * this.noise2(x * f, y * f);
      norm += a;
      a *= gain;
      f *= lac;
    }
    return sum / norm;
  }

  /** ridged multifractal — great for mountain ranges, returns [0,1] */
  ridged(x, y, oct = 6, lac = 2.0, gain = 0.5) {
    let a = 0.5, f = 1, sum = 0, norm = 0, prev = 1;
    for (let o = 0; o < oct; o++) {
      let n = 1 - Math.abs(this.noise2(x * f, y * f));
      n *= n;
      n *= prev;
      prev = n;
      sum += a * n;
      norm += a;
      a *= gain;
      f *= lac;
    }
    return sum / norm;
  }

  /** billowy / cloud-like noise [0,1] */
  billow(x, y, oct = 4, lac = 2.0, gain = 0.5) {
    let a = 0.5, f = 1, sum = 0, norm = 0;
    for (let o = 0; o < oct; o++) {
      sum += a * Math.abs(this.noise2(x * f, y * f));
      norm += a;
      a *= gain;
      f *= lac;
    }
    return sum / norm;
  }

  /** domain-warped fbm — organic continent shapes */
  warped(x, y, strength = 40, oct = 5) {
    const wx = this.fbm(x + 11.3, y + 4.7, 3);
    const wy = this.fbm(x - 5.1, y + 9.2, 3);
    return this.fbm(x + strength * 0.01 * wx, y + strength * 0.01 * wy, oct);
  }
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const smootherstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
export const invLerp = (a, b, v) => (v - a) / (b - a);

/** frame-rate independent exponential smoothing */
export const damp = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));
export const dampAngle = (a, b, lambda, dt) => {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * (1 - Math.exp(-lambda * dt));
};
