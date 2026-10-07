import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

export const isWin = process.platform === 'win32';
export const isMac = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';
export const home = os.homedir();

export const STATE_DIR = path.join(home, '.agent-stack');
export const LOG_DIR = isMac
  ? path.join(home, 'Library', 'Logs', 'agent-stack')
  : path.join(STATE_DIR, 'logs');

export const CONFIG_PATHS = {
  claudeSettings: path.join(home, '.claude', 'settings.json'),
  codexConfig: path.join(home, '.codex', 'config.toml'),
  dshProfiles: path.join(home, '.dsh', 'profiles'),
};

export function which(cmd) {
  const r = spawnSync(isWin ? 'where' : 'which', [cmd], { encoding: 'utf8', shell: isWin });
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/).find(Boolean)?.trim() ?? null;
}

export function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', shell: isWin, ...opts });
}

export function out(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', shell: isWin, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// launchd hands jobs a bare /usr/bin:/bin PATH and systemd units inherit almost
// nothing, so anything installed by brew, cargo, uv or a user-level npm prefix
// (rtk above all) stays invisible unless we spell the directories out.
export const JOB_PATH = [
  ...(isMac ? ['/opt/homebrew/bin'] : []),
  path.join(home, '.local', 'bin'),
  path.join(STATE_DIR, 'bin'),
  path.join(home, '.cargo', 'bin'),
  path.join(home, '.bun', 'bin'),
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
].join(':');

const firstExisting = (candidates) => candidates.find((f) => f && fs.existsSync(f)) ?? null;

// Absolute paths the background services run from. Resolved at install time so
// launchd / Task Scheduler / systemd never depend on the login shell's PATH.
export function resolveRuntime() {
  const npmRoot = out('npm', ['root', '-g']);
  const uvToolDir = out('uv', ['tool', 'dir']);
  const nodeModulesDirs = [
    npmRoot,
    path.join(home, '.local', 'lib', 'node_modules'),
    path.join(home, '.npm-global', 'lib', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ];
  const uvToolDirs = [
    uvToolDir,
    path.join(home, '.local', 'share', 'uv', 'tools'),
    '/usr/local/share/uv/tools',
  ];
  const biliEntry = firstExisting(
    nodeModulesDirs.map((d) => d && path.join(d, 'billion-context', 'dist', 'index.js')),
  );
  const headroomPython = firstExisting(uvToolDirs.map((d) => d && path.join(
    d, 'headroom-ai', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python',
  )));
  return {
    node: process.execPath,
    biliEntry,
    headroomPython,
    headroomBin: which('headroom'),
    rtk: which('rtk'),
  };
}
