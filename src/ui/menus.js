// Menus, panels, world map, inventory, skills, journal and the death screen.
import { SKILL_TREES, ALL_SKILLS, spendPoint, respec, applySkills } from '../game/progression.js';
import { WEAPONS } from '../combat/weapons.js';
import { saveGame, loadGame, hasSave, clearSave } from '../game/save.js';
import settings, { PRESETS } from '../core/settings.js';
import { WORLD } from '../world/constants.js';
import { clamp } from '../core/rng.js';

const $ = (id) => document.getElementById(id);

export class Menus {
  constructor(game) {
    this.game = game;
    this.screens = ['loading', 'menu', 'settings', 'pause', 'worldmap', 'inventory', 'skills', 'journal', 'death'];
    this.current = 'loading';
    this.bind();
    this.buildSettings();
  }

  bind() {
    document.body.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      this.game.audio?.play('ui_click');
      this.act(btn.dataset.act, btn);
    });
    document.body.addEventListener('mouseover', (e) => {
      if (e.target.closest('.btn, .skill-node, .inv-item, .quest-item')) this.game.audio?.play('ui_hover', { gain: 0.4 });
    });
  }

  act(action) {
    const g = this.game;
    switch (action) {
      case 'continue':
        this.hideAll();
        g.beginPlay({ load: hasSave() });
        break;
      case 'new':
        clearSave();
        this.hideAll();
        g.beginPlay({ load: false });
        break;
      case 'settings': this.prev = this.current; this.show('settings'); break;
      case 'open-settings': this.prev = 'pause'; this.show('settings'); break;
      case 'close-settings': this.show(this.prev || 'menu'); break;
      case 'controls': this.showControls(); break;
      case 'credits': this.showCredits(); break;
      case 'resume': this.hideAll(); g.setPaused(false); break;
      case 'save':
        saveGame(g);
        g.hud?.note('GAME SAVED', 'good');
        this.hideAll(); g.setPaused(false);
        break;
      case 'quit':
        saveGame(g);
        g.setPaused(true);
        this.show('menu');
        break;
      case 'respawn':
        g.respawn();
        this.hideAll();
        g.setPaused(false);
        break;
      case 'close-map': case 'close-inv': case 'close-skills': case 'close-journal':
        this.hideAll(); g.setPaused(false);
        break;
    }
  }

  show(id) {
    for (const s of this.screens) {
      const el = $(s);
      if (!el) continue;
      el.classList.toggle('hidden', s !== id);
    }
    this.current = id;
    if (id === 'inventory') this.buildInventory();
    if (id === 'skills') this.buildSkills();
    if (id === 'journal') this.buildJournal();
    if (id === 'worldmap') this.buildWorldMap();
    if (id !== 'loading' && id !== 'menu' && id !== 'death') this.game.setPaused(true);
  }

  hideAll() {
    for (const s of this.screens) $(s)?.classList.add('hidden');
    this.current = null;
  }

  isOpen() { return this.current !== null; }

  // ------------------------------------------------------------- settings
  buildSettings() {
    const rows = $('settings-rows');
    if (!rows) return;
    const spec = [
      { key: 'preset', label: 'Quality Preset', type: 'choice', options: Object.keys(PRESETS) },
      { key: 'resolutionScale', label: 'Render Scale', type: 'range', min: 0.5, max: 1.5, step: 0.05 },
      { key: 'fov', label: 'Field of View', type: 'range', min: 55, max: 110, step: 1 },
      { key: 'sensitivity', label: 'Mouse Sensitivity', type: 'range', min: 0.2, max: 3, step: 0.05 },
      { key: 'invertY', label: 'Invert Y', type: 'bool' },
      { key: 'cameraShake', label: 'Camera Shake', type: 'range', min: 0, max: 2, step: 0.1 },
      { key: 'dynamicResolution', label: 'Dynamic Resolution', type: 'bool' },
      { key: 'showFps', label: 'Show FPS', type: 'bool' },
      { key: 'subtitles', label: 'Subtitles', type: 'bool' },
      { key: 'master', label: 'Master Volume', type: 'range', min: 0, max: 1, step: 0.05 },
      { key: 'sfx', label: 'SFX Volume', type: 'range', min: 0, max: 1, step: 0.05 },
      { key: 'music', label: 'Music Volume', type: 'range', min: 0, max: 1, step: 0.05 },
    ];
    rows.innerHTML = spec.map((s) => {
      const v = settings.get(s.key);
      let input = '';
      if (s.type === 'range') {
        input = `<input type="range" min="${s.min}" max="${s.max}" step="${s.step}" value="${v}" data-key="${s.key}"><span class="val">${v}</span>`;
      } else if (s.type === 'bool') {
        input = `<input type="checkbox" data-key="${s.key}" ${v ? 'checked' : ''}>`;
      } else if (s.type === 'choice') {
        input = `<select data-key="${s.key}">${s.options.map((o) => `<option value="${o}" ${v === o ? 'selected' : ''}>${o.toUpperCase()}</option>`).join('')}</select>`;
      }
      return `<div class="row"><label>${s.label}</label><div class="ctl">${input}</div></div>`;
    }).join('');

    rows.addEventListener('input', (e) => {
      const el = e.target;
      const key = el.dataset.key;
      if (!key) return;
      const val = el.type === 'checkbox' ? el.checked : el.type === 'range' ? parseFloat(el.value) : el.value;
      settings.set(key, val);
      const v = rows.querySelector(`[data-key="${key}"]`)?.parentElement.querySelector('.val');
      if (v) v.textContent = typeof val === 'number' ? val.toFixed(2) : val;
      this.game.onSettingsChanged(key, val);
    });
  }

  showControls() {
    const rows = $('settings-rows');
    if (!rows) return;
    rows.innerHTML = `
      <div class="controls-grid">
        <div><b>W A S D</b><span>Move</span></div>
        <div><b>Mouse</b><span>Look</span></div>
        <div><b>Shift</b><span>Sprint</span></div>
        <div><b>Ctrl / C</b><span>Crouch / Slide</span></div>
        <div><b>Space</b><span>Jump / Vault / Dodge (A·D·S)</span></div>
        <div><b>LMB</b><span>Fire</span></div>
        <div><b>RMB</b><span>Aim down sights</span></div>
        <div><b>R</b><span>Reload</span></div>
        <div><b>1 – 4 / Wheel</b><span>Swap weapon</span></div>
        <div><b>F</b><span>Aether blade</span></div>
        <div><b>Q</b><span>Aether pulse</span></div>
        <div><b>G</b><span>Shard grenade</span></div>
        <div><b>H</b><span>Stim</span></div>
        <div><b>E</b><span>Interact</span></div>
        <div><b>V</b><span>First / third person</span></div>
        <div><b>Z · X · B</b><span>Squad: follow / hold position / focus fire</span></div>
        <div><b>M · Tab</b><span>World map</span></div>
        <div><b>I · K · J</b><span>Loadout · Skills · Journal</span></div>
        <div><b>Esc</b><span>Pause</span></div>
      </div>`;
    this.prev = this.current;
    this.show('settings');
  }

  showCredits() {
    const rows = $('settings-rows');
    if (!rows) return;
    rows.innerHTML = `
      <div class="credits">
        <h3>AETHERFALL — CRADLE OF ASH</h3>
        <p>A single-player, squad-based open world built for the web.</p>
        <h4>ASSETS</h4>
        <p>Kenney (CC0) — fantasy town, castle kit, graveyard, survival props, nature &amp; mini-forest packs.<br>
        Poly Pizza stylized nature (CC0).<br>
        three.js examples — Soldier, Xbot, Michelle, RobotExpressive characters and PBR textures.<br>
        ambientCG (CC0) — surface materials.</p>
        <h4>TECHNOLOGY</h4>
        <p>three.js r186 · custom sky &amp; volumetric clouds · GPU terrain with erosion · procedural PBR · WebAudio synthesis.</p>
        <h4>SPECIAL THANKS</h4>
        <p>Everyone who keeps making beautiful things and giving them away.</p>
      </div>`;
    this.prev = this.current;
    this.show('settings');
  }

  // ------------------------------------------------------------- inventory
  buildInventory() {
    const grid = $('inv-grid');
    if (!grid) return;
    const p = this.game.player;
    grid.innerHTML = p.weapons.map((w, i) => {
      const s = w.def.stats;
      const bar = (label, v) => `<div class="stat"><span>${label}</span><div class="stat-bar"><div style="width:${v * 10}%"></div></div></div>`;
      return `<div class="inv-item ${i === p.weaponIndex ? 'equipped' : ''}" data-w="${i}">
        <div class="inv-head"><b>${w.def.name}</b><i>LV ${w.level}</i></div>
        <div class="inv-desc">${w.def.desc}</div>
        <div class="inv-stats">
          ${bar('DMG', s.damage)}${bar('RATE', s.rate)}${bar('RANGE', s.range)}${bar('CTRL', s.control)}${bar('MOB', s.mobility)}
        </div>
        <div class="inv-foot">
          <span>${w.def.magSize === Infinity ? 'MELEE' : `MAG ${w.def.magSize}`}</span>
          <span>AMMO ∞</span>
          <span>${Math.round(w.damage)} dmg</span>
          <span>${w.def.rpm} rpm</span>
        </div>
        <div class="inv-xp"><div style="width:${clamp((w.xp / (120 + (w.level - 1) * 90)) * 100, 0, 100)}%"></div></div>
      </div>`;
    }).join('');
    grid.querySelectorAll('.inv-item').forEach((el) => {
      el.onclick = () => {
        const i = parseInt(el.dataset.w, 10);
        p.equip(i);
        p.showCurrentWeapon();
        this.buildInventory();
        this.game.audio?.play('ui_click');
      };
    });
  }

  // ------------------------------------------------------------- skills
  buildSkills() {
    const cols = $('skill-cols');
    if (!cols) return;
    const p = this.game.player;
    $('skill-points').textContent = `SKILL POINTS: ${p.skillPoints}` + (p.skillPoints > 0 ? '  (click a node to spend)' : '');
    cols.innerHTML = SKILL_TREES.map((tree) => `
      <div class="skill-col" style="--c:${tree.color}">
        <h3>${tree.name}</h3>
        ${tree.skills.map((s) => {
          const rank = p.skills[s.id] || 0;
          const pips = Array.from({ length: s.max }, (_, i) => `<i class="${i < rank ? 'on' : ''}"></i>`).join('');
          return `<div class="skill-node ${rank >= s.max ? 'maxed' : ''}" data-s="${s.id}">
            <div class="sn-head"><b>${s.name}</b><span>${rank}/${s.max}</span></div>
            <div class="sn-pips">${pips}</div>
            <div class="sn-desc">${s.desc}</div>
          </div>`;
        }).join('')}
      </div>`).join('');
    cols.querySelectorAll('.skill-node').forEach((el) => {
      el.onclick = () => {
        if (spendPoint(p, el.dataset.s)) {
          this.game.audio?.play('levelup', { gain: 0.5 });
          applySkills(this.game.player);
          if (this.game.squad) this.game.player.squad = this.game.squad;
          this.buildSkills();
        } else this.game.audio?.play('error', { gain: 0.3 });
      };
    });
  }

  // ------------------------------------------------------------- journal
  buildJournal() {
    const list = $('quest-list');
    const detail = $('quest-detail');
    if (!list) return;
    const q = this.game.quests;
    const all = [...q.active, ...q.defs.filter((d) => q.done.has(d.id)).map((d) => ({ id: d.id, title: d.title, desc: d.desc, main: d.main, complete: true, objectives: d.objectives.map((o) => ({ ...o, done: true, progress: o.count || 1 })), index: 0 }))];
    list.innerHTML = all.map((quest) => `
      <div class="quest-item ${quest.main ? 'main' : ''} ${quest.complete ? 'done' : ''}" data-q="${quest.id}">
        <b>${quest.title}</b><span>${quest.complete ? 'COMPLETE' : (quest.main ? 'MAIN' : 'SIDE')}</span>
      </div>`).join('');
    const show = (id) => {
      const quest = all.find((x) => x.id === id);
      if (!quest) return;
      detail.innerHTML = `<h3>${quest.title}</h3>
        <p class="qdesc">${quest.desc}</p>
        <ul>${quest.objectives.map((o, i) => `<li class="${o.done || i < quest.index ? 'done' : ''}">${o.text} ${o.count ? `<i>${o.progress || 0}/${o.count}</i>` : ''}</li>`).join('')}</ul>
        ${quest.def?.rewards ? `<div class="rewards">Rewards: ${quest.def.rewards.xp || 0} XP${quest.def.rewards.shards ? ` · ${quest.def.rewards.shards} shards` : ''}${quest.def.rewards.aether ? ` · ${quest.def.rewards.aether} aether` : ''}</div>` : ''}`;
      list.querySelectorAll('.quest-item').forEach((el) => el.classList.toggle('sel', el.dataset.q === id));
    };
    list.querySelectorAll('.quest-item').forEach((el) => { el.onclick = () => show(el.dataset.q); });
    if (all[0]) show(all[0].id);
  }

  // ------------------------------------------------------------- world map
  buildWorldMap() {
    const canvas = $('map-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const g = this.game;
    const base = g.hud.base;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0, canvas.width, canvas.height);
    const S = canvas.width;
    const toMap = (x, z) => [((x + WORLD.HALF) / WORLD.SIZE) * S, ((z + WORLD.HALF) / WORLD.SIZE) * S];

    // rivers & roads already baked
    // POIs
    ctx.font = '13px Arial';
    ctx.textAlign = 'center';
    for (const poi of g.world.pois) {
      const [x, y] = toMap(poi.x, poi.z);
      ctx.fillStyle = poi.discovered ? '#ffd479' : 'rgba(160,170,185,0.55)';
      ctx.beginPath();
      ctx.arc(x, y, poi.discovered ? 6 : 4, 0, Math.PI * 2);
      ctx.fill();
      if (poi.discovered) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillText(poi.name || poi.kind, x, y - 10);
      }
    }
    // nests
    for (const n of g.worldObjects.nests) {
      const [x, y] = toMap(n.x, n.z);
      ctx.fillStyle = n.destroyed ? 'rgba(90,110,100,0.5)' : '#53ffc8';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    // crater
    const c = g.world.crater;
    if (c) {
      const [x, y] = toMap(c.x, c.z);
      ctx.strokeStyle = '#ff7a3c';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, (c.radius / WORLD.SIZE) * S, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#ffb060';
      ctx.font = 'bold 15px Arial';
      ctx.fillText('CRASH SITE', x, y - (c.radius / WORLD.SIZE) * S - 8);
    }
    // player
    const p = g.player;
    const [px, py] = toMap(p.pos.x, p.pos.z);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(px, py - 10); ctx.lineTo(px - 7, py + 7); ctx.lineTo(px + 7, py + 7);
    ctx.closePath(); ctx.fill();

    // legend / info
    const info = $('map-info');
    if (info) {
      info.innerHTML = `
        <div class="mi"><b>LOCATION</b><span>${(g.world.poiAt(p.pos.x, p.pos.z)?.name) || 'The open road'}</span></div>
        <div class="mi"><b>LEVEL</b><span>${p.level}</span></div>
        <div class="mi"><b>HUSKS SLAIN</b><span>${g.enemies.killCount}</span></div>
        <div class="mi"><b>NESTS DESTROYED</b><span>${g.worldObjects.nests.filter((n) => n.destroyed).length} / ${g.worldObjects.nests.length}</span></div>
        <div class="mi"><b>SHARDS</b><span>${p.shards}</span></div>
        <div class="mi"><b>AETHER</b><span>${p.aether}</span></div>
        <div class="fast-travel"><b>FAST TRAVEL</b>${g.worldObjects.beacons.filter((b) => b.attuned).map((b, i) => `<button class="ft" data-ft="${i}">${(b.poi.name || b.poi.kind).toUpperCase()}</button>`).join('') || '<i>No beacons attuned yet.</i>'}</div>`;
      info.querySelectorAll('.ft').forEach((btn) => {
        btn.onclick = () => {
          const list = g.worldObjects.beacons.filter((b) => b.attuned);
          const b = list[parseInt(btn.dataset.ft, 10)];
          if (!b) return;
          g.fastTravel(b.x, b.z);
          this.hideAll();
          g.setPaused(false);
        };
      });
    }
    $('map-legend').innerHTML = `
      <div><i style="background:#ffd479"></i>Settlement</div>
      <div><i style="background:#53ffc8"></i>Shard nest</div>
      <div><i style="background:#ff7a3c"></i>Crash site</div>
      <div><i style="background:#fff"></i>You</div>`;
  }

  showDeath(reason) {
    $('death-sub').textContent = reason || 'The husks will remember you.';
    this.show('death');
  }
}
