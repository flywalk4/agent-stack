import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isMac, isWin, home, which, run, out, resolveRuntime } from './platform.js';
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
  const response = await fetch('https://api.github.com/repos/rtk-ai/rtk/releases/latest', {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`rtk release lookup failed (HTTP ${response.status})`);
  const rel = await response.json();
  const version = rel.tag_name?.replace(/^v/, '');
  if (!version) throw new Error('rtk release has no version');
  const useBinary = () => {
    process.env.PATH = `${RTK_BIN_DIR}${path.delimiter}${process.env.PATH}`;
  };
  const current = run(RTK_BIN, ['--version'], { shell: false });
  if (current.status === 0 && current.stdout.trim().split(/\s+/)[1] === version) {
    useBinary();
    return;
  }
  const candidates = rtkAssets(rel.assets ?? []);
  if (!candidates.length) throw new Error(`no rtk archive for ${process.platform}/${process.arch} in ${rel.tag_name}`);
  const failures = [];
  fs.mkdirSync(RTK_BIN_DIR, { recursive: true });
  for (const asset of candidates) {
    // Stage on the same filesystem so a failed update leaves the old binary in place.
    const staging = fs.mkdtempSync(path.join(RTK_BIN_DIR, '.rtk-'));
    try {
      const file = path.join(staging, isWin ? 'rtk.zip' : 'rtk.tar.gz');
      const archive = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(120_000) });
      if (!archive.ok) throw new Error(`download failed (HTTP ${archive.status})`);
      const buf = Buffer.from(await archive.arrayBuffer());
      if (buf.length < 400_000) throw new Error(`download looks truncated (${buf.length} bytes)`);
      if (asset.digest && asset.digest !== `sha256:${createHash('sha256').update(buf).digest('hex')}`) {
        throw new Error('download checksum mismatch');
      }
      fs.writeFileSync(file, buf);
      if (isWin) {
        must(run('powershell.exe', ['-NoProfile', '-Command',
          `Expand-Archive -LiteralPath '${file.replaceAll("'", "''")}' -DestinationPath '${staging.replaceAll("'", "''")}'`,
        ], { shell: false }), 'rtk unzip');
      } else {
        must(run('tar', ['-xzf', file, '-C', staging]), 'rtk untar');
      }
      const bin = findRtk(staging);
      if (!bin) throw new Error('archive did not contain an rtk binary');
      if (!looksExecutable(bin)) throw new Error(`extracted file is not a ${process.platform} binary`);
      fs.chmodSync(bin, 0o755);
      const probe = must(run(bin, ['--version'], { shell: false }), 'rtk --version');
      if (probe.stdout.trim().split(/\s+/)[1] !== version) {
        throw new Error(`expected rtk ${version}, got ${probe.stdout.trim()}`);
      }
      fs.renameSync(bin, RTK_BIN);
      useBinary();
      return;
    } catch (e) {
      failures.push(`${asset.name}: ${e.message}`);
    } finally {
      fs.rmSync(staging, { force: true, recursive: true });
    }
  }
  throw new Error(`could not install rtk from a release archive:\n  ${failures.join('\n  ')}`);
}

export const TOOLS = {
  bili: {
    label: 'bili (billion-context)',
    version: () => out('bili', ['--version']),
    install: () => must(run('npm', ['install', '-g', '--prefer-online', 'billion-context@latest']), 'npm i -g billion-context@latest'),
  },
  headroom: {
    label: 'headroom',
    version: () => out('headroom', ['--version']),
    install: () => {
      // `headroom proxy` lives in the `proxy` extra — installing the bare package
      // leaves the service crash-looping on "No module named 'fastapi'".
      must(run('uv', ['tool', 'install', '--upgrade', 'headroom-ai[proxy]']), 'uv tool install headroom-ai[proxy]');
      const py = resolveRuntime().headroomPython;
      if (!py) throw new Error('headroom Python executable not found in the uv tool environment');
      // Ask headroom itself: its own guard knows which modules the proxy needs.
      const probe = run(py, ['-c', 'from headroom.cli.proxy import ensure_proxy_dependencies; ensure_proxy_dependencies()']);
      if (probe.status !== 0) {
        throw new Error(`headroom proxy extras are missing (${(probe.stderr || probe.stdout || '').trim().slice(-300)})`);
      }
    },
  },
  rtk: {
    label: 'rtk',
    version: () => out('rtk', ['--version']),
    install: async () => {
      if (isMac && which('brew') && !fs.existsSync(RTK_BIN)) {
        const installed = out('brew', ['list', '--versions', '--formula', 'rtk']);
        const action = installed ? 'upgrade' : 'install';
        const env = {
          ...process.env,
          HOMEBREW_AUTO_UPDATE_SECS: '0',
          HOMEBREW_API_AUTO_UPDATE_SECS: '0',
          HOMEBREW_NO_INSTALL_CLEANUP: '1',
          HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: '1',
        };
        must(run('brew', [action, '--formula', 'rtk'], { env }), `brew ${action} rtk`);
        return;
      }
      try {
        return await installRtkFromRelease();
      } catch (e) {
        // Keep the source-build fallback for first installs only.
        if (!isWin && !fs.existsSync(RTK_BIN) && !which('rtk') && which('cargo')) {
          return must(run('cargo', ['install', '--git', 'https://github.com/rtk-ai/rtk']), 'cargo install rtk');
        }
        throw e;
      }
    },
  },
};

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
