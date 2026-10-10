import * as THREE from 'three';
import { PostFX } from '../fx/postfx.js';
import settings from './settings.js';

export class Engine {
  constructor(canvas) {
    this.canvas = canvas || document.getElementById('game-canvas');
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
      preserveDrawingBuffer: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(settings.get('fov'), window.innerWidth / window.innerHeight, 0.2, 60000);
    this.camera.position.set(0, 60, 0);

    this.clock = new THREE.Timer();
    this.systems = [];
    this.running = false;
    this.frameTimes = [];
    this.fps = 60;
    this.frameTime = 16;
    this.paused = false;
    this.timeScale = 1;
    this.elapsed = 0;
    this.postfx = null;
    this.resolutionScale = 1;

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  attachPostFX(sky) {
    this.postfx = new PostFX(this.renderer, this.scene, this.camera, sky);
    this.resize();
    return this.postfx;
  }

  add(system) { this.systems.push(system); return system; }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.postfx) {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      this.postfx.setSize(size.x * this.resolutionScale, size.y * this.resolutionScale);
    }
  }

  setResolutionScale(s) {
    this.resolutionScale = s;
    this.resize();
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.tick();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() { this.running = false; cancelAnimationFrame(this.raf); }

  tick() {
    this.clock.update();
    const raw = Math.min(this.clock.getDelta(), 0.1);
    const dt = this.paused ? 0 : raw * this.timeScale;
    this.elapsed += dt;

    // adaptive resolution keeps the frame rate smooth on weaker GPUs
    this.frameTimes.push(raw);
    if (this.frameTimes.length > 40) this.frameTimes.shift();
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.fps = 1 / Math.max(0.0001, avg);
    this.frameTime = avg * 1000;
    if (settings.get('dynamicResolution') && this.postfx && this.frameTimes.length >= 40) {
      const target = 1 / 58;
      if (avg > target * 1.35 && this.resolutionScale > 0.6) this.setResolutionScale(Math.max(0.6, this.resolutionScale - 0.08));
      else if (avg < target * 0.75 && this.resolutionScale < 1) this.setResolutionScale(Math.min(1, this.resolutionScale + 0.04));
    }

    this.renderer.info.reset();
    for (const s of this.systems) if (s.update) s.update(dt, this.elapsed);

    if (this.postfx) this.postfx.render(raw, this.postOptions || {});
    else {
      this.renderer.setRenderTarget(null);
      this.renderer.clear(true, true, false);
      this.renderer.render(this.scene, this.camera);
    }
    this.onFrameEnd?.(dt, this.elapsed);
  }
}
