// Ocean, lakes and flowing rivers.
import * as THREE from 'three';
import { WORLD } from './constants.js';
import { NOISE_GLSL, SKY_GLSL } from './shaders.js';
import settings from '../core/settings.js';

const VERT = /* glsl */ `
precision highp float;
attribute vec2 attribute_flow;
uniform float uTime;
uniform vec2 uWind;
uniform float uWaveScale;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vTangent;

// Gerstner wave sum
vec3 gerstner(vec2 p, vec2 dir, float amp, float len, float speed, float steep, out vec3 nrm) {
  float k = 6.2831853 / len;
  float f = k * (dot(dir, p) - speed * uTime);
  float a = steep / k;
  nrm += vec3(-dir.x * k * amp * cos(f), 0.0, -dir.y * k * amp * cos(f));
  return vec3(dir.x * a * amp * cos(f), amp * sin(f), dir.y * a * amp * cos(f));
}

void main() {
  vec3 pos = position;
  vec3 wpos = (modelMatrix * vec4(pos, 1.0)).xyz;
  vUv = uv;
  #ifndef RIVER
    vec3 nrm = vec3(0.0, 1.0, 0.0);
    vec2 d1 = normalize(uWind + vec2(0.31, -0.14));
    vec2 d2 = normalize(uWind * 0.7 + vec2(-0.62, 0.4));
    vec2 d3 = normalize(uWind * 1.4 + vec2(0.9, 0.75));
    vec2 d4 = normalize(uWind * 0.4 + vec2(-0.3, -0.9));
    float s = uWaveScale;
    vec3 disp = vec3(0.0);
    disp += gerstner(wpos.xz, d1, 0.42 * s, 62.0, 9.0, 0.62, nrm);
    disp += gerstner(wpos.xz, d2, 0.26 * s, 34.0, 7.2, 0.55, nrm);
    disp += gerstner(wpos.xz, d3, 0.13 * s, 17.0, 5.4, 0.48, nrm);
    disp += gerstner(wpos.xz, d4, 0.06 * s, 8.5, 4.1, 0.40, nrm);
    wpos += disp;
    vNormal = normalize(nrm);
    vTangent = normalize(vec3(1.0, 0.0, 0.0) + vec3(disp.x * 0.2, 0.0, disp.z * 0.2));
  #else
    vNormal = vec3(0.0, 1.0, 0.0);
    vTangent = normalize(vec3(attribute_flow.x, 0.0, attribute_flow.y));
  #endif
  vWorldPos = wpos;
  gl_Position = projectionMatrix * viewMatrix * vec4(wpos, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunI;
uniform float uSkyGain;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uFoamColor;
uniform sampler2D tNormalMap;
uniform sampler2D tHeight;
uniform float uWorldSize;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uGroundColor;
uniform float uGroundLit;
uniform float uFlowSpeed;
uniform float uWaterLevel;
uniform int uSteps;
uniform int uLightSteps;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vTangent;

${NOISE_GLSL}
${SKY_GLSL}

float terrainH(vec2 wxz){ return texture2D(tHeight, wxz / uWorldSize + 0.5).r; }

void main() {
  vec3 V = normalize(uCamPos - vWorldPos);
  float dist = length(uCamPos - vWorldPos);

  // --- animated normal maps (detail fades with distance to avoid aliasing)
  vec2 flowDir = normalize(vTangent.xz + vec2(1e-5));
  float fade = 1.0 - smoothstep(80.0, 900.0, dist);
  vec2 baseUv = vWorldPos.xz * 0.035;
  vec3 n1 = texture2D(tNormalMap, baseUv + flowDir * uTime * uFlowSpeed * 0.035).rgb * 2.0 - 1.0;
  vec3 n2 = texture2D(tNormalMap, baseUv * 0.42 - flowDir * uTime * uFlowSpeed * 0.021 + vec2(0.37, 0.11)).rgb * 2.0 - 1.0;
  vec3 n3 = texture2D(tNormalMap, baseUv * 3.1 + vec2(uTime * 0.03, uTime * -0.02)).rgb * 2.0 - 1.0;
  float detailMix = mix(0.35, 1.0, fade);
  vec3 nrm = normalize(vec3(n1.rg * 1.0 + n2.rg * 0.8 + n3.rg * 0.35 * detailMix, 1.4));
  vec3 N = normalize(vNormal + vec3(nrm.x, 0.0, nrm.y) * detailMix);
  N = normalize(N);

  float depth = max(0.0, uWaterLevel - terrainH(vWorldPos.xz));

  // --- reflection (analytic sky) + sun specular
  vec3 R = reflect(-V, N);
  R.y = abs(R.y) * 0.92 + 0.02;
  vec3 skyRefl = atmosphere(vec3(0.0, Re + vWorldPos.y, 0.0), normalize(R), uSunDir, uSunI, uSteps, uLightSteps, uGroundColor, uGroundLit) * uSkyGain;
  float fres = 0.02 + 0.98 * pow(clamp(1.0 - max(dot(N, V), 0.0), 0.0, 1.0), 5.0);
  vec3 H = normalize(V + uSunDir);
  float spec = pow(max(dot(N, H), 0.0), 620.0) * 26.0 + pow(max(dot(N, H), 0.0), 90.0) * 1.4;

  // --- body / refraction colour from the terrain depth below
  float depthFade = 1.0 - exp(-depth * 0.42);
  vec3 body = mix(uShallow, uDeep, depthFade);
  float sunUp = max(dot(uSunDir, vec3(0.0, 1.0, 0.0)), 0.0);
  body *= 0.35 + 0.85 * sunUp;

  vec3 col = mix(body, skyRefl, clamp(fres, 0.0, 1.0));
  col += uSunColor * spec * clamp(fres * 1.6, 0.0, 1.0) * (0.4 + 0.6 * sunUp);

  // --- foam: shoreline + wave crests + river turbulence
  float shore = smoothstep(0.75, 0.02, depth);
  float ripple = fbm2(vWorldPos.xz * 0.55 + flowDir * uTime * 0.7, 3);
  float foam = clamp(shore * (0.55 + 0.65 * ripple), 0.0, 1.0);
  #ifdef RIVER
    float turb = fbm2(vec2(vUv.y * 0.55 - uTime * 1.6, vUv.x * 3.0), 3);
    foam = clamp(foam + smoothstep(0.62, 0.95, turb) * 0.55 + smoothstep(0.1, 0.0, min(vUv.x, 1.0 - vUv.x)) * 0.4, 0.0, 1.0);
  #endif
  col = mix(col, uFoamColor * (0.7 + 0.5 * ripple), foam * 0.85);

  // --- fog
  float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist * 1.1);
  col = mix(col, uFogColor, clamp(fogFactor, 0.0, 1.0));

  gl_FragColor = vec4(col, 1.0);
}
`;

export class Water {
  constructor(scene, world, sky) {
    this.scene = scene;
    this.world = world;
    this.sky = sky;
    this.group = new THREE.Group();
    this.group.name = 'water';
    scene.add(this.group);
    this.time = 0;

    const common = () => ({
      uTime: { value: 0 },
      uCamPos: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uSunI: { value: 20 },
      uSkyGain: { value: 0.16 },
      uShallow: { value: new THREE.Color(0.16, 0.42, 0.44) },
      uDeep: { value: new THREE.Color(0.008, 0.052, 0.088) },
      uFoamColor: { value: new THREE.Color(0.86, 0.92, 0.95) },
      tNormalMap: { value: null },
      tHeight: { value: world.heightTex },
      uWorldSize: { value: WORLD.SIZE },
      uFogColor: { value: new THREE.Color(0.6, 0.7, 0.8) },
      uFogDensity: { value: 0.00016 },
      uGroundColor: { value: new THREE.Color(0.09, 0.10, 0.075) },
      uGroundLit: { value: 1 },
      uFlowSpeed: { value: 1 },
      uWaterLevel: { value: WORLD.SEA_LEVEL },
      uWind: { value: new THREE.Vector2(1, 0.35) },
      uWaveScale: { value: 1 },
      uSteps: { value: 6 },
      uLightSteps: { value: 3 },
    });

    this.oceanMat = new THREE.ShaderMaterial({
      uniforms: common(), vertexShader: VERT, fragmentShader: FRAG,
      fog: false, side: THREE.FrontSide,
    });
    this.riverMat = new THREE.ShaderMaterial({
      uniforms: common(), vertexShader: VERT, fragmentShader: FRAG,
      defines: { RIVER: '' }, fog: false, side: THREE.DoubleSide, transparent: true,
    });
    this.riverMat.uniforms.uFlowSpeed.value = 3.2;
    this.riverMat.uniforms.uShallow.value = new THREE.Color(0.18, 0.34, 0.30);
    this.riverMat.uniforms.uDeep.value = new THREE.Color(0.02, 0.09, 0.09);
  }

  build() {
    const aniso = settings.q('anisotropy');
    const wn = window.__assets.tex('waternormals');
    if (wn) { wn.anisotropy = aniso; wn.wrapS = wn.wrapT = THREE.RepeatWrapping; }
    this.oceanMat.uniforms.tNormalMap.value = wn;
    this.riverMat.uniforms.tNormalMap.value = wn;

    // --- ocean: a detailed patch that follows the camera + a huge flat skirt
    const detail = settings.q('waterDetail');
    const seg = Math.round(120 * detail);
    this.near = new THREE.Mesh(new THREE.PlaneGeometry(2600, 2600, seg, seg), this.oceanMat);
    this.near.rotation.x = -Math.PI / 2;
    this.near.frustumCulled = false;
    this.near.renderOrder = 2;
    this.group.add(this.near);

    this.far = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000, 1, 1), this.oceanMat);
    this.far.rotation.x = -Math.PI / 2;
    this.far.frustumCulled = false;
    this.far.renderOrder = 1;
    this.group.add(this.far);

    // --- rivers
    for (const r of this.world.rivers) {
      const mesh = this.buildRiverMesh(r);
      if (mesh) { this.group.add(mesh); }
    }
    return this;
  }

  buildRiverMesh(river) {
    const { pts, count } = river;
    if (count < 4) return null;
    const pos = [], uvs = [], flows = [], idx = [];
    let along = 0;
    for (let i = 0; i < count; i++) {
      const x = pts[i * 4], z = pts[i * 4 + 1], bed = pts[i * 4 + 2], w = pts[i * 4 + 3];
      const nx = i < count - 1 ? pts[(i + 1) * 4] - x : x - pts[(i - 1) * 4];
      const nz = i < count - 1 ? pts[(i + 1) * 4 + 1] - z : z - pts[(i - 1) * 4 + 1];
      const l = Math.hypot(nx, nz) || 1;
      const tx = nx / l, tz = nz / l;
      const px = -tz, pz = tx;   // perpendicular
      const y = Math.max(WORLD.SEA_LEVEL + 0.05, bed + Math.min(2.2, w * 0.22));
      pos.push(x + px * w, y, z + pz * w);
      pos.push(x - px * w, y, z - pz * w);
      uvs.push(0, along, 1, along);
      flows.push(tx, tz, tx, tz);
      if (i > 0) along += Math.hypot(pts[i * 4] - pts[(i - 1) * 4], pts[i * 4 + 1] - pts[(i - 1) * 4 + 1]);
      uvs[uvs.length - 3] = along;
      uvs[uvs.length - 1] = along;
    }
    for (let i = 0; i < count - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('attribute_flow', new THREE.Float32BufferAttribute(flows, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, this.riverMat);
    m.renderOrder = 3;
    m.frustumCulled = true;
    return m;
  }

  update(dt, camera) {
    this.time += dt;
    for (const mat of [this.oceanMat, this.riverMat]) {
      const u = mat.uniforms;
      u.uTime.value = this.time;
      u.uCamPos.value.copy(camera.position);
      u.uSunDir.value.copy(this.sky.sunDir);
      u.uSunColor.value.copy(this.sky.sunColor);
      u.uSunI.value = this.sky.material.uniforms.uSunI.value;
      u.uSkyGain.value = this.sky.material.uniforms.uSkyGain.value;
      u.uGroundLit.value = this.sky.material.uniforms.uGroundLit.value;
      u.uFogColor.value.copy(this.sky.fogColor || new THREE.Color(0.7, 0.8, 0.9));
      u.uFogDensity.value = this.scene.fog ? this.scene.fog.density : 0.00016;
      u.uWind.value.copy(this.sky.weather.wind);
      u.uWaveScale.value = 0.7 + this.sky.weather.windSpeed * 0.09;
    }
    // keep the ocean patch centred (snapped so the waves do not crawl)
    const snap = 8;
    this.near.position.set(Math.round(camera.position.x / snap) * snap, WORLD.SEA_LEVEL, Math.round(camera.position.z / snap) * snap);
    this.far.position.set(camera.position.x, WORLD.SEA_LEVEL - 0.05, camera.position.z);
  }
}
