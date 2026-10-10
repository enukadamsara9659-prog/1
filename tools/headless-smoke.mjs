process.on('unhandledRejection', () => {});
// Headless integration smoke test: builds the whole game except the WebGL
// renderer and runs a few hundred frames of real gameplay logic.
import fs from 'fs';
import path from 'path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const ROOT = path.resolve(import.meta.dirname, '..');

// ------------------------------------------------------------------ fake DOM
class FakeCtx {
  constructor(w, h) { this.w = w; this.h = h; }
}
function makeCtx(c) {
  const grad = { addColorStop() {} };
  return new Proxy(new FakeCtx(c.width, c.height), {
    get(t, k) {
      if (k === 'canvas') return c;
      if (k in t) return t[k];
      return (...a) => {
        if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createConicGradient') return grad;
        if (k === 'getImageData' || k === 'createImageData') {
          const ww = (k === 'getImageData' ? a[2] : a[0]) || t.w || 4;
          const hh = (k === 'getImageData' ? a[3] : a[1]) || t.h || 4;
          return { data: new Uint8ClampedArray(ww * hh * 4), width: ww, height: hh };
        }
        if (k === 'measureText') return { width: 10 };
        return undefined;
      };
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}
class FakeEl {
  constructor(tag = 'div', id = '') {
    this.tagName = (tag || 'div').toUpperCase();
    this.id = id;
    this.children = [];
    this.style = new Proxy({}, { get: (t, k) => (k === 'setProperty' ? () => {} : t[k]), set: (t, k, v) => { t[k] = v; return true; } });
    this.dataset = {};
    this.classList = {
      _s: new Set(),
      add: (...c) => c.forEach((x) => this.classList._s.add(x)),
      remove: (...c) => c.forEach((x) => this.classList._s.delete(x)),
      toggle: (c, on) => { if (on === undefined) { this.classList._s.has(c) ? this.classList._s.delete(c) : this.classList._s.add(c); } else if (on) this.classList._s.add(c); else this.classList._s.delete(c); },
      contains: (c) => this.classList._s.has(c),
    };
    this._html = '';
    this.textContent = '';
    this.width = 260; this.height = 260;
  }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  get innerHTML() { return this._html; }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); }
  remove() {}
  addEventListener(type, fn) { (this._l = this._l || {})[type] = fn; }
  removeEventListener() {}
  dispatchEvent(e) { const f = this._l && this._l[e.type]; if (f) f(e); }
  set src(v) {
    this._src = v;
    setTimeout(() => { const f = this._l && this._l.load; if (f) f({ type: 'load', target: this }); }, 0);
  }
  get src() { return this._src; }
  setAttribute() {}
  querySelector() { return new FakeEl('div'); }
  querySelectorAll() { return []; }
  closest() { return null; }
  getContext() { if (!this._ctx) this._ctx = makeCtx(this); return this._ctx; }
  get parentElement() { return this._parent || (this._parent = new FakeEl('div')); }
  get firstElementChild() { return this.children[0] || new FakeEl('div'); }
  get onclick() { return this._onclick; }
  set onclick(v) { this._onclick = v; }
}
const _els = new Map();
global.document = {
  createElement(tag) { return new FakeEl(tag); },
  createElementNS(ns, tag) { return new FakeEl(tag); },
  getElementById(id) { if (!_els.has(id)) _els.set(id, new FakeEl('div', id)); return _els.get(id); },
  addEventListener() {},
  body: new FakeEl('body'),
};
global.window = { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, requestAnimationFrame: (f) => setTimeout(f, 16) };
global.self = global.window;
global.URL = global.URL || {};
if (!global.URL.createObjectURL) global.URL.createObjectURL = () => 'blob:fake';
if (!global.URL.revokeObjectURL) global.URL.revokeObjectURL = () => {};
Object.defineProperty(global, 'navigator', { value: { userAgent: 'node' }, configurable: true });
global.localStorage = {
  _d: new Map(),
  getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
  setItem(k, v) { this._d.set(k, String(v)); },
  removeItem(k) { this._d.delete(k); },
};
global.requestAnimationFrame = (f) => setTimeout(f, 16);
global.HTMLCanvasElement = FakeEl;

// ------------------------------------------------------------------ assets
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/assets/manifest.json'), 'utf8'));
const loader = new GLTFLoader();
const models = new Map();
const textures = new Map();
const loadGlb = (file) => {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((res, rej) => loader.parse(ab, '', res, rej));
};
{
  const jobs = [];
  for (const [group, map] of Object.entries(manifest.models || {})) {
    for (const [name, p] of Object.entries(map)) {
      try { jobs.push(loadGlb(path.join(ROOT, 'public/assets', p)).then((g) => models.set(`${group}/${name}`, g)).catch((e) => console.log('skip', group, name, String(e).slice(0, 60)))); } catch (e) { console.log('MISSING FILE', group, name, p); }
    }
  }
  const settled = await Promise.allSettled(jobs);
  const failed = settled.filter((r) => r.status === 'rejected');
  if (failed.length) console.log('model load failures:', failed.length, String(failed[0].reason).slice(0, 200));
  for (const layer of Object.keys(manifest.tex.terrain || {})) {
    textures.set(`terrain.${layer}.color`, new THREE.Texture());
    textures.set(`terrain.${layer}.nr`, new THREE.Texture());
  }
  for (const layer of Object.keys(manifest.tex.surf || {})) {
    textures.set(`surf.${layer}.color`, new THREE.Texture());
    textures.set(`surf.${layer}.nr`, new THREE.Texture());
  }
  textures.set('waternormals', new THREE.Texture());
  textures.set('grassDetail', new THREE.Texture());
}
// push everything into the REAL assets singleton (game modules import it directly)
const realAssets = (await import(path.join(ROOT, 'src/core/assets.js'))).default;
for (const [k, v] of models) realAssets.models.set(k, v);
for (const [k, v] of textures) realAssets.textures.set(k, v);
const assets = {
  tex: (k) => textures.get(k) || null,
  gltf: (g, n) => models.get(`${g}/${n}`),
  model: (g, n) => {
    const src = models.get(`${g}/${n}`);
    if (!src) { console.log('MISSING MODEL', g, n); return new THREE.Group(); }
    return src.scene.clone(true);
  },
  group: (g) => {
    const out = {};
    for (const k of models.keys()) if (k.startsWith(g + '/')) out[k.slice(g.length + 1)] = models.get(k);
    return out;
  },
  has: (g, n) => models.has(`${g}/${n}`),
};

// ------------------------------------------------------------------ world
function makeWorld() {
  const N = 512, SIZE = 8192, CELL = SIZE / (N - 1);
  const h = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = i * CELL - SIZE / 2, z = j * CELL - SIZE / 2;
    h[j * N + i] = 40 * Math.sin(x * 0.0016) * Math.cos(z * 0.0019) + 18 * Math.sin(x * 0.006 + z * 0.004) + 60;
  }
  const splat = new Uint8Array(1024 * 1024 * 4).fill(90);
  const mask = new Uint8Array(1024 * 1024 * 4);
  const idx = (x, z) => {
    const fx = x / CELL + (N - 1) / 2, fz = z / CELL + (N - 1) / 2;
    return [fx, fz];
  };
  const heightAt = (x, z) => {
    const [fx, fz] = idx(x, z);
    const i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= N - 1 || j >= N - 1) return 0;
    const tx = fx - i, tz = fz - j;
    const a = h[j * N + i], b = h[j * N + i + 1], c = h[(j + 1) * N + i], d = h[(j + 1) * N + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  };
  const normalAt = (x, z, out = new THREE.Vector3()) => {
    const e = CELL;
    return out.set(heightAt(x - e, z) - heightAt(x + e, z), 2 * e, heightAt(x, z - e) - heightAt(x, z + e)).normalize();
  };
  return {
    height: h, splat, mask, N, SIZE, CELL, HALF: SIZE / 2,
    heightAt, normalAt,
    slopeAt: (x, z) => 1 - normalAt(x, z).y,
    riverAt: () => 0, scorchAt: () => 0, moistureAt: () => 0.5,
    biomeAt: () => 2, roadDistance: () => 999, poiAt: () => null,
    crater: { x: 114, z: -694, radius: 120, depth: 62 },
    start: { x: -948, y: 60, z: 1551 },
    pois: [
      { kind: 'village', name: 'Ashwick', x: 0, z: 0, y: 0, radius: 90, rot: 0.3, seed: 1 },
      { kind: 'temple', name: 'Temple', x: 600, z: 400, y: 0, radius: 70, rot: 1.1, seed: 2 },
      { kind: 'palace', name: 'Highkeep', x: -800, z: -300, y: 0, radius: 120, rot: 2.0, seed: 3 },
      { kind: 'camp', name: 'Camp', x: -1200, z: 1200, y: 0, radius: 40, rot: 2.5, seed: 7 },
    ],
    nests: Array.from({ length: 6 }, (_, i) => ({ x: -1500 + i * 500, z: 400 + i * 200, y: 60, seed: i, tier: (i % 3) + 1, radius: 40 })),
    roads: [{
      pts: (() => { const p = new Float32Array(20 * 4); let x = -2000, z = -900; for (let k = 0; k < 20; k++) { p[k*4]=x; p[k*4+1]=z; p[k*4+2]=0; p[k*4+3]=6; x += 100; z += 80; } return p; })(),
      count: 20,
    }],
    veg: (() => {
      const out = {};
      const mk = (n, seed) => {
        const a = new Float32Array(n * 5);
        let st = seed;
        const rnd = () => ((st = (st * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
        for (let i = 0; i < n; i++) {
          const x = (rnd() - 0.5) * 7000, z = (rnd() - 0.5) * 7000;
          a[i * 5] = x; a[i * 5 + 1] = 40 + rnd() * 40; a[i * 5 + 2] = z;
          a[i * 5 + 3] = 0.7 + rnd() * 0.7; a[i * 5 + 4] = rnd() * 6.28;
        }
        return a;
      };
      out.pine = mk(3000, 1); out.tree = mk(3000, 2); out.twisted = mk(800, 3);
      out.dead = mk(700, 4); out.rock = mk(1500, 5); out.pebble = mk(1200, 6);
      return out;
    })(),
  };
}

// ------------------------------------------------------------------ imports
const { Structures } = await import(path.join(ROOT, 'src/world/structures.js'));
const { Particles, FloatingText } = await import(path.join(ROOT, 'src/fx/particles.js'));
const { Combat } = await import(path.join(ROOT, 'src/combat/combat.js'));
const { Enemies } = await import(path.join(ROOT, 'src/entities/enemies.js'));
const { Player } = await import(path.join(ROOT, 'src/entities/player.js'));
const { Squad } = await import(path.join(ROOT, 'src/entities/squad.js'));
const { Quests } = await import(path.join(ROOT, 'src/game/quests.js'));
const { applySkills } = await import(path.join(ROOT, 'src/game/progression.js'));
const { WorldObjects } = await import(path.join(ROOT, 'src/world/worldobjects.js'));
const { HUD } = await import(path.join(ROOT, 'src/ui/hud.js'));
const { Menus } = await import(path.join(ROOT, 'src/ui/menus.js'));
const bus = (await import(path.join(ROOT, 'src/core/events.js'))).default;
const settings = (await import(path.join(ROOT, 'src/core/settings.js'))).default;

const audioLog = new Set();
const audio = { play: (n) => audioLog.add(n), init() {}, resume() {}, startMusic() {}, setMusicIntensity() {}, update() {}, applyVolumes() {} };

// ------------------------------------------------------------------ build
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, 16 / 9, 0.2, 60000);
const world = makeWorld();

const { Vegetation } = await import(path.join(ROOT, 'src/world/vegetation.js'));
const vegetation = new Vegetation(scene, world, (await import(path.join(ROOT, 'src/core/assets.js'))).default).build();
console.log('vegetation ok: sectors', vegetation.meshes.length, 'under', vegetation.under.length, 'trunks', vegetation.trunks.map.size);
{
  const out = { x: 0, z: 0 };
  let hits = 0;
  for (let i = 0; i < 500; i++) { vegetation.trunkPush(world.veg.pine[i*5], world.veg.pine[i*5+2], 0.5, out); if (Math.hypot(out.x, out.z) > 0.01) hits++; }
  console.log('  trunkPush hits at trunk positions:', hits + '/500');
}
const structures = new Structures(scene, world, assets).build();
console.log('structures ok:', structures.colliders.length, 'colliders');
const particles = new Particles(scene);
const floating = new FloatingText(scene, camera);
const combat = new Combat({ scene, camera, world, structures, vegetation, player: null, enemies: null, particles, floating, events: bus });
const enemies = new Enemies({ scene, world, structures, vegetation, player: null, particles, floating, events: bus, combat });
const worldObjects = new WorldObjects({ scene, world, structures, vegetation, particles, events: bus, combat, enemies, hud: null }).build();
console.log('worldobjects ok: nests', worldObjects.nests.length, 'beacons', worldObjects.beacons.length, 'npcs', worldObjects.npcs.length, 'interactables', worldObjects.interactables.length);

const fakeInput = {
  mouseDX: 0, mouseDY: 0, wheel: 0,
  down: new Set(), pressedSet: new Set(),
  codeDown(c) { return this.down.has(c); },
  codePressed(c) { return this.pressedSet.has(c); },
  endFrame() { this.pressedSet.clear(); this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0; },
};

const player = new Player({
  scene, camera, world, terrain: null, structures, vegetation: null,
  input: fakeInput, events: bus, particles, combat, audio, enemies,
  aimRay: (origin, dir) => { const r = combat.aimPoint(origin, dir, 400); return r ? { point: r.point } : null; },
});
combat.ctx.player = player;
combat.ctx.enemies = enemies;
enemies.ctx.player = player;
worldObjects.ctx.player = player;
applySkills(player);
const squad = new Squad({ scene, world, structures, vegetation, particles, enemies, events: bus, audio, assets, combat });
player.squad = squad;
applySkills(player);
squad.spawn(player);
enemies.difficulty = 1;
enemies.populate();
console.log('player ok at', player.pos.toArray().map((v) => v.toFixed(1)).join(','), '| enemies pop', enemies.totalPop);

const game = { world, structures, player, squad, enemies, worldObjects, combat, particles, hud: null, menus: null, quests: null, engine: { fps: 60 }, events: bus, audio, elapsed: 0, setPaused() {}, onSettingsChanged() {} };
const quests = new Quests(game);
game.quests = quests;
const hud = new HUD(game);
game.hud = hud;
worldObjects.ctx.hud = hud;
const menus = new Menus(game);
game.menus = menus;
console.log('hud + menus ok');

// ------------------------------------------------------------------ simulate
function step(dt) {
  game.elapsed += dt;
  player.update(dt, fakeInput);
  squad.update(dt, player);
  vegetation.update(dt, camera);
  enemies.update(dt);
  combat.update(dt);
  worldObjects.update(dt, player);
  quests.update(dt);
  hud.update(dt);
  particles.update(dt);
  floating.update(dt);
  fakeInput.endFrame();
}

// spawn a fight near the player
enemies.spawnWave(8, null, 40);
let errors = 0;
for (let i = 0; i < 600; i++) {
  // hold W + fire
  if (i % 120 === 0) fakeInput.down.add('KeyW');
  if (i % 7 === 0) fakeInput.down.add('Mouse0'); else fakeInput.down.delete('Mouse0');
  if (i === 60) { fakeInput.pressedSet.add('KeyQ'); }
  if (i === 90) { fakeInput.pressedSet.add('KeyG'); }
  if (i === 150) { fakeInput.pressedSet.add('KeyF'); }
  if (i === 200) { fakeInput.pressedSet.add('KeyR'); }
  if (i === 250) { fakeInput.pressedSet.add('Digit2'); }
  if (i === 300) { fakeInput.pressedSet.add('KeyE'); }
  if (i === 350) { fakeInput.pressedSet.add('Space'); fakeInput.down.add('KeyA'); }
  if (i === 400) { fakeInput.pressedSet.add('KeyH'); }
  try {
    step(1 / 60);
  } catch (e) {
    errors++;
    if (errors < 3) console.log('FRAME ERROR at', i, '\n' + e.stack.split('\n').slice(0, 8).map(l=>'>>> '+l).join('\n'));
  }
}
console.log('frames simulated: 600, errors:', errors);
console.log('  player hp', player.health.toFixed(0), 'pos', player.pos.toArray().map((v) => v.toFixed(1)).join(','));
console.log('  enemies active', enemies.active.length, 'killed', enemies.killCount);
console.log('  player kills', player.kills, 'level', player.level, 'xp', player.xp.toFixed(0), 'shards', player.shards);
console.log('  projectiles', combat.projectiles.length, 'pickups', worldObjects.pickups.length);
console.log('  squad hp', squad.members.map((m) => m.health.toFixed(0)).join('/'));
console.log('  quests active', quests.active.map((q) => q.id + ':' + q.index).join(', '));
console.log('  audio fired:', [...audioLog].slice(0, 12).join(', '));

// ---- interactions, nests, save/load, death
{
  const { saveGame, loadGame, hasSave } = await import(path.join(ROOT, 'src/game/save.js'));
  // teleport the player to each interactable and trigger it
  let kinds = new Set();
  for (const it of worldObjects.interactables) {
    player.pos.set(it.pos.x + 1, it.pos.y, it.pos.z + 1);
    worldObjects.update(1 / 60, player);
    try { worldObjects.interact(player); kinds.add(it.kind); } catch (e) { console.log('INTERACT ERROR', it.kind, e.message); }
  }
  console.log('interactables triggered:', [...kinds].join(', '));
  // destroy a nest by force
  const nest = worldObjects.nests[0];
  player.pos.set(nest.x + 2, nest.y + 1, nest.z + 2);
  worldObjects.update(1/60, player);
  worldObjects.interact(player);
  console.log('nest destroyed:', nest.destroyed, 'aether', player.aether);
  for (let i = 0; i < 60; i++) { enemies.update(1/60); combat.update(1/60); }
  console.log('wave after nest:', enemies.active.length, 'active');
  // save + load
  const okSave = saveGame(game);
  player.pos.set(1000, 60, 1000); player.level = 7;
  const okLoad = loadGame(game);
  console.log('save/load:', okSave, okLoad, 'level', player.level, 'pos', player.pos.x.toFixed(0), player.pos.z.toFixed(0));
  // death
  for (let i = 0; i < 30; i++) step(1/60);
  player.damage(500, new THREE.Vector3(0,0,0));
  console.log('after lethal damage: downed', player.downed, 'hp', player.health.toFixed(0));
  player.damage(500, new THREE.Vector3(0,0,0));
  console.log('second hit: dead', player.dead);
  player.respawn ? player.respawn() : null;
  player.dead = false; player.downed = false; player.health = player.maxHealth; player.char.revive();
  for (let i = 0; i < 30; i++) step(1/60);
}

// ---- intro cinematic
{
  const { IntroCinematic } = await import(path.join(ROOT, 'src/cinematics/intro.js'));
  const skyStub = { setTime() {}, weather: { cloudiness: 0.4, wind: new THREE.Vector2(1, 0), windSpeed: 4 }, update() {} };
  const cam2 = new THREE.PerspectiveCamera(50, 1.6, 0.2, 60000);
  const intro = new IntroCinematic({
    scene, camera: cam2, world, sky: skyStub, particles, audio, events: bus,
    playerStart: player.pos.clone(),
  });
  let ierr = 0;
  const p2 = intro.start();
  for (let i = 0; i < 2200; i++) {
    try { intro.update(1 / 60); } catch (e) { if (ierr++ < 2) console.log('INTRO ERROR at t=' + (i / 60).toFixed(1), e.stack.split('\n').slice(0, 5).join(' | ')); }
  }
  console.log('intro frames 2200, errors:', ierr, 'done:', intro.done, 'impacted:', !!intro.impacted);
  let done = false;
  p2.then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 50));
  console.log('intro promise resolved:', done);
}

// menus
for (const s of ['inventory', 'skills', 'journal', 'worldmap', 'settings', 'pause']) {
  try { menus.show(s); } catch (e) { console.log('MENU ERROR', s, e.message); }
  menus.hideAll();
}
console.log('menus ok');
try { menus.showControls(); menus.showCredits(); } catch (e) { console.log('controls/credits error', e.message); }
console.log('DONE');
