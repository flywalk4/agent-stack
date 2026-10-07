import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_PATHS, which, run } from '../platform.js';
import { CHAINS } from '../topology.js';
import { backupOnce, restore, writeAtomic } from '../backup.js';

const START = '# --- agent-stack: headroom (DeepSeek) ---';
const END = '# --- end agent-stack ---';
// Markers contain regex metacharacters (`(`, `)`), so they must be escaped
// before being embedded — otherwise BLOCK never matches and every apply
// appends a second copy of the entries instead of replacing the first.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BLOCK = new RegExp(`\\n?${esc(START)}[\\s\\S]*?${esc(END)}\\n?`);
// Repeated applies used to leave one dangling END marker per run behind, and a
// patch entry that targeted a plugin id the base profile does not mount.
const STRAY_END = new RegExp(`^${esc(END)}\\n?`, 'gm');
const LEGACY = /\n?(#[^\n]*headroom[^\n]*\n)?- id: deepseek-account\n {2}config:\n {4}inferenceOrigin: [^\n]*\n?/g;
// A fresh profile's patch file is an empty flow sequence (`[]`) with comments.
// YAML allows only one root node, so appending our entries to it would make the
// whole overlay unparseable ("end of the stream or a document separator is
// expected").
const isBareEmptyList = (text) => text.replace(/^\s*#.*$/gm, '').trim() === '[]';

// The base profile mounts two DeepSeek routes and the user may select either
// one, so both get the override: `llm-deepseek` is the api-key route
// (@deepseek-ai/dsh-llm-deepseek-api-key, the `deepseek-official` provider) and
// it takes `baseURL`; `llm-deepseek-account` is the platform-account route and
// takes `inferenceOrigin`. Both fields are schema-volatile, so this patch layer
// is the only place that can point them at headroom.
const ROUTES = [
  { id: 'llm-deepseek', key: 'baseURL' },
  { id: 'llm-deepseek-account', key: 'inferenceOrigin' },
];

const block = () => `${START}
${ROUTES.map((r) => `- id: ${r.id}
  config:
    ${r.key}: ${CHAINS.dsh.inferenceOrigin}`).join('\n')}
${END}
`;
// The patch entry we used before finding the real ids.
const OLD = '- id: deepseek-account';

function patchFiles() {
  const root = CONFIG_PATHS.dshProfiles;
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .map((p) => path.join(root, p, 'cordis.patch.yml'))
    .filter((f) => fs.existsSync(f));
}

export default {
  id: 'dsh',
  label: CHAINS.dsh.label,
  detect: () => Boolean(which('dsh')) || fs.existsSync(CONFIG_PATHS.dshProfiles),

  current() {
    const done = patchFiles().filter((f) => fs.readFileSync(f, 'utf8').includes(START));
    return done.length ? `${CHAINS.dsh.inferenceOrigin} (${done.length} profiles)` : null;
  },

  apply() {
    // bili as a dsh bundle (bili-native, in-process) in every profile.
    run('bili', ['plugin', 'install', 'dsh']);
    for (const f of patchFiles()) {
      backupOnce(f);
      let text = fs.readFileSync(f, 'utf8')
        .replace(BLOCK, '')
        .replace(LEGACY, '\n')
        .replace(STRAY_END, '');
      if (isBareEmptyList(text)) text = text.replace(/^[ \t]*\[\][ \t]*\n?/m, '');
      writeAtomic(f, `${text.replace(/\n*$/, '\n')}${block()}`);
    }
  },

  revert() {
    for (const f of patchFiles()) restore(f);
    return true;
  },
  ok() {
    const files = patchFiles();
    const routed = (f) => {
      const text = fs.readFileSync(f, 'utf8');
      return text.includes(START)
        && !text.includes(OLD)
        && ROUTES.every((r) => text.includes(`${r.key}: ${CHAINS.dsh.inferenceOrigin}`));
    };
    return files.some(routed);
  },
};
