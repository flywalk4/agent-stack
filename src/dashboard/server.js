import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect } from '../status.js';
import { probeChain } from '../doctor.js';
import { SERVICES } from '../topology.js';

const page = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');

export function serve(port = SERVICES.dashboard.port) {
  const server = http.createServer(async (req, res) => {
    const send = (code, type, body) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    try {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/api/ping') return send(200, 'application/json', '{"ok":true}');
      if (u.pathname === '/api/status') return send(200, 'application/json', JSON.stringify(await collect()));
      if (u.pathname === '/api/probe') {
        const id = u.searchParams.get('agent');
        return send(200, 'application/json', JSON.stringify(await probeChain(id)));
      }
      if (u.pathname === '/') return send(200, 'text/html; charset=utf-8', fs.readFileSync(page));
      send(404, 'text/plain', 'not found');
    } catch (e) {
      send(500, 'application/json', JSON.stringify({ error: e.message }));
    }
  });
  server.listen(port, '127.0.0.1', () => console.log(`agent-stack dashboard: http://127.0.0.1:${port}`));
}
