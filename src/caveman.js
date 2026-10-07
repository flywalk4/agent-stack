import fs from 'node:fs';
import path from 'node:path';
import { home, isWin, run, out } from './platform.js';
import { backupOnce, writeAtomic } from './backup.js';

const REPO = 'JuliusBrussee/caveman';
const RULE_URL = `https://raw.githubusercontent.com/${REPO}/main/src/rules/caveman-activate.md`;
const BEGIN = '<!-- caveman-begin (agent-stack) -->';
const END = '<!-- caveman-end (agent-stack) -->';

const must = (r, what) => {
  if (r.status !== 0) throw new Error(`${what}: ${(r.stderr || r.stdout || '').trim().slice(-400)}`);
  return r;
};

// Same lookup order as caveman's own hooks (src/hooks/caveman-config.js).
function userConfigFile() {
  const dir = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, 'caveman')
    : isWin
      ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'caveman')
      : path.join(home, '.config', 'caveman');
  return path.join(dir, 'config.json');
}

// Hook-driven agents (Claude, OpenCode plugin) read defaultMode on every new
// session; anything but "off" keeps caveman always on.
export function ensureDefaultOn() {
  const f = userConfigFile();
  const c = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  if (c.defaultMode && c.defaultMode !== 'off') return;
  backupOnce(f);
  writeAtomic(f, `${JSON.stringify({ ...c, defaultMode: 'full' }, null, 2)}\n`);
}

// npm 12 refuses git-hosted packages unless explicitly allowed.
const npxGit = () => {
  const major = Number(out('npm', ['--version'])?.split('.')[0] ?? 0);
  return major >= 12 ? ['--allow-git=root', '-y'] : ['-y'];
};

// Codex has no session hook for caveman, only skills (manual /caveman), so
// the always-on rule goes into the global ~/.codex/AGENTS.md it always loads.
async function codexAlwaysOn() {
  const rule = (await (await fetch(RULE_URL)).text()).trim();
  const f = path.join(home, '.codex', 'AGENTS.md');
  backupOnce(f);
  const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  const re = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripped = text.replace(new RegExp(`\\n*${re(BEGIN)}[\\s\\S]*?${re(END)}\\n?`, 'g'), '').replace(/\n*$/, '');
  writeAtomic(f, `${stripped ? `${stripped}\n\n` : ''}${BEGIN}\n${rule}\n${END}\n`);
}

// Only the rule/hook layer: caveman's own `caveman <agent>` launcher and
// proxy would add a fourth network hop in front of bili.
export const CAVEMAN = {
  claude() {
    ensureDefaultOn();
    run('claude', ['plugin', 'marketplace', 'add', REPO]);
    return must(run('claude', ['plugin', 'install', 'caveman@caveman']), 'claude plugin install caveman');
  },
  async codex() {
    ensureDefaultOn();
    must(run('npx', [...npxGit(), 'skills', 'add', REPO, '--skill', '*', '-a', 'codex', '--yes', '-g']), 'skills add caveman codex');
    await codexAlwaysOn();
  },
  // Native opencode plugin auto-activates and adds the AGENTS.md ruleset.
  opencode() {
    ensureDefaultOn();
    return must(run('npx', [...npxGit(), `github:${REPO}`, '--', '--only', 'opencode', '--non-interactive']), 'caveman install opencode');
  },
};
