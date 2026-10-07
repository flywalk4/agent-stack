import fs from 'node:fs';
import { CONFIG_PATHS, which, run } from '../platform.js';
import { CHAINS, PORTS } from '../topology.js';
import { backupOnce, restore, writeAtomic } from '../backup.js';

const file = CONFIG_PATHS.codexConfig;
const BLOCK = /(\[model_providers\.headroom\][^[]*)/;

function readBlock() {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').match(BLOCK)?.[1] ?? null;
}

export default {
  id: 'codex',
  label: CHAINS.codex.label,
  detect: () => Boolean(which('codex')) || fs.existsSync(file),

  current() {
    return readBlock()?.match(/^base_url\s*=\s*"([^"]*)"/m)?.[1] ?? null;
  },

  apply() {
    backupOnce(file);
    // headroom's own init knows codex auth modes (ChatGPT OAuth needs
    // requires_openai_auth), hooks and the retrieve MCP — reuse it, then
    // re-point the provider through bili.
    if (!readBlock()) {
      const r = run('headroom', ['init', '-g', '--port', String(PORTS.headroom), 'codex']);
      if (r.status !== 0) throw new Error(`headroom init codex: ${r.stderr || r.stdout}`);
    }
    let text = fs.readFileSync(file, 'utf8');
    text = text.replace(BLOCK, (block) => block
      .replace(/^base_url\s*=.*$/m, `base_url = "${CHAINS.codex.baseUrl}"`)
      .replace(/^supports_websockets\s*=.*$/m, `supports_websockets = ${CHAINS.codex.websockets}`));
    writeAtomic(file, text);
  },

  revert: () => restore(file),
  ok() {
    const b = readBlock();
    return Boolean(b) && this.current() === CHAINS.codex.baseUrl && /supports_websockets\s*=\s*false/.test(b);
  },
};
