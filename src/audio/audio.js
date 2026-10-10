// Fully procedural WebAudio engine: no sample files, everything is synthesised.
// Bus layout: sources -> (dry + reverb send) -> sfx/music -> master -> compressor
import settings from '../core/settings.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.sounds = new Map();
    this.music = null;
    this.volume = { master: 0.8, sfx: 0.9, music: 0.5 };
    this.listener = { x: 0, y: 0, z: 0, fx: 0, fz: 1 };
    this.lastPlay = new Map();
  }

  init() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 22;
    this.comp.ratio.value = 6;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.22;
    this.master.connect(this.comp);
    this.comp.connect(ctx.destination);

    this.sfxBus = ctx.createGain();
    this.musicBus = ctx.createGain();
    this.sfxBus.connect(this.master);
    this.musicBus.connect(this.master);

    // ---- reverb (procedural impulse response)
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeIR(2.1, 2.6);
    this.reverbGain = ctx.createGain();
    this.reverbGain.gain.value = 0.32;
    this.reverb.connect(this.reverbGain);
    this.reverbGain.connect(this.master);

    // ---- shared noise buffer
    this.noiseBuf = this.makeNoise(2.0);

    this.applyVolumes();
    this.ready = true;
    return ctx;
  }

  resume() {
    if (!this.ctx) this.init();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  applyVolumes() {
    if (!this.ctx) return;
    this.volume.master = settings.get('master', 0.8);
    this.volume.sfx = settings.get('sfx', 0.9);
    this.volume.music = settings.get('music', 0.5);
    this.master.gain.value = this.volume.master;
    this.sfxBus.gain.value = this.volume.sfx;
    this.musicBus.gain.value = this.volume.music;
  }

  makeNoise(seconds) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  makeIR(seconds, decay) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (1 - t * 0.2);
      }
    }
    return buf;
  }

  noise(dur, { gain = 0.5, type = 'bandpass', freq = 1200, q = 1, sweep = null, delay = 0, send = 0.25 } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.value = freq;
    filt.Q.value = q;
    const g = ctx.createGain();
    const t0 = ctx.currentTime + delay;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + Math.min(0.008, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
    if (sweep) {
      filt.frequency.setValueAtTime(sweep[0], t0);
      filt.frequency.exponentialRampToValueAtTime(Math.max(30, sweep[1]), t0 + dur);
    }
    src.connect(filt); filt.connect(g);
    this.route(g, send);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
    return { src, g, filt };
  }

  tone(freq, dur, { gain = 0.3, type = 'sine', sweep = null, delay = 0, send = 0.2, detune = 0 } = {}) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.detune.value = detune;
    const g = ctx.createGain();
    const t0 = ctx.currentTime + delay;
    osc.frequency.setValueAtTime(freq, t0);
    if (sweep) osc.frequency.exponentialRampToValueAtTime(Math.max(20, sweep), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
    osc.connect(g);
    this.route(g, send);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    return { osc, g };
  }

  route(node, send = 0.2, bus = null) {
    node.connect(bus || this.sfxBus);
    if (send > 0 && this.reverb) {
      const s = this.ctx.createGain();
      s.gain.value = send;
      node.connect(s);
      s.connect(this.reverb);
    }
  }

  /** spatial attenuation + stereo pan based on the listener */
  spatial(pos, maxDist = 90) {
    if (!pos) return 1;
    const dx = pos.x - this.listener.x, dz = pos.z - this.listener.z;
    const d = Math.hypot(dx, dz);
    const att = Math.max(0, 1 - d / maxDist);
    // pan: project onto the listener's right axis
    const rx = this.listener.fz, rz = -this.listener.fx;
    const pan = d > 0.001 ? clampNum((dx * rx + dz * rz) / d, -1, 1) : 0;
    return { gain: att * att, pan };
  }

  play(name, opts = {}) {
    if (!this.ready) this.init();
    if (!this.ctx || this.ctx.state === 'suspended') return;
    const now = performance.now();
    const key = name + (opts.pos ? '' : '');
    const minGap = opts.gap ?? 0.03;
    if (this.lastPlay.get(key) > now - minGap * 1000) return;
    this.lastPlay.set(key, now);

    let gain = opts.gain ?? 1;
    let pan = 0;
    if (opts.pos) {
      const s = this.spatial(opts.pos, opts.maxDist || 110);
      if (s.gain <= 0.004) return;
      gain *= s.gain;
      pan = s.pan;
    }
    const panner = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    let dest = null;
    if (panner && pan !== 0) {
      panner.pan.value = pan * 0.75;
      panner.connect(this.sfxBus);
      dest = panner;
    }
    const prevBus = this._bus;
    this._bus = dest;
    try { this.render(name, gain, opts); } catch (e) { /* ignore */ }
    this._bus = prevBus;
  }

  // ------------------------------------------------------------- voices
  render(name, gain = 1, opts = {}) {
    const rate = opts.rate || 1;
    switch (name) {
      case 'shot_rifle':
        this.noise(0.09, { gain: 0.55 * gain, type: 'bandpass', freq: 1900 * rate, q: 0.7, sweep: [2600 * rate, 500], send: 0.3 });
        this.tone(180 * rate, 0.1, { gain: 0.32 * gain, type: 'sine', sweep: 60, send: 0.15 });
        this.noise(0.34, { gain: 0.1 * gain, type: 'lowpass', freq: 700, delay: 0.02, send: 0.5 });
        break;
      case 'shot_shotgun':
        this.noise(0.2, { gain: 0.75 * gain, type: 'bandpass', freq: 1100, q: 0.5, sweep: [1800, 220], send: 0.4 });
        this.tone(120, 0.22, { gain: 0.45 * gain, type: 'sine', sweep: 42, send: 0.2 });
        break;
      case 'shot_sniper':
        this.noise(0.06, { gain: 0.85 * gain, type: 'highpass', freq: 2600, sweep: [5200, 900], send: 0.35 });
        this.tone(90, 0.3, { gain: 0.5 * gain, type: 'sine', sweep: 34, send: 0.5 });
        this.noise(0.7, { gain: 0.12 * gain, type: 'bandpass', freq: 900, delay: 0.05, send: 0.85 });
        break;
      case 'shot_pistol':
        this.noise(0.07, { gain: 0.45 * gain, sweep: [2200, 600], send: 0.25 });
        this.tone(150, 0.08, { gain: 0.25 * gain, sweep: 70 });
        break;
      case 'melee_swing':
        this.noise(0.22, { gain: 0.28 * gain, type: 'bandpass', freq: 900, sweep: [500, 2400], q: 1.6, send: 0.2 });
        break;
      case 'melee_hit':
        this.noise(0.16, { gain: 0.5 * gain, type: 'lowpass', freq: 900, sweep: [1600, 200], send: 0.3 });
        this.tone(140, 0.18, { gain: 0.4 * gain, type: 'triangle', sweep: 60 });
        break;
      case 'hit_flesh':
        this.noise(0.1, { gain: 0.35 * gain, type: 'lowpass', freq: 700, sweep: [900, 200], send: 0.2 });
        this.tone(210, 0.09, { gain: 0.22 * gain, type: 'sine', sweep: 90 });
        break;
      case 'hit_marker':
        this.tone(1500, 0.05, { gain: 0.16 * gain, type: 'square', send: 0.05 });
        break;
      case 'impact_stone':
        this.noise(0.09, { gain: 0.3 * gain, type: 'bandpass', freq: 2400, q: 1.4, sweep: [3200, 900], send: 0.35 });
        break;
      case 'impact_water':
        this.noise(0.18, { gain: 0.26 * gain, type: 'lowpass', freq: 1400, sweep: [2200, 300], send: 0.3 });
        this.tone(600, 0.1, { gain: 0.1 * gain, type: 'sine', sweep: 180 });
        break;
      case 'explosion':
        this.noise(0.55, { gain: 0.9 * gain, type: 'lowpass', freq: 800, sweep: [2200, 90], send: 0.6 });
        this.tone(70, 0.7, { gain: 0.7 * gain, type: 'sine', sweep: 26, send: 0.4 });
        this.noise(1.4, { gain: 0.16 * gain, type: 'bandpass', freq: 500, delay: 0.06, send: 0.9 });
        break;
      case 'pulse':
        this.tone(180, 0.6, { gain: 0.5 * gain, type: 'sawtooth', sweep: 1400, send: 0.4 });
        this.noise(0.5, { gain: 0.4 * gain, type: 'bandpass', freq: 700, sweep: [300, 3000], send: 0.6 });
        this.tone(60, 0.5, { gain: 0.5 * gain, type: 'sine', sweep: 30, delay: 0.1 });
        break;
      case 'blink':
        this.noise(0.3, { gain: 0.3 * gain, type: 'bandpass', freq: 2200, sweep: [300, 4000], q: 2, send: 0.4 });
        break;
      case 'reload':
        this.noise(0.05, { gain: 0.3 * gain, type: 'bandpass', freq: 2600, q: 3, send: 0.15 });
        this.noise(0.06, { gain: 0.3 * gain, type: 'bandpass', freq: 1500, q: 3, delay: 0.25, send: 0.15 });
        this.noise(0.05, { gain: 0.35 * gain, type: 'bandpass', freq: 3200, q: 4, delay: 0.6, send: 0.2 });
        break;
      case 'step_grass':
        this.noise(0.09, { gain: 0.16 * gain, type: 'bandpass', freq: 1600, q: 1.1, sweep: [2200, 700], send: 0.12 });
        break;
      case 'step_rock':
        this.noise(0.07, { gain: 0.18 * gain, type: 'bandpass', freq: 3000, q: 2, sweep: [3600, 1200], send: 0.18 });
        break;
      case 'step_water':
        this.noise(0.16, { gain: 0.2 * gain, type: 'lowpass', freq: 1200, sweep: [1800, 400], send: 0.2 });
        break;
      case 'jump':
        this.noise(0.08, { gain: 0.14 * gain, type: 'bandpass', freq: 900, sweep: [700, 1600], send: 0.1 });
        break;
      case 'land':
        this.noise(0.16, { gain: 0.3 * gain, type: 'lowpass', freq: 500, sweep: [900, 160], send: 0.25 });
        break;
      case 'dodge':
        this.noise(0.22, { gain: 0.22 * gain, type: 'bandpass', freq: 1400, sweep: [2600, 600], q: 1.2, send: 0.2 });
        break;
      case 'slide':
        this.noise(0.5, { gain: 0.22 * gain, type: 'bandpass', freq: 1200, sweep: [2000, 400], q: 1.5, send: 0.3 });
        break;
      case 'claw':
        this.noise(0.14, { gain: 0.4 * gain, type: 'bandpass', freq: 2600, sweep: [4200, 900], q: 2, send: 0.3 });
        break;
      case 'spit':
        this.noise(0.2, { gain: 0.3 * gain, type: 'bandpass', freq: 700, sweep: [1400, 300], q: 1.2, send: 0.3 });
        break;
      case 'growl':
        this.tone(85, 0.7, { gain: 0.28 * gain, type: 'sawtooth', sweep: 55, send: 0.35 });
        this.noise(0.7, { gain: 0.12 * gain, type: 'lowpass', freq: 400, send: 0.3 });
        break;
      case 'enemy_die':
        this.tone(220, 0.5, { gain: 0.3 * gain, type: 'sawtooth', sweep: 45, send: 0.4 });
        this.noise(0.45, { gain: 0.22 * gain, type: 'lowpass', freq: 900, sweep: [1400, 200], send: 0.4 });
        break;
      case 'levelup': {
        const scale = [392, 523.25, 659.25, 783.99];
        scale.forEach((f, i) => this.tone(f, 0.5, { gain: 0.18 * gain, type: 'triangle', delay: i * 0.09, send: 0.5 }));
        break;
      }
      case 'pickup':
        this.tone(880, 0.12, { gain: 0.16 * gain, type: 'sine', send: 0.3 });
        this.tone(1320, 0.14, { gain: 0.12 * gain, type: 'sine', delay: 0.06, send: 0.3 });
        break;
      case 'ui_click':
        this.tone(660, 0.05, { gain: 0.12 * gain, type: 'square', send: 0.05 });
        break;
      case 'ui_hover':
        this.tone(440, 0.04, { gain: 0.06 * gain, type: 'sine', send: 0.05 });
        break;
      case 'alert':
        this.tone(330, 0.2, { gain: 0.2 * gain, type: 'sawtooth', sweep: 220, send: 0.3 });
        break;
      case 'player_hurt':
        this.noise(0.2, { gain: 0.3 * gain, type: 'lowpass', freq: 500, sweep: [900, 150], send: 0.2 });
        this.tone(120, 0.3, { gain: 0.25 * gain, type: 'sine', sweep: 60 });
        break;
      case 'downed':
        this.tone(70, 1.2, { gain: 0.4 * gain, type: 'sine', sweep: 40, send: 0.4 });
        break;
      case 'stim':
        this.tone(300, 0.5, { gain: 0.2 * gain, type: 'triangle', sweep: 900, send: 0.4 });
        break;
      case 'meteor_boom':
        this.noise(1.8, { gain: 0.9 * gain, type: 'lowpass', freq: 300, sweep: [1800, 40], send: 0.9 });
        this.tone(45, 2.4, { gain: 0.9 * gain, type: 'sine', sweep: 18, send: 0.6 });
        this.noise(3.5, { gain: 0.2 * gain, type: 'bandpass', freq: 260, delay: 0.15, send: 1 });
        break;
      case 'meteor_hiss':
        this.noise(2.2, { gain: 0.35 * gain, type: 'highpass', freq: 2400, sweep: [5200, 1200], send: 0.7 });
        break;
      case 'rumble':
        this.tone(38, 3.5, { gain: 0.5 * gain, type: 'sine', send: 0.2 });
        this.noise(3.5, { gain: 0.16 * gain, type: 'lowpass', freq: 220, send: 0.4 });
        break;
      default:
        this.noise(0.1, { gain: 0.2 * gain });
    }
  }

  // ------------------------------------------------------------- music
  startMusic() {
    if (!this.ctx || this.music) return;
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0.0001;
    out.connect(this.musicBus);
    const send = ctx.createGain();
    send.gain.value = 0.5;
    out.connect(send);
    send.connect(this.reverb);

    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 620;
    filt.Q.value = 0.7;
    filt.connect(out);

    // slow filter LFO
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.045;
    lfoGain.gain.value = 260;
    lfo.connect(lfoGain);
    lfoGain.connect(filt.frequency);
    lfo.start();

    const oscs = [];
    const base = [110, 164.81, 220, 246.94, 329.63];
    for (let i = 0; i < base.length; i++) {
      const o = ctx.createOscillator();
      o.type = i < 2 ? 'sine' : 'triangle';
      o.frequency.value = base[i] * (i % 2 ? 1.001 : 0.999);
      const g = ctx.createGain();
      g.gain.value = 0.055 / (1 + i * 0.4);
      // slow chorus detune
      const lfo2 = ctx.createOscillator();
      const lfo2g = ctx.createGain();
      lfo2.frequency.value = 0.07 + i * 0.03;
      lfo2g.gain.value = 3 + i;
      lfo2.connect(lfo2g); lfo2g.connect(o.detune);
      lfo2.start();
      o.connect(g); g.connect(filt);
      o.start();
      oscs.push({ o, g });
    }

    out.gain.exponentialRampToValueAtTime(0.55, ctx.currentTime + 4);
    this.music = { out, filt, oscs, lfo, intensity: 0, target: 0 };
    this.scheduleMelody();
  }

  scheduleMelody() {
    if (!this.music) return;
    const scale = [220, 246.94, 293.66, 329.63, 392, 440, 493.88, 587.33];
    const step = () => {
      if (!this.music) return;
      const m = this.music;
      const n = scale[Math.floor(Math.random() * scale.length)];
      const gain = 0.05 + m.intensity * 0.05;
      this.tone(n, 2.2 + Math.random() * 2, { gain, type: 'sine', send: 0.8 });
      if (m.intensity > 0.5 && Math.random() < 0.5) {
        this.tone(n * 1.5, 1.6, { gain: gain * 0.6, type: 'triangle', delay: 0.5, send: 0.8 });
      }
      m.timer = setTimeout(step, 2200 + Math.random() * 4200 - m.intensity * 900);
    };
    this.music.timer = setTimeout(step, 1500);
  }

  setMusicIntensity(v) {
    if (!this.music) return;
    this.music.target = v;
  }

  update(dt, camera) {
    if (camera && this.ctx) {
      const p = camera.position;
      this.listener.x = p.x; this.listener.y = p.y; this.listener.z = p.z;
      const d = duckVec();
      camera.getWorldDirection(d);
      this.listener.fx = d.x; this.listener.fz = d.z;
      const L = this.ctx.listener;
      if (L.positionX) {
        const t = this.ctx.currentTime;
        L.positionX.setTargetAtTime(p.x, t, 0.02);
        L.positionY.setTargetAtTime(p.y, t, 0.02);
        L.positionZ.setTargetAtTime(p.z, t, 0.02);
        L.forwardX.setTargetAtTime(d.x, t, 0.02);
        L.forwardY.setTargetAtTime(d.y, t, 0.02);
        L.forwardZ.setTargetAtTime(d.z, t, 0.02);
      }
    }
    if (!this.music) return;
    const m = this.music;
    m.intensity += (m.target - m.intensity) * Math.min(1, dt * 0.6);
    const targetCut = 480 + m.intensity * 1500;
    if (m.filt) m.filt.frequency.setTargetAtTime(targetCut, this.ctx.currentTime, 1.2);
    m.out.gain.setTargetAtTime(0.4 + m.intensity * 0.3, this.ctx.currentTime, 1.5);
  }

  stopMusic() {
    if (!this.music) return;
    clearTimeout(this.music.timer);
    for (const { o } of this.music.oscs) { try { o.stop(); } catch (e) {} }
    try { this.music.lfo.stop(); } catch (e) {}
    this.music = null;
  }
}

function clampNum(v, a, b) { return v < a ? a : v > b ? b : v; }

// minimal duck-typed Vector3 so the audio module stays three-free
let _duck = null;
function duckVec() {
  if (_duck) return _duck;
  _duck = {
    x: 0, y: 0, z: 1,
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; },
    normalize() {
      const l = Math.hypot(this.x, this.y, this.z) || 1;
      this.x /= l; this.y /= l; this.z /= l; return this;
    },
  };
  return _duck;
}

export const audio = new AudioEngine();
export default audio;
