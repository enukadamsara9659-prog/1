// Quest / objective engine plus the main story of Aetherfall.
import { clamp } from '../core/rng.js';

let UID = 1;

export const QUEST_DEFS = [
  {
    id: 'prologue', title: 'Fire in the Sky', main: true, auto: true,
    desc: 'A burning shard tore open the dawn and fell beyond the eastern ridge. Find where it landed.',
    objectives: [
      { type: 'goto', text: 'Reach the crash site', target: 'crash', radius: 90 },
    ],
    rewards: { xp: 120, shards: 20 },
    next: ['ashfall'],
  },
  {
    id: 'ashfall', title: 'Ashfall', main: true,
    desc: 'The crater is crawling with husks. Clear it and recover a shard core for the camp.',
    objectives: [
      { type: 'kill', text: 'Clear the crater husks', kind: 'any', count: 14 },
      { type: 'collect', text: 'Recover shard cores', kind: 'core', count: 2 },
    ],
    rewards: { xp: 420, shards: 60, aether: 1 },
    next: ['whispers'],
  },
  {
    id: 'whispers', title: 'The Whispering Shards', main: true,
    desc: 'Nests are broadcasting a signal from beneath the soil. Silence three of them.',
    objectives: [
      { type: 'destroy', text: 'Destroy shard nests', count: 3 },
    ],
    rewards: { xp: 900, shards: 140, aether: 2 },
    next: ['codex'],
  },
  {
    id: 'codex', title: 'The Aether Codex', main: true,
    desc: 'The old temple on the ridge holds records of the last falling. Recover the codex.',
    objectives: [
      { type: 'goto', text: 'Find the temple', target: 'poi:temple', radius: 70 },
      { type: 'collect', text: 'Recover the Aether Codex', kind: 'codex', count: 1 },
    ],
    rewards: { xp: 1400, shards: 220, aether: 3 },
    next: ['titan'],
  },
  {
    id: 'titan', title: 'The Hollow Voice', main: true,
    desc: 'Something vast is waking in the crater. End it.',
    objectives: [
      { type: 'kill', text: 'Slay the Shard Titan', kind: 'titan', count: 1 },
    ],
    rewards: { xp: 5000, shards: 900, aether: 10 },
    next: [],
  },
  // -------------------------------------------------------------- side quests
  {
    id: 'caravan', title: 'The Lost Caravan', main: false,
    desc: 'A trade caravan never reached Ashfall. Search the road for survivors.',
    objectives: [
      { type: 'goto', text: 'Search the ambush site', target: 'poi:ruins', radius: 80 },
      { type: 'kill', text: 'Drive off the husks', kind: 'any', count: 10 },
    ],
    rewards: { xp: 500, shards: 80 },
    next: [],
  },
  {
    id: 'hunt', title: 'Warden of the Pines', main: false,
    desc: 'Something old stalks the deep forest. Track it and put it down.',
    objectives: [
      { type: 'kill', text: 'Kill Alpha husks', kind: 'brute', count: 5 },
    ],
    rewards: { xp: 800, shards: 120 },
    next: [],
  },
  {
    id: 'shards', title: 'Shard Harvest', main: false, repeatable: true,
    desc: 'Bring the camp 200 shard fragments. They will keep the lamps burning.',
    objectives: [
      { type: 'collect', text: 'Gather shards', kind: 'shard', count: 200 },
    ],
    rewards: { xp: 300, shards: 0 },
    next: [],
  },
];

export class Quests {
  constructor(game) {
    this.game = game;
    this.defs = QUEST_DEFS;
    this.active = [];
    this.done = new Set();
    this.counters = { core: 0, codex: 0, nest: 0 };
    this.start('prologue');
    this.hook();
  }

  hook() {
    const bus = this.game.events;
    bus.on('enemy:killed', ({ enemy }) => this.progress('kill', enemy.kind));
    bus.on('nest:destroyed', () => this.progress('destroy', 'nest'));
    bus.on('pickup', (kind) => this.progress('collect', kind));
  }

  start(id) {
    const def = this.defs.find((d) => d.id === id);
    if (!def || this.active.find((q) => q.id === id) || (this.done.has(id) && !def.repeatable)) return null;
    const q = {
      uid: UID++, id, title: def.title, desc: def.desc, main: def.main, repeatable: def.repeatable,
      objectives: def.objectives.map((o) => ({ ...o, progress: 0, done: false })),
      index: 0, def, complete: false,
    };
    this.active.unshift(q);
    this.game.events?.emit('quest:started', q);
    this.game.hud?.note('NEW OBJECTIVE — ' + q.title, 'quest');
    return q;
  }

  /** type: kill | collect | destroy ; key: kind */
  progress(type, key, amount = 1) {
    for (const q of this.active) {
      const o = q.objectives[q.index];
      if (!o || o.done || o.type !== type) continue;
      const matchKey = type === 'kill' ? (o.kind === 'any' || o.kind === key)
        : type === 'collect' ? o.kind === key
          : type === 'destroy' ? o.kind === 'nest' || key === 'nest' : false;
      if (!matchKey) continue;
      o.progress = Math.min(o.count, (o.progress || 0) + amount);
      this.game.events?.emit('quest:progress', { q, o });
      if (o.progress >= o.count) this.advance(q);
    }
  }

  advance(q) {
    const o = q.objectives[q.index];
    if (o) o.done = true;
    q.index++;
    if (q.index >= q.objectives.length) this.complete(q);
    else this.game.hud?.note('OBJECTIVE COMPLETE', 'good');
  }

  complete(q) {
    q.complete = true;
    this.done.add(q.id);
    const i = this.active.indexOf(q);
    if (i >= 0) this.active.splice(i, 1);
    const p = this.game.player;
    const r = q.def.rewards || {};
    if (p) {
      p.addXp(r.xp || 0);
      p.shards += Math.round((r.shards || 0) * (p.derived?.gain || 1));
      p.aether += r.aether || 0;
    }
    this.game.events?.emit('quest:complete', q);
    this.game.hud?.note('QUEST COMPLETE — ' + q.title, 'good');
    for (const n of q.def.next || []) this.start(n);
  }

  /** called every frame: handles goto objectives */
  update(dt) {
    const p = this.game.player;
    if (!p) return;
    for (const q of this.active) {
      const o = q.objectives[q.index];
      if (!o || o.done || o.type !== 'goto') continue;
      let tx = null, tz = null, radius = o.radius || 60;
      if (o.target === 'crash') { const c = this.game.world.crater; if (c) { tx = c.x; tz = c.z; } }
      else if (o.target && o.target.startsWith('poi:')) {
        const kind = o.target.slice(4);
        let best = null, bd = Infinity;
        for (const poi of this.game.world.pois) {
          if (poi.kind !== kind) continue;
          const d = Math.hypot(poi.x - p.pos.x, poi.z - p.pos.z);
          if (d < bd) { bd = d; best = poi; }
        }
        if (best) { tx = best.x; tz = best.z; radius = Math.max(radius, best.radius || 60); }
      }
      if (tx === null) continue;
      if (Math.hypot(tx - p.pos.x, tz - p.pos.z) < radius) {
        o.progress = o.count || 1;
        this.advance(q);
      }
    }
  }

  /** current waypoint for the HUD / world marker */
  waypoint() {
    const p = this.game.player;
    if (!p) return null;
    for (const q of this.active) {
      const o = q.objectives[q.index];
      if (!o) continue;
      if (o.type === 'goto') {
        if (o.target === 'crash') { const c = this.game.world.crater; if (c) return { x: c.x, z: c.z, label: q.title }; }
        if (o.target && o.target.startsWith('poi:')) {
          const kind = o.target.slice(4);
          let best = null, bd = Infinity;
          for (const poi of this.game.world.pois) {
            if (poi.kind !== kind) continue;
            const d = Math.hypot(poi.x - p.pos.x, poi.z - p.pos.z);
            if (d < bd) { bd = d; best = poi; }
          }
          if (best) return { x: best.x, z: best.z, label: best.name || q.title };
        }
      }
      if (o.type === 'destroy') {
        const n = this.game.worldObjects?.nearestNest(p.pos);
        if (n) return { x: n.x, z: n.z, label: 'Shard Nest' };
      }
    }
    return null;
  }

  save() {
    return {
      active: this.active.map((q) => ({ id: q.id, index: q.index, progress: q.objectives.map((o) => o.progress || 0) })),
      done: [...this.done],
    };
  }

  load(data) {
    if (!data) return;
    this.done = new Set(data.done || []);
    this.active = [];
    for (const s of data.active || []) {
      const q = this.start(s.id);
      if (!q) continue;
      q.index = s.index || 0;
      (s.progress || []).forEach((p, i) => { if (q.objectives[i]) q.objectives[i].progress = p; });
      for (let i = 0; i < q.index; i++) if (q.objectives[i]) q.objectives[i].done = true;
    }
  }
}
