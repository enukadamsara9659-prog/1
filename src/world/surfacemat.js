// Shared PBR surface material helper: colour map + packed (normal.rg, roughness) map.
import * as THREE from 'three';

const patched = new WeakSet();

/**
 * @param {THREE.Texture} color  sRGB colour map
 * @param {THREE.Texture} nr     linear map: R,G = normal xy, B = roughness
 */
export function surfaceMaterial(color, nr, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    map: color || null,
    normalMap: nr || null,
    color: opts.color ?? 0xffffff,
    roughness: opts.roughness ?? 1,
    metalness: opts.metalness ?? 0,
    side: opts.side ?? THREE.FrontSide,
    transparent: !!opts.transparent,
    alphaTest: opts.alphaTest ?? 0,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    flatShading: !!opts.flatShading,
    envMapIntensity: opts.envMapIntensity ?? 1,
  });
  if (nr) {
    mat.userData.roughScale = opts.roughScale ?? 1.35;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uRoughScale = { value: mat.userData.roughScale };
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uRoughScale;')
        .replace(
          '#include <normal_fragment_maps>',
          `
          #ifdef USE_NORMALMAP_TANGENTSPACE
            vec3 nrraw = texture2D( normalMap, vNormalMapUv ).xyz;
            vec3 mapN = vec3( nrraw.rg * 2.0 - 1.0, 0.0 );
            mapN.z = sqrt( max( 0.0, 1.0 - clamp( dot( mapN.xy, mapN.xy ), 0.0, 1.0 ) ) );
            mapN.xy *= normalScale;
            normal = normalize( tbn * mapN );
          #endif
          `
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `
          #ifdef USE_NORMALMAP_TANGENTSPACE
            float roughnessFactor = clamp( texture2D( normalMap, vNormalMapUv ).b * uRoughScale, 0.08, 1.0 ) * roughness;
          #else
            float roughnessFactor = roughness;
          #endif
          `
        );
    };
    mat.customProgramCacheKey = () => 'aetherfall-surface';
  }
  if (opts.repeat) {
    if (color) { color.wrapS = color.wrapT = THREE.RepeatWrapping; }
    if (nr) { nr.wrapS = nr.wrapT = THREE.RepeatWrapping; }
  }
  return mat;
}

/** Box with world-scaled UVs so textures tile consistently across faces. */
const boxCache = new Map();
export function makeBox(w, h, d, uvScale = 0.5) {
  const key = `${w.toFixed(3)},${h.toFixed(3)},${d.toFixed(3)},${uvScale}`;
  let g = boxCache.get(key);
  if (g) return g;
  g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const pos = g.attributes.position;
  const nrm = g.attributes.normal;
  for (let i = 0; i < uv.count; i++) {
    const ax = Math.abs(nrm.getX(i)), ay = Math.abs(nrm.getY(i)), az = Math.abs(nrm.getZ(i));
    let u, v;
    if (ax > 0.5) { u = pos.getZ(i); v = pos.getY(i); }
    else if (ay > 0.5) { u = pos.getX(i); v = pos.getZ(i); }
    else { u = pos.getX(i); v = pos.getY(i); }
    uv.setXY(i, u * uvScale, v * uvScale);
  }
  uv.needsUpdate = true;
  boxCache.set(key, g);
  return g;
}

/** Triangular prism (gable ends, pediments). */
/** give a triangle-soup geometry an identity index so it can merge with indexed ones */
function ensureIndexed(g) {
  if (g.index) return g;
  const n = g.attributes.position.count;
  const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

export function makePrism(w, h, d, uvScale = 0.5) {
  const hw = w / 2, hd = d / 2;
  const v = [
    -hw, 0, hd, hw, 0, hd, 0, h, hd,      // front (0,1,2)
    -hw, 0, -hd, hw, 0, -hd, 0, h, -hd,   // back  (3,4,5)
  ];
  const g = new THREE.BufferGeometry();
  // faces: front, back, left, right, bottom
  const tris = [
    [0, 1, 2], [4, 3, 5],
    [3, 0, 2], [3, 2, 5],
    [1, 4, 5], [1, 5, 2],
    [3, 4, 1], [3, 1, 0],
  ];
  const pos = [], uvs = [];
  for (const [a, b, c] of tris) {
    for (const i of [a, b, c]) {
      pos.push(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
    }
  }
  // simple planar uv
  for (let f = 0; f < tris.length; f++) {
    for (let k = 0; k < 3; k++) {
      const i = tris[f][k];
      uvs.push((v[i * 3] + hw) * uvScale, (v[i * 3 + 1]) * uvScale);
    }
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  return ensureIndexed(g);
}

/** cylinder helper for columns / logs */
export function makeCylinder(rTop, rBottom, h, seg = 12, uvScale = 0.5) {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, false);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * uvScale * h * 0.5, uv.getY(i) * uvScale * h * 0.5);
  uv.needsUpdate = true;
  return g;
}
