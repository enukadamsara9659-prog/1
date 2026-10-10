// Save / load the run to localStorage.
const KEY = 'aetherfall.save.v2';

export function hasSave() {
  try { return !!localStorage.getItem(KEY); } catch (e) { return false; }
}

export function saveGame(game) {
  const p = game.player;
  if (!p) return false;
  const data = {
    v: 2,
    time: Date.now(),
    player: {
      x: p.pos.x, y: p.pos.y, z: p.pos.z, yaw: p.yaw,
      level: p.level, xp: p.xp, xpNext: p.xpNext, skillPoints: p.skillPoints, skills: p.skills,
      shards: p.shards, aether: p.aether, kills: p.kills, headshots: p.headshots,
      weaponIndex: p.weaponIndex,
      weapons: p.weapons.map((w) => ({ id: w.id, level: w.level, xp: w.xp, kills: w.kills })),
    },
    squad: game.squad ? game.squad.members.map((m) => ({ id: m.def.id, level: m.level, xp: m.xp, affinity: m.affinity })) : [],
    quests: game.quests?.save() || null,
    world: game.worldObjects?.save() || null,
    enemiesKilled: game.enemies?.killCount || 0,
    pois: game.world.pois.map((poi) => (poi.discovered ? 1 : 0)),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch (e) {
    console.warn('save failed', e);
    return false;
  }
}

export function loadGame(game) {
  let data;
  try { data = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return false; }
  if (!data) return false;
  const p = game.player;
  if (p && data.player) {
    const s = data.player;
    p.pos.set(s.x, s.y, s.z);
    p.yaw = s.yaw || 0;
    p.level = s.level || 1;
    p.xp = s.xp || 0;
    p.xpNext = s.xpNext || 250;
    p.skillPoints = s.skillPoints || 0;
    p.skills = s.skills || {};
    p.shards = s.shards || 0;
    p.aether = s.aether || 0;
    p.kills = s.kills || 0;
    p.headshots = s.headshots || 0;
    p.health = p.maxHealth;
    p.shield = p.maxShield;
    if (typeof s.weaponIndex === 'number') { p.equip(s.weaponIndex); p.showCurrentWeapon(); }
    for (const w of s.weapons || []) {
      const target = p.weapons.find((x) => x.id === w.id);
      if (target) { target.level = w.level || 1; target.xp = w.xp || 0; target.kills = w.kills || 0; }
    }
  }
  if (game.squad && data.squad) {
    for (const s of data.squad) {
      const m = game.squad.members.find((x) => x.def.id === s.id);
      if (m) { m.level = s.level || 1; m.xp = s.xp || 0; m.affinity = s.affinity || 0; m.maxHealth = 160 + (m.level - 1) * 18; m.health = m.maxHealth; }
    }
  }
  if (game.quests && data.quests) game.quests.load(data.quests);
  if (game.worldObjects && data.world) game.worldObjects.load(data.world);
  if (game.enemies && data.enemiesKilled) game.enemies.killCount = data.enemiesKilled;
  if (data.pois) data.pois.forEach((v, i) => { if (game.world.pois[i]) game.world.pois[i].discovered = !!v; });
  return true;
}

export function clearSave() {
  try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
}
