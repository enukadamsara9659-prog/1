// Dev telemetry: ships runtime errors and a periodic stats snapshot to the
// vite dev server (/__report) so problems can be diagnosed without devtools.

const errors = [];
let sent = 0;
let queue = [];

export function pushError(msg) {
  const s = String(msg);
  if (errors.length < 60) errors.push(s);
  if (sent < 25) { sent++; void post({ kind: 'error', msg: s }); }
}

export function pushWarn(msg) {
  if (sent < 25) { sent++; void post({ kind: 'warn', msg: String(msg).slice(0, 400) }); }
}

async function post(payload) {
  try {
    await fetch('/__report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    });
  } catch { /* offline — ignore */ }
}

/** one-off snapshot (used at loading milestones) */
export function reportNow(tag) {
  post({ kind: 'stats', state: tag || 'snapshot', gpu, screen: `${window.innerWidth}x${window.innerHeight}`, errs: errors.length, errors: errors.slice(-3) });
}

export function installReporter() {
  window.addEventListener('error', (e) => pushError('ERROR: ' + (e.message || e) + '\n' + (e.error?.stack || '')));
  window.addEventListener('unhandledrejection', (e) => pushError('PROMISE: ' + (e.reason?.stack || e.reason)));
  const warn = console.warn.bind(console);
  console.warn = (...a) => { pushWarn(a.map(String).join(' ')); warn(...a); };
  const err = console.error.bind(console);
  console.error = (...a) => { pushError('console.error: ' + a.map(String).join(' ')); err(...a); };
}

let fps = 0, acc = 0, frames = 0;
let gpu = 'unknown';

export function initReporter(game) {
  installReporter();
  try {
    const gl = game.engine.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) gpu = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    else gpu = gl.getParameter(gl.RENDERER);
  } catch { /* ignore */ }

  const beat = () => {
    const e = game.engine, r = e && e.renderer, p = game.player;
    const info = r && r.info;
    post({
      kind: 'stats',
      state: game.state + (game.paused ? '/paused' : ''),
      fps: fps ? fps.toFixed(1) : '—',
      draws: info ? info.render.calls : '—',
      tris: info ? Math.round(info.render.triangles / 1000) + 'k' : '—',
      pos: p ? `${p.pos.x.toFixed(0)},${p.pos.y.toFixed(0)},${p.pos.z.toFixed(0)}` : '—',
      hp: p ? Math.round(p.health) : '—',
      enemies: game.enemies ? game.enemies.active.length : '—',
      nests: game.worldobjects ? game.worldobjects.nests.filter((n) => !n.destroyed).length : '—',
      gpu, screen: `${window.innerWidth}x${window.innerHeight}`,
      quality: game.settings ? game.settings.preset || (game.settings.data && game.settings.data.preset) : '—',
      errs: errors.length,
      errors: errors.slice(-4),
    });
  };
  post({ kind: 'stats', state: 'boot-started', gpu, screen: `${window.innerWidth}x${window.innerHeight}`, errs: 0 });
  setTimeout(beat, 3000);
  setInterval(beat, 12000);
  window.addEventListener('beforeunload', () => { void post({ kind: 'warn', msg: 'page unloading' }); });

  return function reportFrame(dt) {
    acc += dt; frames++;
    if (acc >= 1) { fps = frames / acc; acc = 0; frames = 0; }
  };
}
