// Skill tree + derived stat calculation.
export const SKILL_TREES = [
  {
    id: 'combat', name: 'COMBAT', color: '#ff7a5c',
    skills: [
      { id: 'damage', name: 'Shard Rounds', max: 5, desc: '+6% weapon damage per rank' },
      { id: 'headshot', name: 'Precision', max: 3, desc: '+25% headshot damage per rank' },
      { id: 'reload', name: 'Fast Hands', max: 3, desc: '-12% reload time per rank' },
      { id: 'crit', name: 'Weak Point', max: 4, desc: '+4% chance to deal double damage per rank' },
    ],
  },
  {
    id: 'vitality', name: 'VITALITY', color: '#6ef2c0',
    skills: [
      { id: 'health', name: 'Iron Hide', max: 5, desc: '+18 max health per rank' },
      { id: 'shield', name: 'Aegis', max: 4, desc: '+25% shield regeneration per rank' },
      { id: 'armor', name: 'Carapace', max: 3, desc: '-6% damage taken per rank' },
      { id: 'regen', name: 'Second Wind', max: 3, desc: 'Slowly regenerate health out of combat' },
    ],
  },
  {
    id: 'mobility', name: 'MOBILITY', color: '#7fc8ff',
    skills: [
      { id: 'speed', name: 'Fleet Foot', max: 4, desc: '+4% movement speed per rank' },
      { id: 'stamina', name: 'Endurance', max: 3, desc: '+20 max stamina, faster recovery' },
      { id: 'dodge', name: 'Blur Step', max: 3, desc: 'Dodge further and recover faster' },
      { id: 'fall', name: 'Soft Landing', max: 2, desc: '-40% fall damage per rank' },
    ],
  },
  {
    id: 'aether', name: 'AETHER', color: '#c58bff',
    skills: [
      { id: 'pulse', name: 'Resonance', max: 4, desc: '+18% pulse radius and damage per rank' },
      { id: 'grenade', name: 'Ordnance', max: 3, desc: '+1 shard grenade per rank' },
      { id: 'melee', name: 'Edge Mastery', max: 3, desc: '+20% aether blade damage per rank' },
      { id: 'aetherGain', name: 'Attunement', max: 3, desc: '+25% aether and shard gain per rank' },
    ],
  },
  {
    id: 'squad', name: 'SQUAD', color: '#ffd479',
    skills: [
      { id: 'squadDmg', name: 'Fire Team', max: 4, desc: '+12% companion damage per rank' },
      { id: 'squadHp', name: 'Field Armour', max: 3, desc: '+25 companion health per rank' },
      { id: 'revive', name: 'Medic', max: 3, desc: '+60% revive speed per rank' },
      { id: 'command', name: 'Coordination', max: 2, desc: 'Companions gain a 4th ability charge' },
    ],
  },
];

export const ALL_SKILLS = SKILL_TREES.flatMap((t) => t.skills.map((s) => ({ ...s, tree: t.id, color: t.color })));

export function applySkills(player) {
  const s = player.skills;
  const bonus = {
    damage: (s.damage || 0) * 0.06,
    headshot: (s.headshot || 0) * 0.25,
    reload: 1 - (s.reload || 0) * 0.12,
    crit: (s.crit || 0) * 0.04,
    maxHealth: 100 + (s.health || 0) * 18,
    shieldRegen: 1 + (s.shield || 0) * 0.25,
    armor: 1 - (s.armor || 0) * 0.06,
    regen: (s.regen || 0) * 1.6,
    speed: (s.speed || 0) * 0.04,
    maxStamina: 100 + (s.stamina || 0) * 20,
    dodge: (s.dodge || 0),
    fall: 1 - (s.fall || 0) * 0.4,
    pulse: (s.pulse || 0) * 0.18,
    grenades: 3 + (s.grenade || 0),
    melee: 1 + (s.melee || 0) * 0.2,
    gain: 1 + (s.aetherGain || 0) * 0.25,
    squadDmg: 1 + (s.squadDmg || 0) * 0.12,
    squadHp: (s.squadHp || 0) * 25,
    revive: 1 + (s.revive || 0) * 0.6,
  };
  player.derived = bonus;
  player.maxHealth = bonus.maxHealth + (player.level - 1) * 6;
  player.maxStamina = bonus.maxStamina;
  player.grenadeMax = bonus.grenades;
  if (player.squad) {
    for (const m of player.squad.members) {
      const base = 160 + (m.level - 1) * 18;
      const wasRatio = m.maxHealth > 0 ? m.health / m.maxHealth : 1;
      m.maxHealth = base + bonus.squadHp;
      m.health = Math.min(m.maxHealth, m.maxHealth * wasRatio + 0.001);
      m.damageMult = bonus.squadDmg;
    }
  }
  return bonus;
}

export function spendPoint(player, skillId) {
  const def = ALL_SKILLS.find((s) => s.id === skillId);
  if (!def) return false;
  const cur = player.skills[skillId] || 0;
  if (cur >= def.max) return false;
  if (player.skillPoints <= 0) return false;
  player.skills[skillId] = cur + 1;
  player.skillPoints--;
  applySkills(player);
  return true;
}

export function respec(player) {
  let back = 0;
  for (const k of Object.keys(player.skills)) { back += player.skills[k]; delete player.skills[k]; }
  player.skillPoints += back;
  applySkills(player);
  return back;
}
