// In-game HUD: vitals, weapon, minimap, compass, kill feed, subtitles, damage.
import * as THREE from 'three';
import { clamp, lerp } from '../core/rng.js';
import { WORLD } from '../world/constants.js';

const $ = (id) => document.getElementById(id);

export class HUD {
  constructor(game) {
    this.game = game;
    this.el = {
      hud: $('hud'),
      health: $('bar-health'), shield: $('bar-shield'), stamina: $('bar-stamina'),
      weaponName: $('weapon-name'), ammoMag: $('ammo-mag'), ammoRes: $('ammo-res'), slots: $('weapon-slots'),
      xp: $('xp-fill'), xpLevel: $('xp-level'),
      squad: $('squad-status'), quest: $('quest-tracker'),
      killfeed: $('killfeed'), notifications: $('notifications'), subtitles: $('subtitles'),
      crosshair: $('crosshair'), hitmarker: $('hitmarker'), damage: $('damage-layer'),
      minimap: $('minimap'), compass: $('compass-strip'),
      interact: $('interact-prompt'), threat: $('threat-text'), fps: $('fps'),
    };
    this.mm = this.el.minimap.getContext('2d');
    this.crossSpread = 0;
    this.hitTime = 0;
    this.feedItems = [];
    this.notes = [];
    this.subs = [];
    this.hpSmooth = 1; this.shSmooth = 1;
    this.buildBase();
    this.buildSlots();
    this.lastFps = 0;
    this.hudVisible = false;
  }

  show() { this.el.hud.classList.remove('hidden'); this.hudVisible = true; }
  hide() { this.el.hud.classList.add('hidden'); this.hudVisible = false; }

  // ------------------------------------------------------------- minimap base
  buildBase() {
    const world = this.game.world;
    const S = 1024;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const img = g.createImageData(S, S);
    const d = img.data;
    const N = 1024; // splat resolution
    const splat = world.splat;
    const mask = world.mask;
    for (let y = 0; y < S; y++) {
      const sy = Math.floor((y / S) * N);
      for (let x = 0; x < S; x++) {
        const sx = Math.floor((x / S) * N);
        const si = (sy * N + sx) * 4;
        const grass = splat[si] / 255, dirt = splat[si + 1] / 255, rock = splat[si + 2] / 255, snow = splat[si + 3] / 255;
        const scorch = mask[si + 2] / 255;
        const river = mask[si + 1] / 255;
        let r = grass * 62 + dirt * 118 + rock * 104 + snow * 226;
        let gg = grass * 108 + dirt * 96 + rock * 100 + snow * 232;
        let b = grass * 58 + dirt * 70 + rock * 98 + snow * 240;
        if (scorch > 0.3) { const k = Math.min(1, (scorch - 0.3) * 1.6); r = lerp(r, 42, k); gg = lerp(gg, 34, k); b = lerp(b, 38, k); }
        if (river > 0.35) { const k = Math.min(1, (river - 0.35) * 2.2); r = lerp(r, 34, k); gg = lerp(gg, 86, k); b = lerp(b, 132, k); }
        // height shade
        const hi = Math.floor((sy * (WORLD.N - 1)) / (N - 1));
        const hj = Math.floor((sx * (WORLD.N - 1)) / (N - 1));
        const h = world.height[hi * WORLD.N + hj] ?? 0;
        const shade = clamp(0.72 + (h > 0 ? Math.min(0.5, h / 900) : Math.max(-0.35, h / 60)), 0.3, 1.35);
        const i = (y * S + x) * 4;
        d[i] = clamp(r * shade, 0, 255);
        d[i + 1] = clamp(gg * shade, 0, 255);
        d[i + 2] = clamp(b * shade, 0, 255);
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    // roads
    g.strokeStyle = 'rgba(214,196,150,0.5)';
    g.lineWidth = 2;
    for (const r of world.roads) {
      g.beginPath();
      for (let i = 0; i < r.count; i++) {
        const x = ((r.pts[i * 4] + WORLD.HALF) / WORLD.SIZE) * S;
        const y = ((r.pts[i * 4 + 1] + WORLD.HALF) / WORLD.SIZE) * S;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    }
    this.base = c;
  }

  buildSlots() {
    const p = this.game.player;
    if (!p) return;
    this.el.slots.innerHTML = '';
    p.weapons.forEach((w, i) => {
      const d = document.createElement('div');
      d.className = 'slot';
      d.innerHTML = `<b>${i + 1}</b><span>${w.def.name.split(' ')[0]}</span>`;
      d.onclick = () => { p.equip(i); p.showCurrentWeapon(); };
      this.el.slots.appendChild(d);
    });
  }

  // ------------------------------------------------------------- events
  note(text, cls = '') {
    const d = document.createElement('div');
    d.className = 'note ' + cls;
    d.textContent = text;
    this.el.notifications.appendChild(d);
    this.notes.push({ el: d, t: 4.2 });
    while (this.notes.length > 5) { const o = this.notes.shift(); o.el.remove(); }
  }
  kill(text) {
    const d = document.createElement('div');
    d.className = 'feed';
    d.textContent = text;
    this.el.killfeed.appendChild(d);
    this.feedItems.push({ el: d, t: 5 });
    while (this.feedItems.length > 6) { const o = this.feedItems.shift(); o.el.remove(); }
  }
  subtitle(who, text) {
    const d = document.createElement('div');
    d.className = 'sub';
    d.innerHTML = `<b>${who}:</b> ${text}`;
    this.el.subtitles.appendChild(d);
    this.subs.push({ el: d, t: 5.5 });
    while (this.subs.length > 3) { const o = this.subs.shift(); o.el.remove(); }
  }
  hit() { this.hitTime = 0.16; this.el.hitmarker.classList.add('on'); }
  flashDamage(amount) {
    const d = document.createElement('div');
    d.className = 'dmg-flash';
    d.style.opacity = clamp(amount / 45, 0.15, 0.8);
    this.el.damage.appendChild(d);
    setTimeout(() => d.remove(), 500);
  }
  prompt(text) {
    if (!text) { this.el.interact.classList.add('hidden'); return; }
    this.el.interact.classList.remove('hidden');
    this.el.interact.innerHTML = `<b>E</b> ${text}`;
  }

  // ------------------------------------------------------------- frame
  update(dt) {
    const g = this.game;
    const p = g.player;
    if (!p) return;
    const el = this.el;

    // bars
    this.hpSmooth = lerp(this.hpSmooth, p.health / p.maxHealth, clamp(dt * 8, 0, 1));
    this.shSmooth = lerp(this.shSmooth, p.shield / p.maxShield, clamp(dt * 8, 0, 1));
    el.health.style.width = (this.hpSmooth * 100).toFixed(1) + '%';
    el.shield.style.width = (this.shSmooth * 100).toFixed(1) + '%';
    el.stamina.style.width = ((p.stamina / p.maxStamina) * 100).toFixed(1) + '%';
    el.health.style.background = this.hpSmooth < 0.3 ? 'linear-gradient(90deg,#ff3b30,#ff7a5c)' : '';

    // weapon
    const w = p.weapon;
    if (this._wid !== w.id || this._ammo !== w.ammo || this._reloading !== (w.reloading > 0)) {
      this._wid = w.id; this._ammo = w.ammo; this._reloading = w.reloading > 0;
      el.weaponName.textContent = w.def.name.toUpperCase();
      el.ammoMag.textContent = w.def.magSize === Infinity ? '∞' : w.ammo;
      el.ammoRes.textContent = w.def.magSize === Infinity ? '' : '∞';
      const slots = el.slots.children;
      for (let i = 0; i < slots.length; i++) slots[i].classList.toggle('active', i === p.weaponIndex);
    }
    if (w.reloading > 0) {
      el.ammoMag.textContent = '⟳';
    }

    // xp
    el.xp.style.width = ((p.xp / p.xpNext) * 100).toFixed(1) + '%';
    el.xpLevel.textContent = 'LVL ' + p.level + (p.skillPoints > 0 ? `  •  ${p.skillPoints} SP` : '');

    // crosshair spread
    const base = 6 + p.weapon.def.spread * 2.4 + (p.ads > 0.5 ? -4 : 0) + p.speed * 0.7 + w.heat * 1.5;
    this.crossSpread = lerp(this.crossSpread, base, clamp(dt * 10, 0, 1));
    el.crosshair.style.setProperty('--spread', this.crossSpread.toFixed(1) + 'px');
    el.crosshair.classList.toggle('hidden', p.ads > 0.85 && p.weapon.def.zoom > 3);

    // hitmarker
    if (this.hitTime > 0) {
      this.hitTime -= dt;
      if (this.hitTime <= 0) el.hitmarker.classList.remove('on');
    }

    // squad
    this.updateSquad();
    // quest tracker
    this.updateQuests();
    // timers
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i]; n.t -= dt;
      if (n.t < 1) n.el.style.opacity = n.t.toFixed(2);
      if (n.t <= 0) { n.el.remove(); this.notes.splice(i, 1); }
    }
    for (let i = this.feedItems.length - 1; i >= 0; i--) {
      const n = this.feedItems[i]; n.t -= dt;
      if (n.t < 1) n.el.style.opacity = n.t.toFixed(2);
      if (n.t <= 0) { n.el.remove(); this.feedItems.splice(i, 1); }
    }
    for (let i = this.subs.length - 1; i >= 0; i--) {
      const n = this.subs[i]; n.t -= dt;
      if (n.t < 1) n.el.style.opacity = n.t.toFixed(2);
      if (n.t <= 0) { n.el.remove(); this.subs.splice(i, 1); }
    }

    // threat
    const near = g.enemies.active.filter((e) => e.state !== 'dead' && Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z) < 70).length;
    el.threat.textContent = near > 0 ? `${near} HOSTILE${near > 1 ? 'S' : ''} NEARBY` : '';
    el.threat.parentElement.style.opacity = near > 0 ? 1 : 0;

    this.drawMinimap();
    this.drawCompass();

    // fps every 0.5s
    this.fpsT = (this.fpsT || 0) - dt;
    if (this.fpsT <= 0) {
      this.fpsT = 0.5;
      el.fps.textContent = `${g.engine.fps | 0} fps · ${g.enemies.active.length} husks`;
    }
  }

  updateSquad() {
    const g = this.game;
    const html = g.squad.members.map((m) => {
      const pct = Math.round((m.health / m.maxHealth) * 100);
      const cls = m.down ? 'down' : pct < 35 ? 'hurt' : '';
      return `<div class="sq ${cls}">
        <div class="sq-name">${m.def.name.split(' ')[0]} <i>${m.def.role.slice(0, 4)}</i></div>
        <div class="sq-bar"><div style="width:${m.down ? 0 : pct}%"></div></div>
        <div class="sq-lvl">${m.level}</div>
      </div>`;
    }).join('');
    if (html !== this._sqHtml) { this.el.squad.innerHTML = html; this._sqHtml = html; }
  }

  updateQuests() {
    const q = this.game.quests;
    if (!q) return;
    const html = q.active.slice(0, 4).map((quest) => {
      const o = quest.objectives[quest.index];
      if (!o) return '';
      return `<div class="q"><b>${quest.title}</b><span>${o.text} ${o.count ? `(${o.progress || 0}/${o.count})` : ''}</span></div>`;
    }).join('');
    if (html !== this._qHtml) { this.el.quest.innerHTML = html; this._qHtml = html; }
  }

  drawCompass() {
    const p = this.game.player;
    // heading strip: reuse the minimap base, scrolled horizontally
    const yaw = p.yaw;
    const deg = ((-yaw * 180) / Math.PI + 360) % 360;
    const strip = this.el.compass;
    if (!this._compassBuilt) {
      this._compassBuilt = true;
      let marks = '';
      const dirs = [['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SW', 225], ['W', 270], ['NW', 315]];
      for (const [label, a] of dirs) marks += `<i style="left:${a * 4}px">${label}</i>`;
      strip.innerHTML = `<div class="cstrip">${marks}${marks}${marks}</div>`;
      this._cstrip = strip.firstElementChild;
    }
    const w = 1440; // 360deg * 4px
    let x = -((deg * 4) % w);
    if (x > 0) x -= w;
    this._cstrip.style.transform = `translateX(${x}px)`;
  }

  drawMinimap() {
    const g = this.game;
    const p = g.player;
    const ctx = this.mm;
    const S = this.el.minimap.width;
    const scale = 2.6; // base pixels per minimap pixel
    const rangePx = S / 2;
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(S / 2, S / 2);
    ctx.rotate(-p.yaw);
    const bx = ((p.pos.x + WORLD.HALF) / WORLD.SIZE) * this.base.width;
    const by = ((p.pos.z + WORLD.HALF) / WORLD.SIZE) * this.base.height;
    const src = rangePx / scale;
    // note: canvas Y is flipped (world +Z points "down" when viewed from above)
    ctx.drawImage(this.base, bx - src, by - src, src * 2, src * 2, -rangePx, rangePx, rangePx * 2, -rangePx * 2);

    const toMap = (x, z) => [(x - p.pos.x) * scale, -(z - p.pos.z) * scale];
    // POIs
    ctx.font = '9px Arial';
    ctx.textAlign = 'center';
    for (const poi of g.world.pois) {
      const [mx, my] = toMap(poi.x, poi.z);
      if (Math.hypot(mx, my) > S / 2 - 6) continue;
      ctx.fillStyle = poi.discovered ? '#ffd479' : '#8f9aa8';
      ctx.beginPath();
      ctx.arc(mx, my, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
    // enemies
    for (const e of g.enemies.active) {
      if (e.state === 'dead') continue;
      const [mx, my] = toMap(e.pos.x, e.pos.z);
      if (Math.hypot(mx, my) > S / 2 - 4) continue;
      ctx.fillStyle = e.def.boss ? '#ff5a3c' : e.alert > 0 ? '#ff6b6b' : '#c96bff';
      ctx.beginPath();
      ctx.arc(mx, my, e.def.boss ? 4.5 : 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    // squad
    for (const m of g.squad.members) {
      const [mx, my] = toMap(m.pos.x, m.pos.z);
      ctx.fillStyle = m.down ? '#ff4d4d' : '#6ef2c0';
      ctx.beginPath();
      ctx.arc(mx, my, 2.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    // player arrow
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(S / 2, S / 2 - 7);
    ctx.lineTo(S / 2 - 5, S / 2 + 5);
    ctx.lineTo(S / 2 + 5, S / 2 + 5);
    ctx.closePath();
    ctx.fill();
    // ring
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2);
    ctx.stroke();
  }
}
