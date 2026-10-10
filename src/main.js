// AETHERFALL — Cradle of Ash
// Boot, world build, game loop and the glue between every system.
import * as THREE from 'three';
import { Engine } from './core/engine.js';
import assets from './core/assets.js';
import settings from './core/settings.js';
import input from './core/input.js';
import bus from './core/events.js';
import { World } from './world/world.js';
import { Terrain } from './world/terrain.js';
import { Water } from './world/water.js';
import { Sky } from './world/sky.js';
import { makeCloudNoise } from './world/noise3d.js';
import { Vegetation } from './world/vegetation.js';
import { Structures } from './world/structures.js';
import { WorldObjects } from './world/worldobjects.js';
import { Particles, FloatingText } from './fx/particles.js';
import { Combat } from './combat/combat.js';
import { Enemies } from './entities/enemies.js';
import { Player } from './entities/player.js';
import { Squad } from './entities/squad.js';
import { Quests } from './game/quests.js';
import { applySkills } from './game/progression.js';
import { saveGame, loadGame, hasSave } from './game/save.js';
import { IntroCinematic } from './cinematics/intro.js';
import { HUD } from './ui/hud.js';
import { Menus } from './ui/menus.js';
import { audio } from './audio/audio.js';
import { WORLD } from './world/constants.js';
import { clamp, lerp } from './core/rng.js';

const TIPS = [
  'The meteor did not fall alone. Whatever rode it is still out there.',
  'Headshots stagger husks — close with F while they reel.',
  'Nests keep spawning. Crack the crystal core to silence one for good.',
  'Companions never die: they go down, and you can revive them by standing close.',
  'Sprint drains stamina; stamina also fuels your dodge roll.',
  'Attune a beacon in every settlement to fast travel across the continent.',
  'The Aether Pulse ragdolls a whole pack. Save it for when you are surrounded.',
  'Snowfields above 430 m hide the old monastery road.',
];

const el = (id) => document.getElementById(id);

function showError(msg) {
  let box = document.getElementById('errbox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'errbox';
    box.style.cssText = 'position:fixed;left:20px;top:20px;right:20px;max-height:60vh;overflow:auto;z-index:9999;background:rgba(40,0,0,.92);border:1px solid #ff5a5a;color:#ffd7d7;padding:14px 18px;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;border-radius:4px';
    document.body.appendChild(box);
  }
  box.textContent += msg + '\n';
}
window.addEventListener('error', (e) => showError('ERROR: ' + (e.message || e) + '\n' + (e.error?.stack || '')));
window.addEventListener('unhandledrejection', (e) => showError('PROMISE: ' + (e.reason?.stack || e.reason)));

const ui = {
  loading: el('loading'), fill: el('load-fill'), status: el('load-status'), tip: el('load-tip'),
};

function setLoad(pct, text) {
  ui.fill.style.width = Math.round(pct * 100) + '%';
  if (text) ui.status.textContent = text;
}

const game = {
  engine: null, world: null, terrain: null, water: null, sky: null,
  vegetation: null, structures: null, worldObjects: null,
  particles: null, floating: null, combat: null, enemies: null,
  player: null, squad: null, quests: null, hud: null, menus: null,
  intro: null, audio,
  ready: false, seed: 20261010, state: 'loading', paused: false,
  elapsed: 0, clock: 6.5, events: bus,
};
window.__game = game;

// ===================================================================== boot
async function boot() {
  const engine = new Engine(el('game-canvas'));
  game.engine = engine;
  window.__assets = assets;

  ui.tip.textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
  setLoad(0.02, 'loading assets');

  await assets.loadManifest('/assets/manifest.json');
  await assets.loadAll((p) => setLoad(0.02 + p * 0.34, 'loading assets'));

  setLoad(0.38, 'generating world');
  const world = new World(engine.renderer);
  await world.generate(game.seed, (p, stage) => setLoad(0.38 + p * 0.4, stage || 'generating world'));
  game.world = world;

  setLoad(0.8, 'building the sky');
  const sky = new Sky(engine.scene, engine.renderer);
  sky.setQuality(settings.get('preset'));
  sky.setTime(6.5);
  game.sky = sky;

  setLoad(0.85, 'sculpting terrain');
  const terrain = new Terrain(world, engine.scene, engine.renderer).build();
  game.terrain = terrain;

  setLoad(0.89, 'filling the seas');
  const water = new Water(engine.scene, world, sky).build();
  game.water = water;

  setLoad(0.91, 'planting forests');
  const vegetation = new Vegetation(engine.scene, world, assets).build();
  game.vegetation = vegetation;

  setLoad(0.94, 'raising villages');
  const structures = new Structures(engine.scene, world, assets).build();
  game.structures = structures;

  setLoad(0.96, 'lighting the braziers');
  const particles = new Particles(engine.scene);
  game.particles = particles;
  game.floating = new FloatingText(engine.scene, engine.camera);

  setLoad(0.97, 'waking the husks');
  const combat = new Combat({
    scene: engine.scene, camera: engine.camera, world, structures, vegetation,
    player: null, enemies: null, particles, floating: game.floating, events: bus,
  });
  game.combat = combat;
  const enemies = new Enemies({
    scene: engine.scene, world, structures, vegetation, player: null,
    particles, floating: game.floating, events: bus, combat,
  });
  game.enemies = enemies;

  const worldObjects = new WorldObjects({
    scene: engine.scene, world, structures, vegetation, particles,
    events: bus, combat, enemies, hud: null,
  }).build();
  game.worldObjects = worldObjects;

  setLoad(0.98, 'compiling shaders');
  engine.attachPostFX(sky);
  engine.postfx.setCloudNoise(makeCloudNoise(64, 3));

  // ------------------------------------------------------------- player etc
  const player = new Player({
    scene: engine.scene, camera: engine.camera, world, terrain, structures,
    vegetation, input, events: bus, particles, combat, audio, enemies,
    aimRay: (origin, dir) => {
      const r = combat.aimPoint(origin, dir, 400);
      return r ? { point: r.point } : null;
    },
  });
  game.player = player;
  combat.ctx.player = player;
  combat.ctx.enemies = enemies;
  enemies.ctx.player = player;
  worldObjects.ctx.player = player;
  worldObjects.ctx.hud = null;

  applySkills(player);
  player.squad = null;

  const squad = new Squad({
    scene: engine.scene, world, structures, vegetation, particles, enemies,
    events: bus, audio, assets, combat,
  });
  game.squad = squad;
  player.squad = squad;
  applySkills(player);

  const quests = new Quests(game);
  game.quests = quests;
  worldObjects.ctx.quests = quests;

  const hud = new HUD(game);
  game.hud = hud;
  worldObjects.ctx.hud = hud;

  const menus = new Menus(game);
  game.menus = menus;

  wireEvents();

  // ------------------------------------------------------------- loop
  game.menuCam = { angle: 0 };
  engine.add({ update: (dt) => frame(dt) });
  engine.onFrameEnd = (dt) => {
    input.endFrame();
    const f = el('fps');
    if (f && settings.get('showFps')) {
      f.textContent = `${engine.fps.toFixed(0)} fps · ${engine.frameTime.toFixed(1)} ms · ${engine.renderer.info.render.calls} calls · ${(engine.renderer.info.render.triangles / 1000).toFixed(0)}k tris`;
    }
  };

  // pre-compile every program up front so the first frame does not stall
  setLoad(0.99, 'warming shaders');
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try { engine.renderer.compile(engine.scene, engine.camera); } catch (e) { console.warn('shader precompile', e); }

  setLoad(1, 'ready');
  game.ready = true;
  ui.loading.classList.add('hidden');
  game.state = 'menu';
  menus.show('menu');

  // unlock audio on the first gesture
  const unlock = () => {
    audio.init();
    audio.resume();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  engine.start();
  window.dispatchEvent(new CustomEvent('game:ready', { detail: game }));
}

// ================================================================== events
function wireEvents() {
  const p = game.player;

  bus.on('enemy:killed', ({ enemy }) => {
    game.hud.kill(`${enemy.def.name}${enemy.lvl > 1 ? `  L${enemy.lvl}` : ''} defeated`);
    game.particles.burst(
      new THREE.Vector3(enemy.pos.x, enemy.pos.y + 1, enemy.pos.z),
      { count: 10, speed: 5, color: 0x53ffc8, life: 0.7, size: 0.16 }
    );
    if (enemy.def.boss) {
      game.worldObjects.dropLoot(enemy.pos, 'core', 3);
      game.hud.note('THE HOLLOW VOICE IS SILENCED', 'good');
    } else if (Math.random() < 0.34) {
      game.worldObjects.dropLoot(enemy.pos, 'core', 1);
    }
    game.worldObjects.dropLoot(enemy.pos, 'shard', 1 + Math.floor(Math.random() * 2));
  });

  bus.on('headshot', () => game.hud.hit());
  bus.on('weapon:fired', () => { /* hook for achievements */ });

  bus.on('player:damaged', ({ amount }) => {
    game.hud.flashDamage(amount);
    audio.play('player_hurt', { gain: clamp(amount / 60, 0.2, 1) });
  });
  bus.on('player:downed', () => {
    audio.play('downed');
    game.hud.note('DOWNED — a companion is coming for you', 'bad');
  });
  bus.on('player:dead', () => {
    game.state = 'dead';
    input.exitLock();
    game.menus.showDeath('The husks overran you. The shard keeps whispering.');
  });
  bus.on('player:levelup', (lvl) => {
    audio.play('levelup');
    game.hud.note(`LEVEL ${lvl} — skill point available (K)`, 'good');
    game.particles.heal(game.player.pos);
  });
  bus.on('player:interact', () => {
    const handled = game.worldObjects.interact(game.player);
    if (!handled) {
      // revive a downed companion
      for (const m of game.squad.members) {
        if (m.down && m.pos.distanceTo(game.player.pos) < 3) {
          m.revive();
          game.hud.note(`${m.name} is back up`, 'good');
        }
      }
    }
  });
  bus.on('bark', ({ who, text }) => {
    if (settings.get('subtitles', true)) game.hud.subtitle(who.name.split(' ')[0], text);
    audio.play('ui_hover', { gain: 0.2 });
  });
  bus.on('quest:started', (q) => game.hud.note('NEW QUEST — ' + q.title, 'quest'));
  bus.on('quest:complete', () => audio.play('levelup', { gain: 0.7 }));
  bus.on('nest:destroyed', () => game.hud.note('NEST SILENCED', 'good'));
  bus.on('nest:destroyed', (n) => { if (n) game.particles.explosion(new THREE.Vector3(n.x, n.y + 2, n.z), 8, 0x53ffc8); });
  bus.on('explosion', () => audio.play('explosion', { gain: 0.8 }));
  bus.on('companion:down', (m) => game.hud.note(`${m.name} is down`, 'bad'));
  bus.on('squad:command', (mode) => game.hud.note('SQUAD: ' + mode.toUpperCase()));
  bus.on('camera:mode', () => game.hud.note(game.player.thirdPerson ? 'THIRD PERSON' : 'FIRST PERSON'));
  bus.on('ability:used', (kind) => game.hud.note('ABILITY: ' + kind.toUpperCase()));
  bus.on('npc:talk', (n) => { if (settings.get('subtitles', true) && n.line) game.hud.subtitle(n.name, n.line); });
}

// ================================================================== flow
game.beginPlay = async function beginPlay({ load }) {
  const p = game.player;
  if (load) {
    loadGame(game);
  } else {
    p.pos.set(game.world.start.x, game.world.start.y, game.world.start.z);
    p.pos.y = game.world.heightAt(p.pos.x, p.pos.z) + 0.2;
  }
  p.health = p.maxHealth;
  p.shield = p.maxShield;
  p.stamina = p.maxStamina;
  p.downed = false;
  p.dead = false;
  p.grenades = p.grenadeMax || 3;
  p.reviveProgress = 0;
  p.char.revive();

  game.squad.spawn(p);
  game.enemies.difficulty = 1 + (p.level - 1) * 0.07;
  game.enemies.populate();
  applySkills(p);

  audio.init();
  audio.resume();
  audio.startMusic();

  game.state = 'intro';
  game.paused = false;
  game.hud.hide();
  p.cameraEnabled = false;   // the cinematic owns the camera until it ends
  document.getElementById('ui').classList.add('playing');

  const intro = new IntroCinematic({
    scene: game.engine.scene, camera: game.engine.camera, world: game.world,
    sky: game.sky, particles: game.particles, audio, events: bus,
    playerStart: p.pos.clone(),
  });
  game.intro = intro;
  if (load) {
    // skip straight to gameplay for a loaded run
    intro.build();
    await new Promise((r) => setTimeout(r, 120));
    game.enterPlay();
    return;
  }
  // "press any key to skip" hint (fades out on its own)
  const hint = document.createElement('div');
  hint.textContent = 'press any key to skip';
  hint.style.cssText = 'position:absolute;left:50%;bottom:5.5%;transform:translateX(-50%);padding:8px 16px;'
    + 'color:rgba(255,255,255,.8);font:600 12px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.16em;'
    + 'text-transform:uppercase;pointer-events:none;opacity:0;transition:opacity .8s;text-shadow:0 2px 10px rgba(0,0,0,.9)';
  document.getElementById('ui').appendChild(hint);
  requestAnimationFrame(() => { hint.style.opacity = '1'; });
  const hintTimer = setTimeout(() => { hint.style.opacity = '0'; }, 4500);

  // ignore the click that dismissed the main menu, then allow skipping
  const t0 = performance.now();
  const skip = (e) => {
    if (performance.now() - t0 < 800) return;
    if (e.type === 'keydown' && e.code !== 'Escape') intro.skip();
    else if (e.type === 'pointerdown') intro.skip();
  };
  window.addEventListener('keydown', skip);
  window.addEventListener('pointerdown', skip);
  await intro.start();
  window.removeEventListener('keydown', skip);
  window.removeEventListener('pointerdown', skip);
  clearTimeout(hintTimer);
  hint.remove();
  game.enterPlay();
};

game.enterPlay = function enterPlay() {
  game.state = 'play';
  game.paused = false;
  game.player.cameraEnabled = true;
  game.player.camPos.copy(game.engine.camera.position);
  game.hud.show();
  input.requestLock();
  game.hud.note('SURVIVE. FIND THE SHARD. END THE FALL.', 'quest');
  game.squad.members[0].bark('You alive down there? The whole ridge is moving.');
};

game.setPaused = function setPaused(v) {
  game.paused = v;
  input.enabled = !v;
  if (v) input.exitLock();
};

game.respawn = function respawn() {
  const p = game.player;
  const c = game.world.crater;
  // respawn at the nearest attuned beacon, else the start
  let sx = game.world.start.x, sz = game.world.start.z, best = Infinity;
  for (const b of game.worldObjects.beacons) {
    if (!b.attuned) continue;
    const d = Math.hypot(b.x - p.pos.x, b.z - p.pos.z);
    if (d < best) { best = d; sx = b.x; sz = b.z; }
  }
  p.pos.set(sx, game.world.heightAt(sx, sz) + 1.2, sz);
  p.health = p.maxHealth;
  p.shield = p.maxShield;
  p.stamina = p.maxStamina;
  p.dead = false;
  p.downed = false;
  p.downTimer = 0;
  p.vel.set(0, 0, 0);
  p.char.revive();
  p.grenades = p.grenadeMax || 3;
  game.squad.spawn(p);
  for (const m of game.squad.members) if (m.down) m.revive();
  game.state = 'play';
  game.paused = false;
};

game.fastTravel = function fastTravel(x, z) {
  const p = game.player;
  p.pos.set(x, game.world.heightAt(x, z) + 1.4, z);
  p.vel.set(0, 0, 0);
  game.squad.spawn(p);
  game.hud.note('TRAVELLED', 'good');
};

game.onSettingsChanged = function onSettingsChanged(key, value) {
  if (key === 'preset') {
    game.sky?.setQuality(value);
    game.engine.postfx?.applyQuality();
    game.terrain?.applyQuality?.(value);
  }
  if (key === 'fov' && game.player) game.player.fovBase = value;
  audio.applyVolumes();
};

// ================================================================== frame
function frame(dt) {
  const { engine, world, sky, terrain, water, vegetation, player, squad, enemies, combat, particles, worldObjects, hud } = game;
  game.elapsed += dt;
  const cam = engine.camera;

  // ---- global keys
  if (input.codePressed('Escape')) {
    if (game.state === 'play') {
      if (game.menus.isOpen()) { game.menus.hideAll(); game.setPaused(false); }
      else { game.menus.show('pause'); }
    } else if (game.menus.isOpen() && game.menus.current !== 'menu' && game.menus.current !== 'loading') {
      if (game.menus.current === 'settings') game.menus.show(game.menus.prev || 'menu');
      else if (game.menus.current !== 'death') { game.menus.hideAll(); game.setPaused(false); }
    }
  }
  if (game.state === 'play' && !game.paused) {
    if (input.codePressed('KeyM') || input.codePressed('Tab')) game.menus.show('worldmap');
    if (input.codePressed('KeyI')) game.menus.show('inventory');
    if (input.codePressed('KeyK')) game.menus.show('skills');
    if (input.codePressed('KeyJ')) game.menus.show('journal');
    if (input.codePressed('KeyZ')) { squad.command('follow'); }
    if (input.codePressed('KeyX')) { squad.command('hold'); }
    if (input.codePressed('KeyB')) { squad.command('attack'); }
  }

  // ---- world systems always run (nice behind menus)
  const active = !game.paused;
  if (!game.paused || game.state === 'menu') {
    advanceClock(dt, game.state !== 'menu');
    sky.update(dt, cam);
    terrain.update(cam.position, dt);
    water.update(dt, cam);
    vegetation.update(dt, cam);
    particles.update(dt);
    game.floating.update(dt);
  }

  if (game.state === 'menu') {
    updateMenuCamera(dt);
  } else if (game.state === 'intro') {
    game.intro.update(dt);
    worldObjects.update(dt, player);
    enemies.update(dt);
    combat.update(dt);
    squad.update(dt, player);
    player.update(dt, { down: () => false, codeDown: () => false, codePressed: () => false, mouseDX: 0, mouseDY: 0, wheel: 0 });
  } else if (game.state === 'play' && !game.paused) {
    player.update(dt, input);
    squad.update(dt, player);
    enemies.update(dt);
    combat.update(dt);
    worldObjects.update(dt, player);
    game.quests.update(dt);
    hud.update(dt);
    // music intensity from nearby hostiles
    let threat = 0;
    for (const e of enemies.active) {
      if (e.state === 'dead') continue;
      const d = Math.hypot(e.pos.x - player.pos.x, e.pos.z - player.pos.z);
      if (d < 90) threat += 1 - d / 90;
    }
    audio.setMusicIntensity(clamp(threat / 5, 0, 1));
    // auto-save every 90 s
    game.saveT = (game.saveT || 0) + dt;
    if (game.saveT > 90) { game.saveT = 0; saveGame(game); }
  }

  audio.update(dt, cam);
}

function advanceClock(dt, running) {
  const sky = game.sky;
  if (!sky) return;
  if (running) {
    const perSec = 24 / (sky.dayLengthMinutes * 60);
    game.clock = (game.clock + perSec * dt) % 24;
  } else {
    game.clock = (game.clock + dt * 0.02) % 24;
  }
  sky.setTime(game.clock);
  // gentle weather drift
  const w = sky.weather;
  game.weatherT = (game.weatherT || 0) + dt;
  if (game.weatherT > 8) {
    game.weatherT = 0;
    const target = clamp(0.42 + Math.sin(game.clock / 24 * Math.PI * 2) * 0.22 + (Math.random() - 0.5) * 0.18, 0.08, 0.86);
    w.cloudiness += (target - w.cloudiness) * 0.4;
    w.windSpeed = 2 + w.cloudiness * 7;
    w.coverage = clamp(w.cloudiness * 1.1, 0, 1);
  }
}

function updateMenuCamera(dt) {
  // slow, cinematic drift over the continent behind the main menu
  const cam = game.engine.camera;
  const c = game.world.crater || { x: 0, z: 0 };
  game.menuCam.angle += dt * 0.018;
  const r = 1750;
  const x = c.x + Math.cos(game.menuCam.angle) * r;
  const z = c.z + Math.sin(game.menuCam.angle) * r;
  const y = Math.max(game.world.heightAt(x, z) + 240, 180);
  cam.position.lerp(new THREE.Vector3(x, y, z), clamp(dt * 0.6, 0, 1));
  cam.lookAt(c.x, game.world.heightAt(c.x, c.z) + 60, c.z);
  if (Math.abs(cam.fov - 55) > 0.01) { cam.fov = 55; cam.updateProjectionMatrix(); }
}

// pointer lock on canvas click while playing
window.addEventListener('pointerdown', () => {
  if (game.state === 'play' && !game.paused && !game.menus.isOpen()) input.requestLock();
});

boot().catch((e) => {
  console.error(e);
  ui.status.textContent = 'ERROR: ' + e.message;
  showError('BOOT FAILED: ' + e.stack);
});
