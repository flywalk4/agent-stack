import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isMac, isWin, home, which, run, out } from './platform.js';

const must = (r, what) => {
  if (r.status !== 0) throw new Error(`${what}: ${(r.stderr || r.stdout || '').trim().slice(-400)}`);
  return r;
};

// Pull the right asset from rtk's latest GitHub release (Windows has no brew).
async function installRtkFromRelease() {
  const rel = await (await fetch('https://api.github.com/repos/rtk-ai/rtk/releases/latest')).json();
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const asset = rel.assets?.find((a) => a.name.includes(arch) && /windows/i.test(a.name) && a.name.endsWith('.zip'));
  if (!asset) throw new Error(`no rtk windows ${arch} asset in ${rel.tag_name}`);
  const binDir = path.join(home, '.agent-stack', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const zip = path.join(os.tmpdir(), asset.name);
  fs.writeFileSync(zip, Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer()));
  must(run('powershell.exe', ['-NoProfile', '-Command',
    `Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${binDir}'; ` +
    `$p=[Environment]::GetEnvironmentVariable('Path','User'); if ($p -notlike '*${binDir}*') { [Environment]::SetEnvironmentVariable('Path', "$p;${binDir}", 'User') }`,
  ], { shell: false }), 'rtk unzip');
  process.env.PATH = `${process.env.PATH};${binDir}`;
}

export const TOOLS = {
  bili: {
    label: 'bili (billion-context)',
    version: () => out('bili', ['--version']),
    install: () => must(run('npm', ['install', '-g', 'billion-context']), 'npm i -g billion-context'),
  },
  headroom: {
    label: 'headroom',
    version: () => out('headroom', ['--version']),
    install: () => must(run('uv', ['tool', 'install', '--upgrade', 'headroom-ai']), 'uv tool install headroom-ai'),
  },
  rtk: {
    label: 'rtk',
    version: () => out('rtk', ['--version']),
    install: async () => {
      if (isMac && which('brew')) return must(run('brew', ['install', 'rtk']), 'brew install rtk');
      if (isWin) return installRtkFromRelease();
      return must(run('cargo', ['install', '--git', 'https://github.com/rtk-ai/rtk']), 'cargo install rtk');
    },
  },
};

export const isInstalled = (id) => Boolean(which(id === 'bili' ? 'bili' : id));

// Agent-side add-ons. rtk/caveman live inside the agent (hooks, rules,
// skills), not in the network chain — so no ordering issues with bili/headroom.
export const ADDONS = {
  rtk: {
    claude: () => must(run('rtk', ['init', '-g', '--auto-patch']), 'rtk init claude'),
    codex: () => must(run('rtk', ['init', '-g', '--codex', '--auto-patch']), 'rtk init codex'),
    opencode: () => must(run('rtk', ['init', '-g', '--opencode', '--auto-patch']), 'rtk init opencode'),
  },
  // Only the rule/skill layer: caveman's own `caveman <agent>` launcher and
  // proxy would add a fourth network hop in front of bili.
  caveman: {
    claude: () => {
      run('claude', ['plugin', 'marketplace', 'add', 'JuliusBrussee/caveman']);
      return must(run('claude', ['plugin', 'install', 'caveman@caveman']), 'claude plugin install caveman');
    },
    codex: () => must(run('npx', ['-y', 'skills', 'add', 'JuliusBrussee/caveman', '--skill', '*', '-a', 'codex', '--yes', '-g']), 'skills add caveman codex'),
    opencode: () => must(run('npx', ['-y', 'skills', 'add', 'JuliusBrussee/caveman', '--skill', '*', '-a', 'opencode', '--yes', '-g']), 'skills add caveman opencode'),
  },
};
