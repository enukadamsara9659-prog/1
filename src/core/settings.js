import bus from './events.js';

export const PRESETS = {
  low: {
    name: 'Low',
    resolutionScale: 0.7,
    renderScaleCap: 1,
    shadowCascades: 1, shadowRes: 1024, shadowDist: 220,
    ao: false, aoRes: 0.5,
    clouds: 0, cloudRes: 0.35,
    vegDensity: 0.35, vegDistance: 900, grass: false, grassDistance: 40,
    bloom: true, dof: false, grain: true, aberration: false,
    waterDetail: 0.4, anisotropy: 2, aa: 'fxaa',
    particles: 0.5, lodBias: 1.3,
  },
  medium: {
    name: 'Medium',
    resolutionScale: 0.85,
    renderScaleCap: 1,
    shadowCascades: 2, shadowRes: 1536, shadowDist: 400,
    ao: false, aoRes: 0.5,
    clouds: 18, cloudRes: 0.4,
    vegDensity: 0.7, vegDistance: 1600, grass: true, grassDistance: 70,
    bloom: true, dof: false, grain: true, aberration: true,
    waterDetail: 0.7, anisotropy: 4, aa: 'fxaa',
    particles: 0.8, lodBias: 1.1,
  },
  high: {
    name: 'High',
    resolutionScale: 1,
    renderScaleCap: 1.5,
    shadowCascades: 3, shadowRes: 2048, shadowDist: 900,
    ao: true, aoRes: 0.5,
    clouds: 28, cloudRes: 0.5,
    vegDensity: 1, vegDistance: 2600, grass: true, grassDistance: 110,
    bloom: true, dof: true, grain: true, aberration: true,
    waterDetail: 1, anisotropy: 8, aa: 'smaa',
    particles: 1, lodBias: 1,
  },
  ultra: {
    name: 'Ultra',
    resolutionScale: 1,
    renderScaleCap: 2,
    shadowCascades: 3, shadowRes: 4096, shadowDist: 1600,
    ao: true, aoRes: 1,
    clouds: 44, cloudRes: 0.66,
    vegDensity: 1.35, vegDistance: 4000, grass: true, grassDistance: 160,
    bloom: true, dof: true, grain: true, aberration: true,
    waterDetail: 1.3, anisotropy: 16, aa: 'smaa',
    particles: 1.4, lodBias: 0.85,
  },
};

const DEFAULTS = {
  preset: 'high',
  fov: 68,
  sensitivity: 1,
  invertY: false,
  master: 0.8, sfx: 0.9, music: 0.5, voice: 0.8,
  subtitles: true,
  showFps: false,
  dynamicResolution: true,
  cameraShake: 1,
  hudScale: 1,
};

const KEY = 'aetherfall.settings.v1';

class Settings {
  constructor() {
    this.data = { ...DEFAULTS };
    this.load();
  }
  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) Object.assign(this.data, JSON.parse(raw));
    } catch (e) { /* ignore */ }
    this.preset = PRESETS[this.data.preset] || PRESETS.high;
  }
  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch (e) { /* ignore */ }
  }
  get(k) { return this.data[k]; }
  set(k, v) {
    this.data[k] = v;
    if (k === 'preset') this.preset = PRESETS[v] || PRESETS.high;
    this.save();
    bus.emit('settings:changed', { key: k, value: v });
  }
  /** quality value, respecting per-preset overrides */
  q(key) { return this.preset[key]; }
  setPreset(name) { this.set('preset', name); bus.emit('settings:preset', name); }
}

export const settings = new Settings();
export default settings;
