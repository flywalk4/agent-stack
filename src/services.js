import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMac, isWin, isLinux, home, LOG_DIR, JOB_PATH, run, out, which } from './platform.js';
import { PORTS, SERVICES } from './topology.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABEL_PREFIX = 'dev.agent-stack.';
const LAUNCH_AGENTS = path.join(home, 'Library', 'LaunchAgents');

export function serviceCommands(rt) {
  const hr = (port, extra = []) => rt.headroomPython && [
    rt.headroomPython, '-m', 'headroom.cli', 'proxy',
    '--host', '127.0.0.1', '--port', String(port), '--no-rate-limit', ...extra,
  ];
  return {
    bili: rt.biliEntry && [rt.node, rt.biliEntry, 'start', '--host', '127.0.0.1', '--port', String(PORTS.bili)],
    headroom: hr(PORTS.headroom),
    headroomDeepseek: hr(PORTS.headroomDeepseek, [
      '--openai-api-url', SERVICES.headroomDeepseek.upstream,
      '--anthropic-api-url', SERVICES.headroomDeepseek.anthropicUpstream,
      '--provider-name', 'DeepSeek',
    ]),
    dashboard: [rt.node, path.join(REPO_ROOT, 'bin', 'agent-stack.js'), 'dashboard', '--serve'],
  };
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;

// ---------- macOS: launchd user agents ----------

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plist(label, argv, log, env = {}) {
  const vars = { PATH: JOB_PATH, ...env };
  const envXml = Object.entries(vars)
    .map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(String(v))}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
${argv.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key><dict>
${envXml}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

const uid = () => out('id', ['-u']);
const plistPath = (label) => path.join(LAUNCH_AGENTS, `${label}.plist`);

const isLoaded = (domain, label) => run('launchctl', ['print', `${domain}/${label}`]).status === 0;

// launchd tears a booted-out job down asynchronously, and the old job stays
// visible to `launchctl print` while it happens. Bootstrapping during that
// window fails with "Bootstrap failed: 5: Input/output error" — and because the
// stale job is still loaded, trusting `print` here would report success while
// launchd goes on to remove the job for good, leaving the service not running at
// all. So: wait until the label is really gone, bootstrap, then confirm the job
// is still loaded after a moment before believing it worked.
function macInstall(name, argv) {
  const label = LABEL_PREFIX + name;
  const file = plistPath(label);
  const domain = `gui/${uid()}`;
  fs.mkdirSync(LAUNCH_AGENTS, { recursive: true });
  fs.writeFileSync(file, plist(label, argv, path.join(LOG_DIR, `${name}.log`), SERVICES[name]?.env));
  let last = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    run('launchctl', ['bootout', `${domain}/${label}`]);
    for (let i = 0; i < 50 && isLoaded(domain, label); i++) sleepSync(100);
    last = run('launchctl', ['bootstrap', domain, file]);
    if (last.status === 0) return;
    // EIO after a clean teardown: give the load a moment, then re-check, so a
    // job that launchd is about to drop is not mistaken for a running one.
    if (isLoaded(domain, label)) {
      sleepSync(700);
      if (isLoaded(domain, label)) return;
    }
    sleepSync(500);
  }
  throw new Error(`launchctl bootstrap ${label}: ${last.stderr.trim()}`);
}

function macRemove(name) {
  const label = LABEL_PREFIX + name;
  run('launchctl', ['bootout', `gui/${uid()}/${label}`]);
  fs.rmSync(plistPath(label), { force: true });
}

// ---------- Windows: Task Scheduler, at logon, hidden, auto-restart ----------

const psq = (s) => `'${s.replace(/'/g, "''")}'`;
const cmdq = (s) => (/[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

function winInstall(name, argv) {
  const task = `agent-stack-${name}`;
  const log = path.join(LOG_DIR, `${name}.log`);
  // Per-service environment (see SERVICES[*].env in topology.js).
  const envCmd = Object.entries(SERVICES[name]?.env ?? {})
    .map(([k, v]) => `set "${k}=${v}" && `).join('');
  // conhost --headless keeps the console window hidden (Win10 1809+).
  const inner = `${envCmd}${argv.map(cmdq).join(' ')} >> ${cmdq(log)} 2>&1`;
  const script = `
$ErrorActionPreference = 'Stop'
$a = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ${psq(`--headless cmd.exe /d /c "${inner}"`)}
$t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName ${psq(task)} -Action $a -Trigger $t -Settings $s -Force | Out-Null
Start-ScheduledTask -TaskName ${psq(task)}
`;
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { shell: false });
  if (r.status !== 0) throw new Error(`Register-ScheduledTask ${task}: ${r.stderr.trim()}`);
}

function winRemove(name) {
  const task = `agent-stack-${name}`;
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Stop-ScheduledTask -TaskName ${psq(task)} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${psq(task)} -Confirm:$false -ErrorAction SilentlyContinue`,
  ], { shell: false });
}

// ---------- Linux: systemd user units ----------

export const UNIT_PREFIX = 'dev-agent-stack-';
export const unitName = (name) => `${UNIT_PREFIX}${name}.service`;
const systemdUserDir = () => path.join(home, '.config', 'systemd', 'user');

// systemd expands `%` specifiers and `$` variables inside a unit file, and uses
// double quotes with backslash escapes for word splitting — so every argument
// and environment value goes through here.
const unitWord = (s) => `"${String(s)
  .replace(/%/g, '%%')
  .replace(/\$/g, () => '$$')
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"')}"`;

export function systemdUnit({ name, label, argv, log, env = {}, mode = 'user' }) {
  const vars = { PATH: JOB_PATH, ...env };
  return `[Unit]
Description=agent-stack: ${label}

[Service]
Type=simple
WorkingDirectory=${unitWord(home)}
ExecStartPre=-/bin/mkdir -p ${unitWord(path.dirname(log))}
ExecStart=${argv.map(unitWord).join(' ')}
${Object.entries(vars).map(([k, v]) => `Environment=${k}=${unitWord(v)}`).join('\n')}
Restart=always
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=20
SyslogIdentifier=agent-stack-${name}
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=${mode === 'user' ? 'default.target' : 'multi-user.target'}
`;
}

const systemctl = (mode, args) => run('systemctl', mode === 'user' ? ['--user', ...args] : args);
const scArgs = (mode, args) => `systemctl ${mode === 'user' ? '--user ' : ''}${args.join(' ')}`;

// A user manager answers `show-environment`; a bare container or a root shell
// without lingering does not, in which case system-wide units are the only
// option (and root is the only one who can write them).
export function systemdMode() {
  if (run('systemctl', ['--user', 'show-environment']).status === 0) return 'user';
  if (isRoot() && fs.existsSync('/run/systemd/system')) return 'system';
  return null;
}

function linuxInstall(name, argv) {
  const mode = systemdMode();
  if (!mode) {
    throw new Error('no systemd user manager — run `sudo loginctl enable-linger $USER`, log in again, then re-run the installer');
  }
  const unit = unitName(name);
  const dir = mode === 'user' ? systemdUserDir() : '/etc/systemd/system';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, unit), systemdUnit({
    name,
    label: SERVICES[name]?.label ?? name,
    argv,
    log: path.join(LOG_DIR, `${name}.log`),
    env: SERVICES[name]?.env,
    mode,
  }));
  systemctl(mode, ['daemon-reload']);
  systemctl(mode, ['enable', unit]);
  const r = systemctl(mode, ['restart', unit]);
  if (r.status !== 0) {
    throw new Error(`${scArgs(mode, ['restart', unit])}: ${(r.stderr || r.stdout || '').trim()}`);
  }
  for (let i = 0; i < 50; i++) {
    if (systemctl(mode, ['is-active', '--quiet', unit]).status === 0) return;
    sleepSync(100);
  }
  throw new Error(`${unit} did not become active — check: journalctl ${mode === 'user' ? '--user ' : ''}-u ${unit} -n 50`);
}

function linuxRemove(name) {
  const unit = unitName(name);
  for (const [mode, dir] of [['user', systemdUserDir()], ['system', '/etc/systemd/system']]) {
    const file = path.join(dir, unit);
    if (!fs.existsSync(file)) continue;
    systemctl(mode, ['disable', '--now', unit]);
    try {
      fs.rmSync(file, { force: true });
    } catch (e) {
      throw new Error(`cannot remove ${file}: ${e.message}`);
    }
    systemctl(mode, ['daemon-reload']);
  }
}

// Without lingering, systemd kills the units when the last session of that user
// logs out — fine on a desktop, useless on a server. Best effort: enable it, and
// tell the caller when we could not.
export function ensureLinger() {
  if (!isLinux || isRoot() || !which('loginctl')) return null;
  const user = process.env.USER || out('id', ['-un']);
  const linger = () => /Linger=yes/.test(out('loginctl', ['show-user', user, '--property=Linger']) ?? '');
  if (linger()) return true;
  run('loginctl', ['enable-linger', user]);
  return linger();
}

// ---------- foreign agents ----------

// Hand-made agents/units that run bili/headroom on our ports would fight for them.
export function findForeignAgents() {
  const hits = (dir) => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.service') && !f.startsWith(UNIT_PREFIX))
      .map((f) => path.join(dir, f))
      .filter((f) => {
        try {
          return /billion-context|headroom\.cli/.test(fs.readFileSync(f, 'utf8'));
        } catch {
          return false;
        }
      });
  };
  if (isMac) {
    if (!fs.existsSync(LAUNCH_AGENTS)) return [];
    return fs.readdirSync(LAUNCH_AGENTS)
      .filter((f) => f.endsWith('.plist') && !f.startsWith(LABEL_PREFIX))
      .map((f) => path.join(LAUNCH_AGENTS, f))
      .filter((f) => /billion-context|headroom\.cli/.test(fs.readFileSync(f, 'utf8')));
  }
  if (isLinux) {
    const dirs = systemdMode() === 'system'
      ? ['/etc/systemd/system']
      : [systemdUserDir(), '/etc/systemd/system'];
    return dirs.flatMap(hits);
  }
  return [];
}

export function retireForeignAgent(file) {
  const name = path.basename(file).replace(/\.(plist|service)$/, '');
  if (isMac) {
    run('launchctl', ['bootout', `gui/${uid()}/${name}`]);
  } else if (isLinux) {
    const unit = path.basename(file);
    const scope = file.startsWith(systemdUserDir()) ? 'user' : 'system';
    systemctl(scope, ['disable', '--now', unit]);
  }
  fs.renameSync(file, `${file}.disabled-by-agent-stack`);
}

// ---------- public ----------

export function installService(name, argv) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  if (isMac) return macInstall(name, argv);
  if (isWin) return winInstall(name, argv);
  if (isLinux) return linuxInstall(name, argv);
  throw new Error(`unsupported platform: ${process.platform}`);
}

export function removeService(name) {
  if (isMac) return macRemove(name);
  if (isWin) return winRemove(name);
  if (isLinux) return linuxRemove(name);
}

export async function waitHealthy(name, timeoutMs = 60_000) {
  const { port, health } = SERVICES[name];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(port, health)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export async function probe(port, p, timeoutMs = 3000) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}
