import * as p from '@clack/prompts';
import { isMac, isWin, resolveRuntime } from './platform.js';
import { CHAINS, SERVICES } from './topology.js';
import { TARGETS } from './targets/index.js';
import { TOOLS, ADDONS, isInstalled } from './tools.js';
import {
  serviceCommands, installService, removeService, waitHealthy, findForeignAgents, retireForeignAgent,
} from './services.js';
import { backedUpFiles, restore } from './backup.js';

const cancelled = (v) => {
  if (p.isCancel(v)) {
    p.cancel('Отменено.');
    process.exit(1);
  }
  return v;
};

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

export async function install({ yes = false } = {}) {
  p.intro('agent-stack · rtk + bili + headroom + caveman');
  if (!isMac && !isWin) p.log.warn(`${process.platform}: сервисы не поддерживаются, только конфиги.`);

  const detected = TARGETS.filter((t) => t.detect());
  const agents = yes ? detected.map((t) => t.id) : cancelled(await p.multiselect({
    message: 'Каких агентов подключить?',
    options: TARGETS.map((t) => ({
      value: t.id,
      label: t.label,
      hint: [t.detect() ? 'найден' : 'не найден', CHAINS[t.id].hops.join(' → ')].join(' · '),
    })),
    initialValues: detected.map((t) => t.id),
    required: true,
  }));

  const layers = yes ? ['rtk', 'bili', 'headroom', 'caveman', 'dashboard'] : cancelled(await p.multiselect({
    message: 'Какие слои ставить?',
    options: [
      { value: 'rtk', label: 'rtk', hint: 'сжатие вывода команд (хуки в агенте)' },
      { value: 'bili', label: 'bili', hint: 'свёртка контекста сессии' },
      { value: 'headroom', label: 'headroom', hint: 'сжатие запросов (tool results/schemas)' },
      { value: 'caveman', label: 'caveman', hint: 'краткие ответы, всегда включён по умолчанию' },
      { value: 'dashboard', label: 'dashboard', hint: `общий дашборд :${SERVICES.dashboard.port}` },
    ],
    initialValues: ['rtk', 'bili', 'headroom', 'caveman', 'dashboard'],
    required: true,
  }));

  // bili and headroom are both required for the network chain — the base URLs
  // written into agent configs point through both.
  if (agents.length && (layers.includes('bili') !== layers.includes('headroom'))) {
    p.log.warn('Цепочка требует и bili, и headroom — добавляю оба.');
    for (const l of ['bili', 'headroom']) if (!layers.includes(l)) layers.push(l);
  }

  const foreign = findForeignAgents();
  if (foreign.length) {
    p.log.warn(`Найдены свои launchd-агенты bili/headroom (займут порты):\n${foreign.join('\n')}`);
    const ok = yes || cancelled(await p.confirm({ message: 'Отключить их (переименую в .disabled-by-agent-stack)?' }));
    if (ok) foreign.forEach(retireForeignAgent);
  }

  if (!yes) {
    p.note([
      `Агенты: ${agents.join(', ')}`,
      `Слои: ${layers.join(', ')}`,
      'Все изменённые конфиги бэкапятся в ~/.agent-stack/backups (uninstall вернёт).',
    ].join('\n'), 'План');
    cancelled(await p.confirm({ message: 'Ставим?' })) || process.exit(0);
  }

  // 1. tools
  for (const id of ['rtk', 'bili', 'headroom'].filter((l) => layers.includes(l))) {
    if (isInstalled(id)) p.log.info(`${TOOLS[id].label}: ${TOOLS[id].version() ?? 'есть'}`);
    else await step(`Ставлю ${TOOLS[id].label}`, TOOLS[id].install);
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
      p.log.error(`${SERVICES[name].label}: не нашёл исполняемый файл, пропускаю`);
      continue;
    }
    await step(`Сервис ${SERVICES[name].label} :${SERVICES[name].port}`, async () => {
      installService(name, cmds[name]);
      if (!(await waitHealthy(name))) throw new Error('не поднялся за 60с — смотри логи');
    });
  }

  // 3. wire agents
  for (const t of TARGETS.filter((x) => agents.includes(x.id))) {
    if (layers.includes('headroom')) await step(`${t.label}: цепочка ${CHAINS[t.id].hops.join(' → ')}`, () => t.apply());
    for (const addon of ['rtk', 'caveman']) {
      const fn = layers.includes(addon) && ADDONS[addon][t.id];
      if (fn) await step(`${t.label}: ${addon}`, fn);
    }
  }

  p.outro(`Готово. Проверка: agent-stack doctor · Дашборд: http://127.0.0.1:${SERVICES.dashboard.port}`);
}

export async function uninstall() {
  p.intro('agent-stack uninstall');
  const ok = cancelled(await p.confirm({ message: 'Удалить сервисы и вернуть конфиги из бэкапов?' }));
  if (!ok) return;
  for (const name of Object.keys(SERVICES)) await step(`Удаляю сервис ${SERVICES[name].label}`, () => removeService(name));
  for (const t of TARGETS) {
    if (t.id === 'opencode' || t.id === 'dsh') await step(`${t.label}: откат`, () => t.revert());
  }
  for (const f of backedUpFiles()) await step(`Восстанавливаю ${f}`, () => restore(f));
  p.outro('Откат завершён. Инструменты (rtk/bili/headroom) не удалял.');
}
