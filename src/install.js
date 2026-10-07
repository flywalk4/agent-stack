import * as p from '@clack/prompts';
import { isMac, isWin, isLinux, resolveRuntime } from './platform.js';
import { CHAINS, SERVICES } from './topology.js';
import { TARGETS } from './targets/index.js';
import { TOOLS, ADDONS, isInstalled } from './tools.js';
import {
  serviceCommands, installService, removeService, waitHealthy, findForeignAgents, retireForeignAgent,
  systemdMode, ensureLinger,
} from './services.js';
import { backedUpFiles, restore } from './backup.js';

// @clack/prompts reads stdin: without a TTY it never resolves and the installer
// looks hung. Fail loudly instead, pointing at the non-interactive flag.
const requireTTY = (hint) => {
  if (process.stdin.isTTY) return;
  console.error(`No TTY — interactive prompts cannot work here.\nRun: ${hint}`);
  process.exit(1);
};

const cancelled = (v) => {
  if (p.isCancel(v)) {
    p.cancel('Cancelled.');
    process.exit(1);
  }
  return v;
};

// @clack/prompts does not say how to operate a multiselect, so every one of
// them spells the keys out in its message.
const MULTI_HINT = '(space to select · enter to continue)';

async function step(label, fn) {
  const s = p.spinner();
  s.start(label);
  try {
    await fn();
    s.stop(`✓ ${label}`);
    return true;
  } catch (e) {
    s.stop(`✗ ${label}: ${e.message}`, 1);
    return false;
  }
}

async function chooseMode() {
  return cancelled(await p.select({
    message: 'What do you want to do?',
    options: [
      { value: 'install', label: 'Install / update', hint: 'wire the agents, (re)start the proxy services' },
      { value: 'uninstall', label: 'Uninstall', hint: 'remove the services, restore configs from backups' },
    ],
    initialValue: 'install',
  }));
}

export async function install({ yes = false } = {}) {
  if (!yes) requireTTY('agent-stack install --yes');
  p.intro('agent-stack · rtk + bili + headroom + caveman');
  if (!isMac && !isWin && !isLinux) p.log.warn(`${process.platform}: only config files are supported, not services.`);
  if (isLinux && !systemdMode()) {
    p.log.warn('systemd user manager is not reachable — services cannot be started.\n'
      + 'Run: sudo loginctl enable-linger $USER, then log in again and re-run the installer.');
  }

  // First run installs, later runs often want the other direction — offer both.
  if (!yes && await chooseMode() === 'uninstall') return uninstall();

  const detected = TARGETS.filter((t) => t.detect());
  const agents = yes ? detected.map((t) => t.id) : cancelled(await p.multiselect({
    message: `Which agents should be wired up? ${MULTI_HINT}`,
    options: TARGETS.map((t) => ({
      value: t.id,
      label: t.label,
      hint: [t.detect() ? 'found' : 'not found', CHAINS[t.id].hops.join(' → ')].join(' · '),
    })),
    initialValues: detected.map((t) => t.id),
    required: true,
  }));

  const layers = yes ? ['rtk', 'bili', 'headroom', 'caveman', 'dashboard'] : cancelled(await p.multiselect({
    message: `Which layers should be installed? ${MULTI_HINT}`,
    options: [
      { value: 'rtk', label: 'rtk', hint: 'shrinks shell command output (hooks inside the agent)' },
      { value: 'bili', label: 'bili', hint: 'context folding per session' },
      { value: 'headroom', label: 'headroom', hint: 'request compression (tool results / schemas)' },
      { value: 'caveman', label: 'caveman', hint: 'terse answers, always on by default' },
      { value: 'dashboard', label: 'dashboard', hint: `shared dashboard :${SERVICES.dashboard.port}` },
    ],
    initialValues: ['rtk', 'bili', 'headroom', 'caveman', 'dashboard'],
    required: true,
  }));

  // bili and headroom are both required for the network chain — the base URLs
  // written into agent configs point through both.
  if (agents.length && (layers.includes('bili') !== layers.includes('headroom'))) {
    p.log.warn('The chain needs both bili and headroom — adding the missing one.');
    for (const l of ['bili', 'headroom']) if (!layers.includes(l)) layers.push(l);
  }

  const foreign = findForeignAgents();
  if (foreign.length) {
    p.log.warn(`Found your own bili/headroom services (they would take the ports):\n${foreign.join('\n')}`);
    const ok = yes || cancelled(await p.confirm({ message: 'Disable them (rename to .disabled-by-agent-stack)?' }));
    if (ok) foreign.forEach(retireForeignAgent);
  }

  if (!yes) {
    p.note([
      `Agents: ${agents.join(', ')}`,
      `Layers: ${layers.join(', ')}`,
      'Every changed config is backed up to ~/.agent-stack/backups (uninstall puts it back).',
    ].join('\n'), 'Plan');
    cancelled(await p.confirm({ message: 'Install?' })) || process.exit(0);
  }

  // 1. tools
  for (const id of ['rtk', 'bili', 'headroom'].filter((l) => layers.includes(l))) {
    if (isInstalled(id)) p.log.info(`${TOOLS[id].label}: ${TOOLS[id].version() ?? 'present'}`);
    else await step(`Installing ${TOOLS[id].label}`, TOOLS[id].install);
  }

  // 2. background services
  const rt = resolveRuntime();
  const cmds = serviceCommands(rt);
  const wanted = [
    layers.includes('bili') && 'bili',
    layers.includes('headroom') && 'headroom',
    layers.includes('headroom') && agents.includes('dsh') && 'headroomDeepseek',
    layers.includes('dashboard') && 'dashboard',
  ].filter(Boolean);
  for (const name of wanted) {
    if (!cmds[name]) {
      p.log.error(`${SERVICES[name].label}: executable not found, skipping`);
      continue;
    }
    await step(`Service ${SERVICES[name].label} :${SERVICES[name].port}`, async () => {
      installService(name, cmds[name]);
      if (!(await waitHealthy(name))) throw new Error('did not come up within 60s — check the logs');
    });
  }

  // systemd user units die with the last session unless lingering is on.
  if (isLinux && wanted.length && ensureLinger() === false) {
    p.log.warn('Could not enable lingering: the services stop when you log out.\n'
      + 'Run: sudo loginctl enable-linger $USER');
  }

  // 3. wire agents
  for (const t of TARGETS.filter((x) => agents.includes(x.id))) {
    if (layers.includes('headroom')) await step(`${t.label}: chain ${CHAINS[t.id].hops.join(' → ')}`, () => t.apply());
    for (const addon of ['rtk', 'caveman']) {
      const fn = layers.includes(addon) && ADDONS[addon][t.id];
      if (fn) await step(`${t.label}: ${addon}`, fn);
    }
  }

  p.outro(`Done. Verify: agent-stack doctor · Dashboard: http://127.0.0.1:${SERVICES.dashboard.port}`);
}

export async function uninstall() {
  requireTTY('agent-stack uninstall');
  p.intro('agent-stack uninstall');
  const ok = cancelled(await p.confirm({ message: 'Remove the services and restore configs from the backups?' }));
  if (!ok) return;
  for (const name of Object.keys(SERVICES)) await step(`Removing service ${SERVICES[name].label}`, () => removeService(name));
  for (const t of TARGETS) {
    if (t.id === 'opencode' || t.id === 'dsh') await step(`${t.label}: reverting`, () => t.revert());
  }
  for (const f of backedUpFiles()) await step(`Restoring ${f}`, () => restore(f));
  p.outro('Rollback complete. The tools (rtk/bili/headroom) were left installed.');
}
