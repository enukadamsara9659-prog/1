// Chunked-LOD terrain: heightfield sampled in the vertex shader, PBR splat in the fragment.
import * as THREE from 'three';
import { WORLD } from './constants.js';
import settings from '../core/settings.js';

const CHUNKS = 16;                    // 16 x 16 chunks
const CHUNK_SIZE = WORLD.SIZE / CHUNKS;
const LOD_SEGS = [128, 64, 32, 16];   // quads per side at each level

const COMMON = /* glsl */ `
uniform sampler2D tHeight;
uniform sampler2D tSplat;
uniform sampler2D tMask;
uniform sampler2D tGrassC; uniform sampler2D tGrassN;
uniform sampler2D tDirtC;  uniform sampler2D tDirtN;
uniform sampler2D tRockC;  uniform sampler2D tRockN;
uniform sampler2D tSnowC;  uniform sampler2D tSnowN;
uniform float uWorldSize;
uniform float uSkirt;
uniform float uNormalStep;
uniform float uTime;
uniform vec3 uSunDir;

float th(vec2 wxz) { return texture2D(tHeight, wxz / uWorldSize + 0.5).r; }

vec3 terrainNormalW(vec2 wxz, float step) {
  float hl = th(wxz - vec2(step, 0.0));
  float hr = th(wxz + vec2(step, 0.0));
  float hd = th(wxz - vec2(0.0, step));
  float hu = th(wxz + vec2(0.0, step));
  return normalize(vec3(hl - hr, 2.0 * step, hd - hu));
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}

// analytic sun shadow: march the heightfield towards the sun
float terrainSunShadow(vec2 wxz, float h0, vec3 sunDir) {
  if (sunDir.y < 0.015) return 0.0;
  float res = 1.0;
  vec2 dir = normalize(sunDir.xz + vec2(1e-5));
  float tanTheta = sunDir.y / max(0.08, length(sunDir.xz));
  float maxDist = clamp(90.0 / max(0.12, tanTheta), 120.0, 1100.0);
  const int STEPS = 14;
  float stepLen = maxDist / float(STEPS);
  for (int i = 1; i <= STEPS; i++) {
    float t = float(i) * stepLen;
    vec2 p = wxz + dir * t;
    float h = th(p);
    float diff = h - (h0 + t * tanTheta);
    res = min(res, 1.0 - smoothstep(-2.5, 3.5, diff));
    if (res < 0.03) break;
  }
  return clamp(res, 0.0, 1.0);
}
`;

const VERT_HEAD = /* glsl */ `
attribute float aSkirt;
varying vec3 vWXZ;
varying vec3 vWNormal;
varying float vWY;
`;

export class Terrain {
  constructor(world, scene, renderer) {
    this.world = world;
    this.scene = scene;
    this.renderer = renderer;
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    scene.add(this.group);
    this.chunks = [];
    this.uniforms = null;
    this.materials = [];
    this.depthMaterials = [];
    this.time = 0;
  }

  build() {
    const world = this.world;
    const aniso = settings.q('anisotropy');
    const tex = (key) => {
      const t = window.__assets.tex(key);
      if (t) { t.anisotropy = aniso; t.needsUpdate = true; }
      return t;
    };

    this.uniforms = {
      tHeight: { value: world.heightTex },
      tSplat: { value: world.splatTex },
      tMask: { value: world.maskTex },
      tGrassC: { value: tex('terrain.grass.color') },
      tGrassN: { value: tex('terrain.grass.nr') },
      tDirtC: { value: tex('terrain.dirt.color') },
      tDirtN: { value: tex('terrain.dirt.nr') },
      tRockC: { value: tex('terrain.rock.color') },
      tRockN: { value: tex('terrain.rock.nr') },
      tSnowC: { value: tex('terrain.snow.color') },
      tSnowN: { value: tex('terrain.snow.nr') },
      uWorldSize: { value: WORLD.SIZE },
      uSkirt: { value: 30 },
      uNormalStep: { value: WORLD.CELL },
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    };

    // ---- geometries (shared per LOD)
    this.lodGeoms = LOD_SEGS.map((seg) => this.makeGrid(seg, CHUNK_SIZE));
    // ---- materials (one per LOD so the skirt drop can differ)
    for (let l = 0; l < LOD_SEGS.length; l++) {
      const u = THREE.UniformsUtils.clone(this.uniforms);
      // share textures, clone only scalars
      u.tHeight = this.uniforms.tHeight; u.tSplat = this.uniforms.tSplat; u.tMask = this.uniforms.tMask;
      u.tGrassC = this.uniforms.tGrassC; u.tGrassN = this.uniforms.tGrassN;
      u.tDirtC = this.uniforms.tDirtC; u.tDirtN = this.uniforms.tDirtN;
      u.tRockC = this.uniforms.tRockC; u.tRockN = this.uniforms.tRockN;
      u.tSnowC = this.uniforms.tSnowC; u.tSnowN = this.uniforms.tSnowN;
      u.uWorldSize = this.uniforms.uWorldSize;
      u.uTime = this.uniforms.uTime;
      u.uSunDir = this.uniforms.uSunDir;
      u.uSkirt.value = 12 + Math.pow(2, l) * 14;
      u.uNormalStep.value = WORLD.CELL * Math.pow(2, l * 0.7);
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 1, metalness: 0, dithering: true,
      });
      mat.onBeforeCompile = (shader) => this.patchStandard(shader, u);
      mat.customProgramCacheKey = () => 'aetherfall-terrain';
      this.materials.push(mat);

      const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
      depth.onBeforeCompile = (shader) => this.patchDepth(shader, u);
      depth.customProgramCacheKey = () => 'aetherfall-terrain-depth';
      this.depthMaterials.push(depth);
    }

    // ---- chunks
    const half = WORLD.HALF;
    for (let cz = 0; cz < CHUNKS; cz++) {
      for (let cx = 0; cx < CHUNKS; cx++) {
        const ox = -half + (cx + 0.5) * CHUNK_SIZE;
        const oz = -half + (cz + 0.5) * CHUNK_SIZE;
        const mesh = new THREE.Mesh(this.lodGeoms[3], this.materials[3]);
        mesh.position.set(ox, 0, oz);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        mesh.frustumCulled = true;
        mesh.userData = { cx, cz, ox, oz, lod: 3 };
        // bounding sphere from the real min/max height of this chunk
        const { min, max } = this.chunkHeightRange(ox, oz, CHUNK_SIZE);
        const r = Math.hypot(CHUNK_SIZE * 0.71, (max - min) * 0.5 + 4);
        mesh.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, (min + max) * 0.5, 0), r);
        this.setChunkLod(mesh, 3);
        this.group.add(mesh);
        this.chunks.push(mesh);
      }
    }
    this.update(new THREE.Vector3(0, 100, 0), 0, true);
    return this;
  }

  chunkHeightRange(ox, oz, size) {
    const h = this.world.height;
    const N = WORLD.N;
    const i0 = Math.max(0, Math.floor((ox - size / 2) / WORLD.CELL + (N - 1) / 2));
    const i1 = Math.min(N - 1, Math.ceil((ox + size / 2) / WORLD.CELL + (N - 1) / 2));
    const j0 = Math.max(0, Math.floor((oz - size / 2) / WORLD.CELL + (N - 1) / 2));
    const j1 = Math.min(N - 1, Math.ceil((oz + size / 2) / WORLD.CELL + (N - 1) / 2));
    let min = Infinity, max = -Infinity;
    for (let j = j0; j <= j1; j += 2) {
      for (let i = i0; i <= i1; i += 2) {
        const v = h[j * N + i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    return { min, max };
  }

  makeGrid(seg, size) {
    const n = seg + 3; // border ring for the LOD skirt
    const count = n * n;
    const pos = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    const skirt = new Float32Array(count);
    let p = 0, q = 0;
    for (let j = -1; j <= seg + 1; j++) {
      const cj = Math.min(seg, Math.max(0, j));
      for (let i = -1; i <= seg + 1; i++) {
        const ci = Math.min(seg, Math.max(0, i));
        pos[p++] = (ci / seg - 0.5) * size;
        pos[p++] = 0;
        pos[p++] = (cj / seg - 0.5) * size;
        uv[q++] = ci / seg;
        uv[q++] = cj / seg;
        skirt[(j + 1) * n + (i + 1)] = i < 0 || i > seg || j < 0 || j > seg ? 1 : 0;
      }
    }
    const idxCount = (n - 1) * (n - 1) * 6;
    const idx = (count > 65535 ? new Uint32Array(idxCount) : new Uint16Array(idxCount));
    let t = 0;
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx[t++] = a; idx[t++] = c; idx[t++] = b;
        idx[t++] = b; idx[t++] = c; idx[t++] = d;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('aSkirt', new THREE.BufferAttribute(skirt, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), size * 0.75);
    return g;
  }

  setChunkLod(mesh, lod) {
    if (mesh.userData.lod === lod) return;
    mesh.userData.lod = lod;
    mesh.geometry = this.lodGeoms[lod];
    mesh.material = this.materials[lod];
    mesh.customDepthMaterial = this.depthMaterials[lod];
    // keep the per-chunk bounding sphere (geometry is shared → store on mesh)
    mesh.geometry.boundingSphere = mesh.geometry.boundingSphere || new THREE.Sphere();
  }

  update(camPos, dt, force = false) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    const bias = settings.q('lodBias');
    const t0 = 260 * bias, t1 = 620 * bias, t2 = 1500 * bias, t3 = 4200 * bias;
    const halfSize = CHUNK_SIZE * 0.5;
    let changes = 0;
    for (const mesh of this.chunks) {
      const d = this.chunkDistance(mesh, camPos, halfSize);
      let lod = 3;
      if (d < t0) lod = 0; else if (d < t1) lod = 1; else if (d < t2) lod = 2;
      if (force || mesh.userData.lod !== lod) { this.setChunkLod(mesh, lod); changes++; }
      mesh.visible = d < 9000;
    }
    return changes;
  }

  chunkDistance(mesh, camPos, halfSize) {
    const dx = Math.max(0, Math.abs(camPos.x - mesh.userData.ox) - halfSize);
    const dz = Math.max(0, Math.abs(camPos.z - mesh.userData.oz) - halfSize);
    return Math.hypot(dx, dz);
  }

  // ------------------------------------------------------------------ shaders
  patchDepth(shader, u) {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + COMMON + VERT_HEAD + '\nuniform float uSkirtLod;')
      .replace(
        '#include <begin_vertex>',
        `
        vec3 wpos = (modelMatrix * vec4(position, 1.0)).xyz;
        float hh = th(wpos.xz);
        if (aSkirt > 0.5) hh -= uSkirt;
        vec3 transformed = vec3(position.x, hh, position.z);
        `
      );
  }

  patchStandard(shader, u) {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + COMMON + VERT_HEAD)
      .replace(
        '#include <beginnormal_vertex>',
        `
        vec3 wpos = (modelMatrix * vec4(position, 1.0)).xyz;
        float hHere = th(wpos.xz);
        if (aSkirt > 0.5) hHere -= uSkirt;
        vWXZ = wpos;
        vWY = hHere;
        vWNormal = terrainNormalW(wpos.xz + vec2(0.0), uNormalStep);
        vec3 objectNormal = vWNormal;
        `
      )
      .replace(
        '#include <begin_vertex>',
        `
        vec3 transformed = vec3(position.x, vWY, position.z);
        `
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + COMMON + `
        varying vec3 vWXZ;
        varying vec3 vWNormal;
        varying float vWY;
        uniform vec3 uFogColor;
      `)
      .replace(
        '#include <map_fragment>',
        `
        vec2 wxz = vWXZ.xz;
        float elev = vWY;
        vec4 spl = texture2D(tSplat, wxz / uWorldSize + 0.5);
        vec4 msk = texture2D(tMask, wxz / uWorldSize + 0.5);
        float wet = msk.g;
        float scorch = msk.b;
        float moist = msk.a;

        // sharpen the splat weights so biome borders stay crisp
        vec4 w = pow(max(spl, vec4(0.0)), vec4(1.35));
        w /= max(1e-4, w.x + w.y + w.z + w.w);

        float macro = vnoise(wxz * 0.0121);
        float macro2 = vnoise(wxz * 0.043);
        float slope = clamp(1.0 - vWNormal.y, 0.0, 1.0);

        // ---- layer sampling (XZ planar, blended with a second scale to break tiling)
        vec2 uvA = wxz * 0.055;
        vec2 uvB = wxz * 0.0113;
        float mA = 0.62;

        vec3 gC = mix(texture2D(tGrassC, uvA).rgb, texture2D(tGrassC, uvB).rgb, mA);
        vec3 gN = texture2D(tGrassN, uvA).rgb;
        vec3 dC = mix(texture2D(tDirtC, uvA).rgb, texture2D(tDirtC, uvB).rgb, mA);
        vec3 dN = texture2D(tDirtN, uvA).rgb;
        vec3 rC = mix(texture2D(tRockC, uvA * 0.62).rgb, texture2D(tRockC, uvB * 0.62).rgb, mA);
        vec3 rN = texture2D(tRockN, uvA * 0.62).rgb;
        // steep faces get a vertical projection so cliffs do not smear
        vec3 rC2 = texture2D(tRockC, vec2(wxz.x, vWY) * 0.055).rgb;
        vec3 rN2 = texture2D(tRockN, vec2(wxz.x, vWY) * 0.055).rgb;
        float cliff = smoothstep(0.42, 0.78, slope);
        rC = mix(rC, rC2, cliff * 0.65);
        rN = mix(rN, rN2, cliff * 0.65);
        vec3 sC = mix(texture2D(tSnowC, uvA * 0.85).rgb, texture2D(tSnowC, uvB * 0.85).rgb, mA);
        vec3 sN = texture2D(tSnowN, uvA * 0.85).rgb;

        // ---- colour
        vec3 albedo = gC * w.x + dC * w.y + rC * w.z + sC * w.w;

        // macro colour variation (breaks up repetition)
        float tint = (macro - 0.5) * 0.16 + (macro2 - 0.5) * 0.08;
        albedo *= 1.0 + tint;
        albedo.g *= 1.0 + (macro2 - 0.5) * 0.10;

        // beach sand
        float beach = (1.0 - smoothstep(0.6, 4.5, elev)) * (1.0 - smoothstep(0.05, 0.30, slope));
        vec3 sand = vec3(0.76, 0.70, 0.55) * (0.85 + macro * 0.3);
        albedo = mix(albedo, sand, beach * 0.85 * (1.0 - wet * 0.5));

        // wet river beds / shoreline
        albedo = mix(albedo, albedo * vec3(0.55, 0.52, 0.46), clamp(wet * 1.1, 0.0, 0.8));

        // scorched / corrupted ground
        vec3 ash = mix(vec3(0.11, 0.10, 0.11), vec3(0.20, 0.13, 0.15), macro);
        albedo = mix(albedo, ash, clamp(scorch * 1.25, 0.0, 0.92));

        diffuseColor.rgb *= albedo;
        `
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `
        float roughnessFactor = (gN.b * w.x + dN.b * w.y + rN.b * w.z + sN.b * w.w);
        roughnessFactor = clamp(roughnessFactor, 0.28, 1.0);
        roughnessFactor *= 1.0 - clamp(wet * 0.55, 0.0, 0.55);
        roughnessFactor = mix(roughnessFactor, 0.65, scorch * 0.5);
        `
      )
      .replace(
        '#include <normal_fragment_begin>',
        `
        float faceDirection = gl_FrontFacing ? 1.0 : -1.0;
        vec3 nW = normalize(vWNormal);
        // tangent frame for a mostly Y-up surface
        vec3 T = normalize(vec3(1.0, 0.0, 0.0) - nW * nW.x + vec3(1e-4));
        vec3 B = cross(nW, T);
        vec3 ln = gN * w.x + dN * w.y + rN * w.z + sN * w.w;
        vec3 tn = vec3(ln.rg * 2.0 - 1.0, ln.b);
        float nscale = 1.0 - scorch * 0.4;
        tn.xy *= nscale;
        vec3 nWorld = normalize(T * tn.x + B * tn.y + nW * max(tn.z, 0.05));
        vec3 normal = normalize((viewMatrix * vec4(nWorld, 0.0)).xyz);
        vec3 nonPerturbedNormal = normal;
        `
      )
      .replace(
        '#include <lights_fragment_begin>',
        THREE.ShaderChunk.lights_fragment_begin.replace(
          'getDirectionalLightInfo( directionalLight, directLight );',
          `getDirectionalLightInfo( directionalLight, directLight );
           directLight.color *= terrainSunShadow( vWXZ.xz, vWY, uSunDir );`
        )
      )
      .replace(
        '#include <aomap_fragment>',
        `
        // heightfield ambient occlusion (cheap horizon sampling)
        float ao = 0.0;
        const int AO_TAPS = 6;
        for (int i = 0; i < AO_TAPS; i++) {
          float a = (float(i) / float(AO_TAPS)) * 6.2831853 + 0.7;
          float r = 6.0 + float(i % 3) * 16.0;
          vec2 o = vec2(cos(a), sin(a)) * r;
          float ho = th(wxz + o);
          float dh = ho - vWY;
          ao += clamp(dh / (r * 0.55), -1.0, 1.0);
        }
        ao = 1.0 - clamp(ao / float(AO_TAPS) * 0.85, -0.35, 0.9);
        reflectedLight.indirectDiffuse *= ao;
        reflectedLight.indirectSpecular *= mix(1.0, ao, 0.5);
        `
      );
  }
}
