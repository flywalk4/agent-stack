import fs from 'node:fs';
import path from 'node:path';
import { home, isWin, which, run, out } from '../platform.js';
import { CHAINS, PORTS, url } from '../topology.js';
import { backupOnce, restore, writeAtomic } from '../backup.js';
import { parseJsonc } from '../jsonc.js';

const dir = isWin && process.env.APPDATA && !fs.existsSync(path.join(home, '.config', 'opencode'))
  ? path.join(process.env.APPDATA, 'opencode')
  : path.join(home, '.config', 'opencode');

function configFile() {
  for (const f of ['opencode.jsonc', 'opencode.json']) {
    if (fs.existsSync(path.join(dir, f))) return path.join(dir, f);
  }
  return path.join(dir, 'opencode.json');
}

// headroom ships an opencode transport plugin that intercepts every outbound
// request (incl. the ChatGPT-OAuth plugin, which hardcodes chatgpt.com) and
// sends it to headroom with the original origin in x-headroom-base-url.
function headroomTransportPlugin() {
  const tools = out('uv', ['tool', 'dir']);
  if (!tools) return null;
  const sp = path.join(tools, 'headroom-ai', 'lib');
  const py = fs.existsSync(sp) ? fs.readdirSync(sp).find((d) => d.startsWith('python')) : null;
  const candidates = [
    py && path.join(sp, py, 'site-packages', 'headroom', 'providers', 'opencode', '_dist', 'entry.opencode.js'),
    path.join(tools, 'headroom-ai', 'Lib', 'site-packages', 'headroom', 'providers', 'opencode', '_dist', 'entry.opencode.js'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

const isHeadroomPlugin = (p) => typeof p === 'string' && p.endsWith('entry.opencode.js');

export default {
  id: 'opencode',
  label: CHAINS.opencode.label,
  detect: () => Boolean(which('opencode')) || fs.existsSync(dir),

  current() {
    const f = configFile();
    if (!fs.existsSync(f)) return null;
    const c = parseJsonc(fs.readFileSync(f, 'utf8'));
    return (c.plugin ?? []).find(isHeadroomPlugin) ? url(PORTS.headroom) : null;
  },

  apply() {
    const f = configFile();
    backupOnce(f);
    // bili runs in-process here (like dsh); its installer edits the config
    // and turns off opencode's own auto-compaction.
    const r = run('bili', ['plugin', 'install', 'opencode']);
    if (r.status !== 0) throw new Error(`bili plugin install opencode: ${r.stderr || r.stdout}`);

    const plugin = headroomTransportPlugin();
    if (!plugin) throw new Error('headroom opencode transport plugin not found (is headroom-ai installed via uv?)');
    const c = fs.existsSync(f) ? parseJsonc(fs.readFileSync(f, 'utf8')) : {};
    c.plugin = [...(c.plugin ?? []).filter((p) => !isHeadroomPlugin(p)), plugin];
    writeAtomic(f, `${JSON.stringify(c, null, 2)}\n`);
  },

  revert() {
    run('bili', ['plugin', 'remove', 'opencode']);
    return restore(configFile());
  },
  ok() {
    return this.current() !== null;
  },
};
