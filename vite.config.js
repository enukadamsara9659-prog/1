import { defineConfig } from 'vite';

// Dev-only: the browser posts runtime errors / stats here so the agent can read
// them from the dev-server log (we cannot open the user's devtools).
function browserReport() {
  return {
    name: 'aetherfall-browser-report',
    configureServer(server) {
      server.middlewares.use('/__report', (req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 200000) req.destroy(); });
        req.on('end', () => {
          res.statusCode = 204;
          res.end();
          let msg;
          try { msg = JSON.parse(body); } catch { return; }
          const t = new Date().toISOString().slice(11, 19);
          if (msg.kind === 'error') {
            console.log(`\n[client ${t}] ERROR ${String(msg.msg).slice(0, 1200)}`);
          } else if (msg.kind === 'warn') {
            console.log(`[client ${t}] warn ${String(msg.msg).slice(0, 400)}`);
          } else {
            console.log(`[client ${t}] ${msg.state || '?'} fps=${msg.fps} draws=${msg.draws} `
              + `tris=${msg.tris} pos=${msg.pos} hp=${msg.hp} enemies=${msg.enemies} `
              + `nests=${msg.nests} gpu="${msg.gpu}" ${msg.screen} q=${msg.quality} errs=${msg.errs}`);
            if (msg.errors && msg.errors.length) {
              console.log('[client] recent errors:\n  ' + msg.errors.map((e) => String(e).replace(/\n/g, '\n  ').slice(0, 500)).join('\n  '));
            }
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [browserReport()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    allowedHosts: true,
    cors: true,
    hmr: { clientPort: 443, protocol: 'wss' },
  },
  preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
  build: { target: 'esnext', chunkSizeWarningLimit: 3000 },
  worker: { format: 'es' },
  resolve: { dedupe: ['three'] },
});
