// Custom post-processing stack: clouds → composite → bloom → final grade → AA.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { CLOUD_GLSL, NOISE_GLSL } from '../world/shaders.js';
import settings from '../core/settings.js';

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const CLOUD_FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 outColor;
varying vec2 vUv;
uniform sampler2D tDepth;
uniform sampler2D tScene;
uniform vec3 uCamPos;
uniform mat4 uInvViewProj;
uniform float uNear, uFar;
uniform float uTime;
uniform vec2 uBlueNoiseOffset;
${NOISE_GLSL}
${CLOUD_GLSL}

float viewZFromDepth(float d){
  return (uNear * uFar) / ((uFar - uNear) * d - uFar);
}

void main(){
  vec2 uv = vUv;
  vec4 clip = vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec4 world = uInvViewProj * clip;
  vec3 farPoint = world.xyz / world.w;
  vec3 rd = normalize(farPoint - uCamPos);

  float d = texture2D(tDepth, uv).x;
  float sceneDist = 1e9;
  if (d < 0.999999) {
    float vz = -viewZFromDepth(d);
    float cosA = max(dot(rd, normalize(farPoint - uCamPos)), 1e-4);
    sceneDist = vz / max(0.15, abs(cosA));
  }

  float stepsF = uCloudSteps;
  float jitter = fract(sin(dot(uv * uResolution + uBlueNoiseOffset, vec2(12.9898, 78.233))) * 43758.5453);
  vec4 c = marchClouds(uCamPos, rd, min(sceneDist, 26000.0), int(stepsF), jitter);
  outColor = vec4(c.rgb, c.a);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tClouds;
void main(){
  vec4 scene = texture2D(tScene, vUv);
  vec4 cl = texture2D(tClouds, vUv);
  gl_FragColor = vec4(scene.rgb * cl.a + cl.rgb, 1.0);
}
`;

const BRIGHT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform float uThreshold;
uniform float uSoft;
void main(){
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float k = max(0.0, l - uThreshold) / max(l, 1e-4);
  gl_FragColor = vec4(c * k * smoothstep(0.0, uSoft, l - uThreshold), 1.0);
}
`;

const DOWN_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
void main(){
  vec3 a = texture2D(tDiffuse, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  vec3 b = texture2D(tDiffuse, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  vec3 c = texture2D(tDiffuse, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  vec3 d = texture2D(tDiffuse, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  vec3 e = texture2D(tDiffuse, vUv).rgb;
  vec3 f = texture2D(tDiffuse, vUv + uTexel * vec2(-2.0, 0.0)).rgb;
  vec3 g = texture2D(tDiffuse, vUv + uTexel * vec2( 2.0, 0.0)).rgb;
  vec3 h = texture2D(tDiffuse, vUv + uTexel * vec2( 0.0, -2.0)).rgb;
  vec3 i = texture2D(tDiffuse, vUv + uTexel * vec2( 0.0,  2.0)).rgb;
  vec3 sum = (a+b+c+d) * 0.125 + e * 0.125 + (f+g+h+i) * 0.03125;
  gl_FragColor = vec4(sum, 1.0);
}
`;

const UP_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
uniform float uRadius;
void main(){
  vec3 s = vec3(0.0);
  s += texture2D(tDiffuse, vUv + uTexel * vec2(-1.0, -1.0) * uRadius).rgb;
  s += texture2D(tDiffuse, vUv + uTexel * vec2( 0.0, -1.0) * uRadius).rgb * 2.0;
  s += texture2D(tDiffuse, vUv + uTexel * vec2( 1.0, -1.0) * uRadius).rgb;
  s += texture2D(tDiffuse, vUv + uTexel * vec2(-1.0,  0.0) * uRadius).rgb * 2.0;
  s += texture2D(tDiffuse, vUv).rgb * 4.0;
  s += texture2D(tDiffuse, vUv + uTexel * vec2( 1.0,  0.0) * uRadius).rgb * 2.0;
  s += texture2D(tDiffuse, vUv + uTexel * vec2(-1.0,  1.0) * uRadius).rgb;
  s += texture2D(tDiffuse, vUv + uTexel * vec2( 0.0,  1.0) * uRadius).rgb * 2.0;
  s += texture2D(tDiffuse, vUv + uTexel * vec2( 1.0,  1.0) * uRadius).rgb;
  gl_FragColor = vec4(s / 16.0, 1.0);
}
`;

const FINAL_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform sampler2D tDepth;
uniform float uBloom;
uniform float uExposure;
uniform float uVignette;
uniform float uGrain;
uniform float uAberration;
uniform float uTime;
uniform float uNear, uFar;
uniform float uFocusDist;
uniform float uDofAmount;
uniform float uSaturation;
uniform float uContrast;
uniform vec2 uTexel;
uniform float uUnderwater;
uniform vec3 uUnderColor;
${NOISE_GLSL}

float viewZ(float d){ return (uNear * uFar) / ((uFar - uNear) * d - uFar); }

void main(){
  vec2 uv = vUv;
  float depth = texture2D(tDepth, uv).x;
  float dist = -viewZ(depth);

  // --- depth of field (cheap 12 tap disc, radius from CoC)
  vec3 col;
  float coc = clamp(abs(dist - uFocusDist) / max(1.0, uFocusDist * 1.6), 0.0, 1.0);
  coc = pow(coc, 1.4) * uDofAmount;
  if (coc > 0.002) {
    vec3 acc = texture2D(tDiffuse, uv).rgb;
    float wsum = 1.0;
    for (int i = 0; i < 12; i++){
      float a = float(i) * 2.39996;
      float r = sqrt(float(i) + 0.5) / 3.464;
      vec2 off = vec2(cos(a), sin(a)) * r * coc * 0.035;
      acc += texture2D(tDiffuse, uv + off).rgb;
      wsum += 1.0;
    }
    col = acc / wsum;
  } else {
    col = texture2D(tDiffuse, uv).rgb;
  }

  // --- chromatic aberration
  if (uAberration > 0.0001){
    vec2 dir = (uv - 0.5);
    float amt = uAberration * dot(dir, dir) * 2.2;
    col.r = texture2D(tDiffuse, uv + dir * amt).r;
    col.b = texture2D(tDiffuse, uv - dir * amt).b;
  }

  col += texture2D(tBloom, uv).rgb * uBloom;
  col *= uExposure;

  // --- underwater tint
  col = mix(col, uUnderColor * (0.5 + 0.5 * col), uUnderwater);

  // --- grade
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSaturation);
  col = (col - 0.5) * uContrast + 0.5;
  col = max(col, vec3(0.0));

  // --- filmic tonemap (ACES approximation)
  vec3 x = col;
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  col = clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);

  // --- vignette + grain
  float v = 1.0 - uVignette * dot(uv - 0.5, uv - 0.5) * 2.4;
  col *= clamp(v, 0.0, 1.0);
  float g = vnoise2(uv * 900.0 + uTime * 60.0) - 0.5;
  col += g * uGrain * (1.0 - smoothstep(0.0, 0.7, dot(col, vec3(0.333))));

  // --- sRGB
  col = mix(col * 12.92, 1.055 * pow(max(col, vec3(1e-5)), vec3(1.0/2.4)) - 0.055, step(0.0031308, col));
  gl_FragColor = vec4(col, 1.0);
}
`;

const FXAA_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
void main(){
  vec3 rgbNW = texture2D(tDiffuse, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
  vec3 rgbNE = texture2D(tDiffuse, vUv + vec2( 1.0, -1.0) * uTexel).rgb;
  vec3 rgbSW = texture2D(tDiffuse, vUv + vec2(-1.0,  1.0) * uTexel).rgb;
  vec3 rgbSE = texture2D(tDiffuse, vUv + vec2( 1.0,  1.0) * uTexel).rgb;
  vec3 rgbM  = texture2D(tDiffuse, vUv).rgb;
  vec3 luma = vec3(0.299, 0.587, 0.114);
  float lNW = dot(rgbNW, luma), lNE = dot(rgbNE, luma);
  float lSW = dot(rgbSW, luma), lSE = dot(rgbSE, luma), lM = dot(rgbM, luma);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float lSum = lNW + lNE + lSW + lSE;
  float reduce = max(lSum * 0.03125, 0.0078125);
  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcp, -8.0, 8.0) * uTexel;
  vec3 a = 0.5 * (texture2D(tDiffuse, vUv + dir * (1.0/3.0 - 0.5)).rgb + texture2D(tDiffuse, vUv + dir * (2.0/3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture2D(tDiffuse, vUv + dir * -0.5).rgb + texture2D(tDiffuse, vUv + dir * 0.5).rgb);
  float lB = dot(b, luma);
  gl_FragColor = vec4(((lB < lMin) || (lB > lMax)) ? a : b, 1.0);
}
`;

function makeRT(w, h, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(2, w), Math.max(2, h), {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: !!opts.depth,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  if (opts.depthTexture) {
    rt.depthTexture = new THREE.DepthTexture(Math.max(2, w), Math.max(2, h));
    rt.depthTexture.type = THREE.UnsignedIntType;
  }
  return rt;
}

export class PostFX {
  constructor(renderer, scene, camera, sky) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.sky = sky;
    this.enabled = true;
    this.frame = 0;
    this.time = 0;

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.width = size.x;
    this.height = size.y;

    this.sceneRT = makeRT(this.width, this.height, { depth: true, depthTexture: true });
    this.cloudRT = makeRT(this.width * 0.5, this.height * 0.5);
    this.compRT = makeRT(this.width, this.height);
    this.finalRT = makeRT(this.width, this.height);
    this.bloomRTs = [];
    for (let i = 0; i < 5; i++) {
      const d = Math.pow(2, i + 1);
      this.bloomRTs.push(makeRT(Math.max(4, Math.floor(this.width / d)), Math.max(4, Math.floor(this.height / d))));
    }

    this.quad = new FullScreenQuad(null);

    this.cloudMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        tDepth: { value: this.sceneRT.depthTexture },
        tScene: { value: this.sceneRT.texture },
        uCamPos: { value: new THREE.Vector3() },
        uInvViewProj: { value: new THREE.Matrix4() },
        uNear: { value: camera.near }, uFar: { value: camera.far },
        uTime: { value: 0 },
        uBlueNoiseOffset: { value: new THREE.Vector2() },
        tNoise: { value: null },
        uWind: { value: new THREE.Vector3(0.02, 0, 0.008) },
        uCoverage: { value: 0.5 },
        uCloudBottom: { value: 1500 }, uCloudTop: { value: 4600 },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uSkyColor: { value: new THREE.Color(0.5, 0.7, 1) },
        uResolution: { value: new THREE.Vector2(this.width, this.height) },
        uCloudSteps: { value: 28 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: CLOUD_FRAG,
      depthTest: false, depthWrite: false,
    });

    this.compMat = new THREE.ShaderMaterial({
      uniforms: { tScene: { value: this.sceneRT.texture }, tClouds: { value: this.cloudRT.texture } },
      vertexShader: QUAD_VERT, fragmentShader: COMPOSITE_FRAG, depthTest: false, depthWrite: false,
    });

    this.brightMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uThreshold: { value: 1.05 }, uSoft: { value: 0.6 } },
      vertexShader: QUAD_VERT, fragmentShader: BRIGHT_FRAG, depthTest: false, depthWrite: false,
    });
    this.downMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: QUAD_VERT, fragmentShader: DOWN_FRAG, depthTest: false, depthWrite: false,
    });
    this.upMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 } },
      vertexShader: QUAD_VERT, fragmentShader: UP_FRAG, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
      transparent: true,
    });

    this.finalMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.compRT.texture },
        tBloom: { value: this.bloomRTs[0].texture },
        tDepth: { value: this.sceneRT.depthTexture },
        uBloom: { value: 0.55 }, uExposure: { value: 1.0 },
        uVignette: { value: 0.35 }, uGrain: { value: 0.035 },
        uAberration: { value: 0.0012 }, uTime: { value: 0 },
        uNear: { value: camera.near }, uFar: { value: camera.far },
        uFocusDist: { value: 30 }, uDofAmount: { value: 0.5 },
        uSaturation: { value: 1.06 }, uContrast: { value: 1.04 },
        uTexel: { value: new THREE.Vector2(1 / this.width, 1 / this.height) },
        uUnderwater: { value: 0 }, uUnderColor: { value: new THREE.Color(0.06, 0.22, 0.3) },
      },
      vertexShader: QUAD_VERT, fragmentShader: FINAL_FRAG, depthTest: false, depthWrite: false,
    });

    this.fxaaMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: this.finalRT.texture }, uTexel: { value: new THREE.Vector2(1 / this.width, 1 / this.height) } },
      vertexShader: QUAD_VERT, fragmentShader: FXAA_FRAG, depthTest: false, depthWrite: false,
    });

    this.smaa = new SMAAPass();
    this.smaa.setSize(this.width, this.height);
    this.smaa.enabled = false;
    this.applyQuality();
  }

  setCloudNoise(tex) { this.cloudMat.uniforms.tNoise.value = tex; }

  applyQuality() {
    const p = settings.preset;
    this.cloudMat.uniforms.uCloudSteps.value = Math.max(1, p.clouds || 0);
    this.finalMat.uniforms.uDofAmount.value = p.dof ? 0.85 : 0;
    this.finalMat.uniforms.uAberration.value = p.aberration ? 0.0013 : 0;
    this.finalMat.uniforms.uGrain.value = p.grain ? 0.03 : 0;
    this.finalMat.uniforms.uBloom.value = p.bloom ? 0.6 : 0;
    this.cloudsEnabled = (p.clouds || 0) > 0;
    this.aa = p.aa;
    this.smaa.enabled = p.aa === 'smaa';
  }

  setSize(w, h) {
    this.width = Math.max(2, w);
    this.height = Math.max(2, h);
    this.sceneRT.setSize(this.width, this.height);
    this.compRT.setSize(this.width, this.height);
    this.finalRT.setSize(this.width, this.height);
    const cw = Math.floor(this.width * 0.5), ch = Math.floor(this.height * 0.5);
    this.cloudRT.setSize(cw, ch);
    this.bloomRTs.forEach((rt, i) => {
      const d = Math.pow(2, i + 1);
      rt.setSize(Math.max(4, Math.floor(this.width / d)), Math.max(4, Math.floor(this.height / d)));
    });
    this.finalMat.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    this.fxaaMat.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    this.cloudMat.uniforms.uResolution.value.set(this.width, this.height);
    if (this.smaa) this.smaa.setSize(this.width, this.height);
  }

  render(dt, opts = {}) {
    const renderer = this.renderer;
    const cam = this.camera;
    this.time += dt;
    this.frame++;

    if (!this.enabled) {
      renderer.setRenderTarget(null);
      renderer.render(this.scene, cam);
      return;
    }

    // ---- 1. scene
    renderer.setRenderTarget(this.sceneRT);
    renderer.clear(true, true, false);
    renderer.render(this.scene, cam);

    // ---- 2. clouds
    if (this.cloudsEnabled) {
      const u = this.cloudMat.uniforms;
      u.uCamPos.value.copy(cam.position);
      u.uNear.value = cam.near; u.uFar.value = cam.far;
      u.uTime.value = this.time;
      u.uSunDir.value.copy(this.sky.sunDir);
      u.uSunColor.value.copy(this.sky.sunColor).multiplyScalar(Math.max(0.25, this.sky.sunIntensity));
      u.uSkyColor.value.copy(this.sky.zenithColor).multiplyScalar(0.6).addScalar(0.08);
      u.uCoverage.value = this.sky.weather.cloudiness;
      u.uWind.value.set(this.sky.weather.wind.x * 0.008, 0, this.sky.weather.wind.y * 0.008);
      u.uBlueNoiseOffset.value.set((this.frame % 8) * 0.125, ((this.frame >> 3) % 8) * 0.125);
      const m = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      u.uInvViewProj.value.copy(m).invert();
      this.blit(this.cloudMat, this.cloudRT);
    } else {
      renderer.setRenderTarget(this.cloudRT);
      renderer.setClearColor(0x000000, 1);
      renderer.clear(true, false, false);
    }

    // ---- 3. composite clouds over the scene
    this.blit(this.compMat, this.compRT);

    // ---- 4. bloom
    if (settings.preset.bloom) {
      this.brightMat.uniforms.tDiffuse.value = this.compRT.texture;
      this.blit(this.brightMat, this.bloomRTs[0]);
      for (let i = 1; i < this.bloomRTs.length; i++) {
        this.downMat.uniforms.tDiffuse.value = this.bloomRTs[i - 1].texture;
        this.downMat.uniforms.uTexel.value.set(1 / this.bloomRTs[i - 1].width, 1 / this.bloomRTs[i - 1].height);
        this.blit(this.downMat, this.bloomRTs[i]);
      }
      for (let i = this.bloomRTs.length - 1; i > 0; i--) {
        this.upMat.uniforms.tDiffuse.value = this.bloomRTs[i].texture;
        this.upMat.uniforms.uTexel.value.set(1 / this.bloomRTs[i].width, 1 / this.bloomRTs[i].height);
        this.blit(this.upMat, this.bloomRTs[i - 1], false);
      }
    } else {
      renderer.setRenderTarget(this.bloomRTs[0]);
      renderer.setClearColor(0x000000, 1);
      renderer.clear(true, false, false);
    }

    // ---- 5. final grade
    const f = this.finalMat.uniforms;
    f.uTime.value = this.time;
    f.uFocusDist.value = opts.focusDist ?? 35;
    f.uUnderwater.value = opts.underwater ? 1 : 0;
    f.uExposure.value = opts.exposure ?? 1;
    this.blit(this.finalMat, this.finalRT);

    // ---- 6. anti-aliasing → screen
    renderer.setRenderTarget(null);
    if (this.aa === 'smaa') {
      this.smaa.render(renderer, null, this.finalRT);
    } else {
      this.fxaaMat.uniforms.tDiffuse.value = this.finalRT.texture;
      this.quad.material = this.fxaaMat;
      this.quad.render(renderer);
    }
  }

  blit(material, target, clear = true) {
    this.renderer.setRenderTarget(target);
    if (clear) {
      this.renderer.setClearColor(0x000000, 1);
      this.renderer.clear(true, false, false);
    }
    this.quad.material = material;
    this.quad.render(this.renderer);
  }
}
