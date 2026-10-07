import fs from 'node:fs';
import { CONFIG_PATHS, which } from '../platform.js';
import { CHAINS } from '../topology.js';
import { backupOnce, restore, writeAtomic } from '../backup.js';

const file = CONFIG_PATHS.claudeSettings;

export default {
  id: 'claude',
  label: CHAINS.claude.label,
  detect: () => Boolean(which('claude')) || fs.existsSync(file),

  current() {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')).env?.ANTHROPIC_BASE_URL ?? null;
  },

  // settings.json env beats the process env, so this also covers wrappers
  // that exec claude and merge their own --settings on top of it.
  apply() {
    backupOnce(file);
    const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    s.env = { ...s.env, ANTHROPIC_BASE_URL: CHAINS.claude.baseUrl };
    writeAtomic(file, `${JSON.stringify(s, null, 2)}\n`);
  },

  revert: () => restore(file),
  ok() {
    return this.current() === CHAINS.claude.baseUrl;
  },
};
