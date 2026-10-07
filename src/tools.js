import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isMac, isWin, home, which, run, out } from './platform.js';
import { CAVEMAN } from './caveman.js';

const must = (r, what) => {
  if (r.status !== 0) throw new Error(`${what}: ${(r.stderr || r.stdout || '').trim().slice(-400)}`);
  return r;
};

// rtk ships prebuilt archives for every platform we support (brew covers macOS,
// but Windows and Linux take the archive). Unpack it into our own bin dir so no
// root, no rust toolchain and no package manager is needed.
const RTK_BIN_DIR = path.join(home, '.agent-stack', 'bin');

function rtkAsset(assets, tag) {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const patterns = isWin
    ? [(n) => n.includes(arch) && /windows/i.test(n) && n.endsWith('.zip')]
    : [
      (n) => n.startsWith(`rtk-${arch}-unknown-linux-gnu`) && n.endsWith('.tar.gz'),
      (n) => n.includes(arch) && /darwin/i.test(n) && n.endsWith('.tar.gz'),
      (n) => n.includes(arch) && /linux/i.test(n) && n.endsWith('.tar.gz'),
    ];
  for (const match of patterns) {
    const asset = assets.find((a) => match(a.name));
    if (asset) return asset;
  }
  throw new Error(`no rtk ${process.platform}/${process.arch} asset in ${tag}`);
}

async function installRtkFromRelease() {
  const rel = await (await fetch('https://api.github.com/repos/rtk-ai/rtk/releases/latest')).json();
  const asset = rtkAsset(rel.assets ?? [], rel.tag_name);
  fs.mkdirSync(RTK_BIN_DIR, { recursive: true });
  const file = path.join(os.tmpdir(), asset.name);
  fs.writeFileSync(file, Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer()));
  if (isWin) {
    must(run('powershell.exe', ['-NoProfile', '-Command',
      `Expand-Archive -Force -LiteralPath '${file}' -DestinationPath '${RTK_BIN_DIR}'`,
    ], { shell: false }), 'rtk unzip');
  } else {
    must(run('tar', ['-xzf', file, '-C', RTK_BIN_DIR]), 'rtk untar');
    const bin = path.join(RTK_BIN_DIR, 'rtk');
    if (fs.existsSync(bin)) fs.chmodSync(bin, 0o755);
  }
  process.env.PATH = `${RTK_BIN_DIR}${path.delimiter}${process.env.PATH}`;
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
      try {
        return await installRtkFromRelease();
      } catch (e) {
        // No GitHub access but a rust toolchain around: build it instead.
        if (!isWin && which('cargo')) {
          return must(run('cargo', ['install', '--git', 'https://github.com/rtk-ai/rtk']), 'cargo install rtk');
        }
        throw e;
      }
    },
  },
};

export const isInstalled = (id) => Boolean(which(id === 'bili' ? 'bili' : id));

// Agent-side add-ons. rtk/caveman live inside the agent (hooks, rules,
// skills), not in the network chain — so no ordering issues with bili/headroom.
export const ADDONS = {
  rtk: {
    claude: () => must(run('rtk', ['init', '-g', '--auto-patch']), 'rtk init claude'),
    // rtk rejects --auto-patch together with --codex / --opencode; these modes
    // never prompt anyway.
    codex: () => must(run('rtk', ['init', '-g', '--codex']), 'rtk init codex'),
    opencode: () => must(run('rtk', ['init', '-g', '--opencode']), 'rtk init opencode'),
  },
  caveman: CAVEMAN,
};
