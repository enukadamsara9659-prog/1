// On-screen diagnostics panel (toggle with the ` key, or F9).
// Shows renderer stats, world state and every runtime error caught since boot —
// handy for reporting problems from a machine we cannot see.

const lines = [];
export const errors = [];

export function captureError(msg) {
  errors.push(String(msg));
  if (errors.length > 40) errors.shift();
}

export function installErrorCapture() {
  window.addEventListener('error', (e) => captureError('ERROR: ' + (e.message || e) + '\n' + (e.error?.stack || '')));
  window.addEventListener('unhandledrejection', (e) => captureError('PROMISE: ' + (e.reason?.stack || e.reason)));
  const warn = console.warn.bind(console);
  console.warn = (...a) => { captureError('WARN: ' + a.map(String).join(' ').slice(0, 300)); warn(...a); };
}

export function attachDebug(game) {
  const panel = document.createElement('pre');
  panel.id = 'dbg';
  panel.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:9998;max-width:min(560px,70vw);max-height:52vh;'
    + 'overflow:auto;margin:0;padding:10px 12px;background:rgba(6,10,16,.86);border:1px solid rgba(120,200,255,.35);'
    + 'color:#bfe6ff;font:11px/1.45 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;border-radius:5px;display:none';
  document.body.appendChild(panel);

  let open = false;
  const toggle = () => { open = !open; panel.style.display = open ? 'block' : 'none'; };
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Backquote' || e.code === 'F9') { e.preventDefault(); toggle(); }
  });

  let acc = 0, frames = 0, fps = 0;
  const f = (n, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : '—');

  return function update(dt) {
    acc += dt; frames++;
    if (acc >= 0.5) { fps = frames / acc; acc = 0; frames = 0; }
    if (!open) return;
    lines.length = 0;
    const g = game, e = g.engine, r = e && e.renderer;
    const info = r && r.info;
    const p = g.player;
    lines.push(`AETHERFALL debug  ( \` or F9 to close )`);
    lines.push(`fps ${f(fps, 1)}   state ${g.state}${g.paused ? ' (paused)' : ''}   time ${f(g.time, 1)}s`);
    if (info) {
      lines.push(`draws ${info.render.calls}  tris ${(info.render.triangles / 1000).toFixed(1)}k  `
        + `progs ${info.programs ? info.programs.length : '—'}  geo ${info.memory.geometries}  tex ${info.memory.textures}`);
    }
    if (p) {
      lines.push(`player  hp ${f(p.health, 0)}/${p.maxHealth}  shield ${f(p.shield, 0)}  lvl ${p.level ?? g.progression?.level ?? '—'}`);
      lines.push(`pos ${p.pos.x.toFixed(0)}, ${p.pos.y.toFixed(1)}, ${p.pos.z.toFixed(0)}  `
        + `vel ${f(Math.hypot(p.vel.x, p.vel.z), 1)} m/s  grounded ${p.grounded}`);
      lines.push(`weapon ${p.weapon ? p.weapon.id : '—'}  ammo ${p.weapon ? p.weapon.ammo : '—'}  `
        + `kills ${p.kills ?? 0}`);
    }
    if (g.enemies) lines.push(`enemies active ${g.enemies.active.length} / pooled ${g.enemies.pool ? g.enemies.pool.length : '—'}  killed ${g.enemies.killed ?? 0}`);
    if (g.squad) lines.push(`squad ${g.squad.members.map((m) => `${m.def.name.split(' ')[0]}:${Math.round(m.health)}`).join('  ')}`);
    if (g.worldobjects) lines.push(`nests ${g.worldobjects.nests.filter((n) => !n.destroyed).length}/${g.worldobjects.nests.length}  `
      + `beacons ${g.worldobjects.beacons.length}  drops ${g.worldobjects.drops ? g.worldobjects.drops.length : 0}`);
    if (g.quests) lines.push(`quests ${g.quests.active.map((q) => `${q.id}:${q.stage}`).join(', ') || '—'}`);
    if (g.vegetation) lines.push(`veg sectors ${g.vegetation.meshes.length}  under ${g.vegetation.under.length}  trunks ${g.vegetation.trunks ? g.vegetation.trunks.map.size : 0}`);
    if (g.structures) lines.push(`structures ${g.structures.groups ? g.structures.groups.size : (g.structures.colliders ? g.structures.colliders.length : '—')} colliders`);
    const cam = e && e.camera;
    if (cam) lines.push(`cam ${cam.position.x.toFixed(0)},${cam.position.y.toFixed(0)},${cam.position.z.toFixed(0)}  fov ${cam.fov}`);
    if (errors.length) {
      lines.push(`--- last ${Math.min(6, errors.length)} of ${errors.length} messages ---`);
      for (const m of errors.slice(-6)) lines.push(m.slice(0, 400));
    }
    panel.textContent = lines.join('\n');
  };
}
