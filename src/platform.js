import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

export const isWin = process.platform === 'win32';
export const isMac = process.platform === 'darwin';
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

// Absolute paths the background services run from. Resolved at install time
// so launchd / Task Scheduler never depend on the login shell's PATH.
export function resolveRuntime() {
  const npmRoot = out('npm', ['root', '-g']);
  const uvToolDir = out('uv', ['tool', 'dir']);
  const biliEntry = npmRoot && path.join(npmRoot, 'billion-context', 'dist', 'index.js');
  const headroomPy = uvToolDir && path.join(
    uvToolDir, 'headroom-ai', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python',
  );
  return {
    node: process.execPath,
    biliEntry: biliEntry && fs.existsSync(biliEntry) ? biliEntry : null,
    headroomPython: headroomPy && fs.existsSync(headroomPy) ? headroomPy : null,
    headroomBin: which('headroom'),
    rtk: which('rtk'),
  };
}
