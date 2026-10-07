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
const RTK_BIN = path.join(RTK_BIN_DIR, isWin ? 'rtk.exe' : 'rtk');

// The release also carries .deb / .rpm packages, so the assets are matched by
// exact shape (archive suffix + libc), never by a loose `includes(arch)`. Linux
// x86_64 is only published as a static musl build, arm64 as glibc.
export function rtkAssets(assets) {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const patterns = isWin
    ? [new RegExp(`^rtk-${arch}.*windows.*\\.zip$`, 'i')]
    : isMac
      ? [new RegExp(`^rtk-${arch}.*darwin.*\\.tar\\.gz$`, 'i')]
      : [
        new RegExp(`^rtk-${arch}.*linux.*musl.*\\.tar\\.gz$`, 'i'),
        new RegExp(`^rtk-${arch}.*linux.*gnu.*\\.tar\\.gz$`, 'i'),
        new RegExp(`^rtk-${arch}.*linux.*\\.tar\\.gz$`, 'i'),
      ];
  const seen = new Set();
  const hits = [];
  for (const re of patterns) {
    for (const a of assets) {
      if (re.test(a.name) && !seen.has(a.name)) {
        seen.add(a.name);
        hits.push(a);
      }
    }
  }
  return hits;
}

function findRtk(dir, depth = 0) {
  if (depth > 3) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === (isWin ? 'rtk.exe' : 'rtk')) return full;
    if (e.isDirectory()) {
      const nested = findRtk(full, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

// A truncated download, an HTML error page or an archive for the wrong platform
// all end up here — and none of them is a runnable binary, so check before
// trusting the file (a shell would otherwise try to interpret the bytes).
function looksExecutable(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    if (fs.readSync(fd, head, 0, 4, 0) !== 4) return false;
    if (process.platform === 'linux') return head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    if (process.platform === 'darwin') {
      // 64/32-bit Mach-O in either byte order, plus "fat" universal archives.
      const le = head.readUInt32LE(0);
      return le === 0xfeedfacf || le === 0xfeedface || head.readUInt32BE(0) === 0xcafebabe;
    }
    if (isWin) return head[0] === 0x4d && head[1] === 0x5a;
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

async function installRtkFromRelease() {
  const rel = await (await fetch('https://api.github.com/repos/rtk-ai/rtk/releases/latest')).json();
  const candidates = rtkAssets(rel.assets ?? []);
  if (!candidates.length) throw new Error(`no rtk archive for ${process.platform}/${process.arch} in ${rel.tag_name}`);
  const failures = [];
  for (const asset of candidates) {
    try {
      // Never leave a half-written file behind: a stale non-binary rtk in our bin
      // dir shadows the real one on PATH.
      fs.rmSync(RTK_BIN, { force: true, recursive: true });
      fs.mkdirSync(RTK_BIN_DIR, { recursive: true });
      const file = path.join(os.tmpdir(), asset.name);
      const buf = Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer());
      fs.writeFileSync(file, buf);
      if (buf.length < 400_000) throw new Error(`download looks truncated (${buf.length} bytes)`);
      if (isWin) {
        must(run('powershell.exe', ['-NoProfile', '-Command',
          `Expand-Archive -Force -LiteralPath '${file}' -DestinationPath '${RTK_BIN_DIR}'`,
        ], { shell: false }), 'rtk unzip');
      } else {
        must(run('tar', ['-xzf', file, '-C', RTK_BIN_DIR]), 'rtk untar');
      }
      const bin = findRtk(RTK_BIN_DIR);
      if (!bin) throw new Error('archive did not contain an rtk binary');
      if (!looksExecutable(bin)) throw new Error(`extracted file is not a ${process.platform} binary`);
      fs.chmodSync(bin, 0o755);
      const probe = run(bin, ['--version']);
      if (probe.status !== 0) {
        throw new Error(`rtk --version failed: ${(probe.stderr || probe.stdout || '').trim().slice(0, 200)}`);
      }
      process.env.PATH = `${RTK_BIN_DIR}${path.delimiter}${process.env.PATH}`;
      return;
    } catch (e) {
      failures.push(`${asset.name}: ${e.message}`);
    }
  }
  fs.rmSync(RTK_BIN, { force: true, recursive: true });
  throw new Error(`could not install rtk from a release archive:\n  ${failures.join('\n  ')}`);
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
