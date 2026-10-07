import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMac, isWin, home, LOG_DIR, run, out } from './platform.js';
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
      '--openai-api-url', SERVICES.headroomDeepseek.upstream, '--provider-name', 'DeepSeek',
    ]),
    dashboard: [rt.node, path.join(REPO_ROOT, 'bin', 'agent-stack.js'), 'dashboard', '--serve'],
  };
}

// ---------- macOS: launchd user agents ----------

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plist(label, argv, log) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
${argv.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

const uid = () => out('id', ['-u']);
const plistPath = (label) => path.join(LAUNCH_AGENTS, `${label}.plist`);

function macInstall(name, argv) {
  const label = LABEL_PREFIX + name;
  const file = plistPath(label);
  fs.mkdirSync(LAUNCH_AGENTS, { recursive: true });
  run('launchctl', ['bootout', `gui/${uid()}/${label}`]);
  fs.writeFileSync(file, plist(label, argv, path.join(LOG_DIR, `${name}.log`)));
  const r = run('launchctl', ['bootstrap', `gui/${uid()}`, file]);
  if (r.status !== 0) throw new Error(`launchctl bootstrap ${label}: ${r.stderr.trim()}`);
}

function macRemove(name) {
  const label = LABEL_PREFIX + name;
  run('launchctl', ['bootout', `gui/${uid()}/${label}`]);
  fs.rmSync(plistPath(label), { force: true });
}

// Hand-made agents that run bili/headroom on our ports would fight for them.
export function findForeignAgents() {
  if (!isMac || !fs.existsSync(LAUNCH_AGENTS)) return [];
  return fs.readdirSync(LAUNCH_AGENTS)
    .filter((f) => f.endsWith('.plist') && !f.startsWith(LABEL_PREFIX))
    .map((f) => path.join(LAUNCH_AGENTS, f))
    .filter((f) => /billion-context|headroom\.cli/.test(fs.readFileSync(f, 'utf8')));
}

export function retireForeignAgent(file) {
  const label = path.basename(file, '.plist');
  run('launchctl', ['bootout', `gui/${uid()}/${label}`]);
  fs.renameSync(file, `${file}.disabled-by-agent-stack`);
}

// ---------- Windows: Task Scheduler, at logon, hidden, auto-restart ----------

const psq = (s) => `'${s.replace(/'/g, "''")}'`;
const cmdq = (s) => (/[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

function winInstall(name, argv) {
  const task = `agent-stack-${name}`;
  const log = path.join(LOG_DIR, `${name}.log`);
  // conhost --headless keeps the console window hidden (Win10 1809+).
  const inner = `${argv.map(cmdq).join(' ')} >> ${cmdq(log)} 2>&1`;
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

// ---------- public ----------

export function installService(name, argv) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  if (isMac) return macInstall(name, argv);
  if (isWin) return winInstall(name, argv);
  throw new Error(`unsupported platform: ${process.platform}`);
}

export function removeService(name) {
  if (isMac) return macRemove(name);
  if (isWin) return winRemove(name);
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
