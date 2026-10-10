// Sky dome, sun/moon/stars, time of day, lighting and weather state.
import * as THREE from 'three';
import { NOISE_GLSL, SKY_GLSL } from './shaders.js';
import settings from '../core/settings.js';
import { clamp, lerp } from '../core/rng.js';

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_Position.z = gl_Position.w;   // always at the far plane
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uSunI;
uniform float uSkyGain;
uniform float uSunDiskI;
uniform float uCamY;
uniform vec3 uGroundColor;
uniform float uGroundLit;
uniform int uSteps;
uniform int uLightSteps;
${NOISE_GLSL}
${SKY_GLSL}

void main() {
  vec3 rd = normalize(vDir);
  vec3 ro = vec3(0.0, Re + max(uCamY, 2.0), 0.0);
  vec3 col = atmosphere(ro, rd, uSunDir, uSunI, uSteps, uLightSteps, uGroundColor, uGroundLit) * uSkyGain;

  float night = smoothstep(0.08, -0.10, uSunDir.y);

  // sun disk
  float sd = sunDisk(rd, uSunDir, 0.0096);
  float horizonFade = smoothstep(-0.09, 0.02, uSunDir.y);
  col += vec3(1.0, 0.86, 0.66) * sd * uSunDiskI * horizonFade;

  // moon
  vec3 md3 = vec3(0.0);
  float md = sunDisk(rd, uMoonDir, 0.0135);
  float mphase = 0.72 + 0.28 * vnoise2(rd.xz * 46.0);
  col += vec3(0.92, 0.94, 1.0) * md * 3.4 * mphase * smoothstep(-0.02, 0.08, uMoonDir.y);

  // stars
  float st = starField(rd, 3.0) + starField(rd * 1.7, 11.0) * 0.6;
  float mw = milkyWay(rd) * 0.035;
  col += (vec3(st) * (0.7 + 0.6 * hash12(rd.xz * 91.0)) + vec3(mw)) * night * 1.25;

  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;

export class Sky {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.timeOfDay = 8.4;          // hours
    this.dayLengthMinutes = 26;    // real minutes per in-game day
    this.paused = false;
    this.sunDir = new THREE.Vector3(0.5, 0.6, 0.3).normalize();
    this.moonDir = new THREE.Vector3();
    this.sunColor = new THREE.Color(1, 0.95, 0.88);
    this.horizonColor = new THREE.Color(0.7, 0.8, 0.95);
    this.zenithColor = new THREE.Color(0.25, 0.45, 0.9);
    this.groundColor = new THREE.Color(0.10, 0.11, 0.08);
    this.sunIntensity = 3;
    this.weather = { cloudiness: 0.42, coverage: 0.5, wind: new THREE.Vector2(1, 0.35), windSpeed: 4, rain: 0, fog: 0.12, lightning: 0 };
    this.envDirty = true;
    this.envTimer = 0;

    // --- sky dome
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
        uSunI: { value: 20 },
        uSkyGain: { value: 0.16 },
        uSunDiskI: { value: 620 },
        uCamY: { value: 50 },
        uGroundColor: { value: new THREE.Color(0.09, 0.10, 0.075) },
        uGroundLit: { value: 1 },
        uSteps: { value: 12 },
        uLightSteps: { value: 4 },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: false,
    });
    const geo = new THREE.SphereGeometry(1, 48, 32);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.scale.setScalar(20000);
    scene.add(this.mesh);

    // --- lights
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.6;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 1200;
    const s = 180;
    Object.assign(this.sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s });
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0x9fc4ff, 0x4a4230, 0.6);
    scene.add(this.hemi);

    this.ambient = new THREE.AmbientLight(0xffffff, 0.12);
    scene.add(this.ambient);

    // --- IBL
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
    this.envScene = new THREE.Scene();
    this.envMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 24), this.material);
    this.envMesh.scale.setScalar(100);
    this.envScene.add(this.envMesh);
    this.envRT = null;

    scene.fog = new THREE.FogExp2(0x9fb4d0, 0.00016);
    this.applyTime();
    this.updateEnv(true);
  }

  setTime(h) { this.timeOfDay = ((h % 24) + 24) % 24; this.applyTime(); this.envDirty = true; }

  applyTime() {
    const t = this.timeOfDay;
    const a = (t / 24) * Math.PI * 2 - Math.PI / 2;
    this.sunDir.set(Math.cos(a) * 0.82, Math.sin(a), Math.cos(a) * 0.42).normalize();
    this.moonDir.copy(this.sunDir).multiplyScalar(-1);
    this.material.uniforms.uSunDir.value.copy(this.sunDir);
    this.material.uniforms.uMoonDir.value.copy(this.moonDir);

    const elev = this.sunDir.y;
    const day = clamp(elev * 3.2 + 0.12, 0, 1);
    const golden = Math.exp(-Math.pow(Math.max(0, elev) * 5.5, 2));

    // sun colour: warm at the horizon, neutral at noon
    const c = this.sunColor;
    c.setRGB(1, lerp(0.52, 0.95, clamp(elev * 2.2, 0, 1)), lerp(0.26, 0.86, clamp(elev * 2.6, 0, 1)));
    this.sun.color.copy(c);
    this.sun.intensity = lerp(0.22, 3.4, day) * (1 - this.weather.cloudiness * 0.35);
    this.sun.visible = elev > -0.12;

    const night = 1 - clamp(elev * 4 + 0.22, 0, 1);
    this.hemi.color.setRGB(lerp(0.12, 0.62, day), lerp(0.16, 0.76, day), lerp(0.30, 1.0, day));
    this.hemi.groundColor.setRGB(lerp(0.05, 0.30, day), lerp(0.05, 0.26, day), lerp(0.06, 0.18, day));
    this.hemi.intensity = lerp(0.18, 0.85, day);
    this.ambient.intensity = lerp(0.10, 0.16, day);

    this.material.uniforms.uSunI.value = lerp(0.35, 22, day);
    this.material.uniforms.uSkyGain.value = 0.16;
    this.material.uniforms.uGroundLit.value = clamp(elev * 1.4 + 0.06, 0.04, 1.0);

    // horizon / zenith tint (used for fog + water reflection tint)
    const hz = this.horizonColor;
    if (elev > 0.16) hz.setRGB(0.62, 0.72, 0.88);
    else if (elev > -0.05) hz.setRGB(1.0, 0.62 + golden * 0.2, 0.38);
    else hz.setRGB(0.06, 0.09, 0.18);
    this.zenithColor.setRGB(lerp(0.02, 0.22, day), lerp(0.04, 0.42, day), lerp(0.10, 0.85, day));

    const fog = this.scene.fog;
    const fogCol = new THREE.Color().copy(hz).lerp(new THREE.Color(0x9fb4d0), 0.25);
    fog.color.copy(fogCol);
    fog.density = lerp(0.000085, 0.00022, this.weather.fog) + this.weather.rain * 0.00035;
    this.fogColor = fog.color;
  }

  updateEnv(force = false) {
    if (!force && !this.envDirty && this.envTimer < 3) return;
    this.envTimer = 0;
    this.envDirty = false;
    const rt = this.pmrem.fromScene(this.envScene, 0, 0.1, 1000);
    if (this.envRT) this.envRT.dispose();
    this.envRT = rt;
    this.scene.environment = rt.texture;
    const day = clamp(this.sunDir.y * 3.2 + 0.12, 0, 1);
    this.scene.environmentIntensity = lerp(0.10, 0.85, day);
  }

  setQuality(presetName) {
    const p = settings.preset;
    const steps = p.clouds > 0 ? 12 : 8;
    this.material.uniforms.uSteps.value = presetName === 'low' ? 6 : presetName === 'medium' ? 9 : 12;
    this.material.uniforms.uLightSteps.value = presetName === 'low' ? 2 : presetName === 'medium' ? 3 : 4;
    const res = p.shadowRes;
    if (this.sun.shadow.mapSize.x !== res) {
      this.sun.shadow.mapSize.set(res, res);
      if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    }
    const dist = p.shadowDist;
    const s = Math.min(600, dist * 0.55);
    const cam = this.sun.shadow.camera;
    cam.left = -s; cam.right = s; cam.top = s; cam.bottom = -s;
    cam.far = dist * 2.2;
    cam.updateProjectionMatrix();
  }

  update(dt, camera) {
    if (!this.paused) {
      this.timeOfDay += (dt / 60) * (24 / this.dayLengthMinutes);
      if (this.timeOfDay > 24) this.timeOfDay -= 24;
      this.applyTime();
    }
    this.envTimer += dt;
    this.mesh.position.copy(camera.position);
    this.material.uniforms.uCamY.value = camera.position.y;
    this.updateEnv();

    // keep the shadow frustum centred on the player
    const cam = this.sun.shadow.camera;
    const target = camera.position;
    this.sun.target.position.set(target.x, target.y - 20, target.z);
    this.sun.target.updateMatrixWorld();
    this.sun.position.set(
      target.x + this.sunDir.x * 400,
      target.y + this.sunDir.y * 400 + 120,
      target.z + this.sunDir.z * 400
    );
    cam.updateMatrixWorld();
  }
}
