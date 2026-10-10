// Canvas-generated tileable PBR textures (fills the gaps the CC0 packs leave:
// roof tiles, thatch, cobble, marble and cut stone).
import * as THREE from 'three';

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function luminanceToHeight(src, size) {
  const h = canvas(size);
  const hc = h.getContext('2d', { willReadFrequently: true });
  hc.drawImage(src, 0, 0);
  const img = hc.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11);
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  hc.putImageData(img, 0, 0);
  return h;
}

/** Sobel height → packed normal.rg + roughness in B */
function packNormalRough(heightCanvas, size, strength, roughness, roughCanvas) {
  const hc = heightCanvas.getContext('2d', { willReadFrequently: true });
  const hd = hc.getImageData(0, 0, size, size).data;
  const rd = roughCanvas ? roughCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, size, size).data : null;
  const out = canvas(size);
  const oc = out.getContext('2d', { willReadFrequently: true });
  const img = oc.createImageData(size, size);
  const d = img.data;
  const H = (x, y) => hd[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx =
        (H(x - 1, y - 1) + 2 * H(x - 1, y) + H(x - 1, y + 1)) -
        (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1));
      const dy =
        (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1)) -
        (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1));
      let nx = dx * strength, ny = dy * strength;
      const len = Math.hypot(nx, ny, 1);
      nx /= len; ny /= len;
      const i = (y * size + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      const rv = rd ? rd[i] / 255 * roughness : roughness;
      d[i + 2] = Math.max(0, Math.min(255, rv * 255 * 1.6));
      d[i + 3] = 255;
    }
  }
  oc.putImageData(img, 0, 0);
  return out;
}

function toTexture(canvasEl, srgb, repeat = 1) {
  const t = new THREE.CanvasTexture(canvasEl);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  t.repeat.set(repeat, repeat);
  t.needsUpdate = true;
  return t;
}

/**
 * buildProcTexture({ size, draw, height, strength, roughness })
 * returns { color: Texture, nr: Texture }  (nr = normal.rg + roughness)
 */
export function buildProcTexture(opts) {
  const size = opts.size || 512;
  const c = canvas(size);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = opts.bg || '#808080';
  ctx.fillRect(0, 0, size, size);
  opts.draw(ctx, size);
  const h = opts.height ? (() => { const hc = canvas(size); opts.height(hc.getContext('2d', { willReadFrequently: true }), size); return hc; })() : luminanceToHeight(c, size);
  const roughCanvas = opts.rough ? (() => { const rc = canvas(size); opts.rough(rc.getContext('2d', { willReadFrequently: true }), size); return rc; })() : null;
  const nr = packNormalRough(h, size, opts.strength ?? 2.2, opts.roughness ?? 0.85, roughCanvas);
  return { color: toTexture(c, true), nr: toTexture(nr, false) };
}

const rnd = (s) => { let x = s; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; }; };

/* ------------------------------------------------------------- generators */
export const TEXGEN = {
  roofTile: () => buildProcTexture({
    size: 512, strength: 2.6, roughness: 0.72,
    draw(ctx, S) {
      const r = rnd(11);
      ctx.fillStyle = '#4a3128';
      ctx.fillRect(0, 0, S, S);
      const cols = 8, rows = 10;
      const cw = S / cols, ch = S / rows;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const ox = (j % 2) * cw * 0.5;
          const x = i * cw + ox, y = j * ch;
          const shade = 0.62 + r() * 0.38;
          const rr = Math.round(150 * shade), gg = Math.round(84 * shade), bb = Math.round(62 * shade);
          ctx.beginPath();
          ctx.moveTo(x + 2, y + ch);
          ctx.lineTo(x + 2, y + ch * 0.28);
          ctx.quadraticCurveTo(x + cw * 0.5, y - ch * 0.12, x + cw - 2, y + ch * 0.28);
          ctx.lineTo(x + cw - 2, y + ch);
          ctx.closePath();
          const g = ctx.createLinearGradient(x, y, x + cw, y);
          g.addColorStop(0, `rgb(${rr * 0.75 | 0},${gg * 0.75 | 0},${bb * 0.75 | 0})`);
          g.addColorStop(0.35, `rgb(${rr},${gg},${bb})`);
          g.addColorStop(1, `rgb(${rr * 0.55 | 0},${gg * 0.55 | 0},${bb * 0.55 | 0})`);
          ctx.fillStyle = g;
          ctx.fill();
          ctx.strokeStyle = 'rgba(20,10,8,0.55)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          // moss speckles
          if (r() < 0.18) {
            ctx.fillStyle = 'rgba(70,90,50,0.30)';
            ctx.beginPath();
            ctx.arc(x + cw * r(), y + ch * (0.4 + r() * 0.5), 2 + r() * 5, 0, 7);
            ctx.fill();
          }
        }
      }
    },
  }),

  thatch: () => buildProcTexture({
    size: 512, strength: 1.6, roughness: 0.95,
    draw(ctx, S) {
      const r = rnd(7);
      ctx.fillStyle = '#6b5a2e';
      ctx.fillRect(0, 0, S, S);
      for (let i = 0; i < 5200; i++) {
        const x = r() * S, y = r() * S;
        const l = 8 + r() * 28;
        const a = -0.25 + r() * 0.5;
        const c = 0.55 + r() * 0.6;
        ctx.strokeStyle = `rgba(${(168 * c) | 0},${(140 * c) | 0},${(70 * c) | 0},${0.5 + r() * 0.5})`;
        ctx.lineWidth = 1 + r() * 2.2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l * 0.35 + 3);
        ctx.stroke();
      }
      for (let j = 0; j < 14; j++) {
        ctx.fillStyle = 'rgba(40,32,14,0.35)';
        ctx.fillRect(0, (j / 14) * S, S, 3);
      }
    },
  }),

  cobble: () => buildProcTexture({
    size: 512, strength: 3.0, roughness: 0.9,
    draw(ctx, S) {
      const r = rnd(23);
      ctx.fillStyle = '#3d4045';
      ctx.fillRect(0, 0, S, S);
      const cells = 12;
      const cs = S / cells;
      for (let j = 0; j < cells; j++) {
        for (let i = 0; i < cells; i++) {
          const cx = (i + 0.5 + (r() - 0.5) * 0.35) * cs;
          const cy = (j + 0.5 + (r() - 0.5) * 0.35) * cs;
          const rad = cs * (0.34 + r() * 0.16);
          const sh = 0.6 + r() * 0.55;
          ctx.beginPath();
          let n = 7;
          for (let k = 0; k < n; k++) {
            const a = (k / n) * Math.PI * 2;
            const rr = rad * (0.82 + r() * 0.3);
            const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
            if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fillStyle = `rgb(${(112 * sh) | 0},${(114 * sh) | 0},${(118 * sh) | 0})`;
          ctx.fill();
          ctx.strokeStyle = 'rgba(24,26,30,0.75)';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    },
  }),

  marble: () => buildProcTexture({
    size: 512, strength: 0.9, roughness: 0.32,
    draw(ctx, S) {
      const r = rnd(91);
      const g = ctx.createLinearGradient(0, 0, S, S);
      g.addColorStop(0, '#e8e6e0');
      g.addColorStop(1, '#d6d3cc');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S);
      for (let i = 0; i < 26; i++) {
        ctx.beginPath();
        let x = r() * S, y = r() * S;
        ctx.moveTo(x, y);
        for (let k = 0; k < 24; k++) {
          x += (r() - 0.5) * 70;
          y += 12 + r() * 22;
          ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `rgba(${90 + r() * 60 | 0},${92 + r() * 50 | 0},${100 + r() * 60 | 0},${0.10 + r() * 0.22})`;
        ctx.lineWidth = 1 + r() * 5;
        ctx.stroke();
      }
      for (let i = 0; i < 900; i++) {
        ctx.fillStyle = `rgba(255,255,255,${r() * 0.06})`;
        ctx.fillRect(r() * S, r() * S, 2, 2);
      }
    },
  }),

  stoneblock: () => buildProcTexture({
    size: 512, strength: 2.4, roughness: 0.92,
    draw(ctx, S) {
      const r = rnd(41);
      ctx.fillStyle = '#5d5a52';
      ctx.fillRect(0, 0, S, S);
      const rows = 6;
      const rh = S / rows;
      for (let j = 0; j < rows; j++) {
        const off = (j % 2) * 0.5;
        const cols = 4;
        const cw = S / cols;
        for (let i = 0; i < cols; i++) {
          const x = (i + off) * cw, y = j * rh;
          const sh = 0.78 + r() * 0.42;
          ctx.fillStyle = `rgb(${(128 * sh) | 0},${(124 * sh) | 0},${(112 * sh) | 0})`;
          ctx.fillRect(x + 3, y + 3, cw - 6, rh - 6);
          // grime + chips
          for (let k = 0; k < 26; k++) {
            ctx.fillStyle = `rgba(${60 + r() * 90 | 0},${58 + r() * 80 | 0},${52 + r() * 70 | 0},${r() * 0.22})`;
            ctx.beginPath();
            ctx.arc(x + r() * cw, y + r() * rh, 1 + r() * 9, 0, 7);
            ctx.fill();
          }
          ctx.strokeStyle = 'rgba(38,36,32,0.85)';
          ctx.lineWidth = 3;
          ctx.strokeRect(x + 3, y + 3, cw - 6, rh - 6);
        }
      }
    },
  }),

  woodplanks: () => buildProcTexture({
    size: 512, strength: 1.8, roughness: 0.82,
    draw(ctx, S) {
      const r = rnd(57);
      ctx.fillStyle = '#4a3524';
      ctx.fillRect(0, 0, S, S);
      const planks = 6;
      const ph = S / planks;
      for (let j = 0; j < planks; j++) {
        const sh = 0.7 + r() * 0.5;
        ctx.fillStyle = `rgb(${(122 * sh) | 0},${(86 * sh) | 0},${(52 * sh) | 0})`;
        ctx.fillRect(0, j * ph + 2, S, ph - 4);
        for (let k = 0; k < 90; k++) {
          const y = j * ph + r() * ph;
          ctx.strokeStyle = `rgba(${50 + r() * 60 | 0},${34 + r() * 40 | 0},${20 + r() * 30 | 0},${0.10 + r() * 0.3})`;
          ctx.lineWidth = 0.6 + r() * 1.6;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.bezierCurveTo(S * 0.3, y + (r() - 0.5) * 6, S * 0.6, y + (r() - 0.5) * 6, S, y + (r() - 0.5) * 4);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(20,12,6,0.7)';
        ctx.fillRect(0, j * ph, S, 3);
        // knots
        if (r() < 0.5) {
          const kx = r() * S, ky = j * ph + ph * 0.5;
          for (let m = 0; m < 5; m++) {
            ctx.strokeStyle = `rgba(60,40,22,${0.5 - m * 0.08})`;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.ellipse(kx, ky, 3 + m * 3, 2 + m * 2, r(), 0, 7);
            ctx.stroke();
          }
        }
      }
    },
  }),

  dirtpath: () => buildProcTexture({
    size: 512, strength: 1.5, roughness: 0.95,
    draw(ctx, S) {
      const r = rnd(77);
      ctx.fillStyle = '#5b4a35';
      ctx.fillRect(0, 0, S, S);
      for (let i = 0; i < 2600; i++) {
        const x = r() * S, y = r() * S;
        const c = 0.55 + r() * 0.7;
        ctx.fillStyle = `rgba(${(120 * c) | 0},${(100 * c) | 0},${(72 * c) | 0},${0.25 + r() * 0.4})`;
        ctx.beginPath();
        ctx.ellipse(x, y, 1 + r() * 7, 1 + r() * 5, r() * 3, 0, 7);
        ctx.fill();
      }
      for (let i = 0; i < 200; i++) {
        ctx.fillStyle = `rgba(${140 + r() * 40 | 0},${132 + r() * 30 | 0},${120 + r() * 30 | 0},0.5)`;
        ctx.beginPath();
        ctx.ellipse(r() * S, r() * S, 1 + r() * 3, 1 + r() * 2, r() * 3, 0, 7);
        ctx.fill();
      }
    },
  }),
};
