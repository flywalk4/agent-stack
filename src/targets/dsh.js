import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_PATHS, which, run } from '../platform.js';
import { CHAINS } from '../topology.js';
import { backupOnce, restore, writeAtomic } from '../backup.js';

const START = '# --- agent-stack: headroom (DeepSeek) ---';
const END = '# --- end agent-stack ---';
const BLOCK = new RegExp(`\\n?${START}[\\s\\S]*?${END}\\n?`);
// A hand-written override from before agent-stack would fight ours.
const LEGACY = /\n?(#[^\n]*headroom[^\n]*\n)?- id: deepseek-account\n {2}config:\n {4}inferenceOrigin: [^\n]*\n?/g;

const block = () => `${START}
- id: deepseek-account
  config:
    inferenceOrigin: ${CHAINS.dsh.inferenceOrigin}
${END}
`;

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
      const text = fs.readFileSync(f, 'utf8').replace(BLOCK, '').replace(LEGACY, '\n');
      writeAtomic(f, `${text.replace(/\n*$/, '\n')}${block()}`);
    }
  },

  revert() {
    for (const f of patchFiles()) restore(f);
    return true;
  },
  ok() {
    const files = patchFiles();
    // Only profiles running the DeepSeek account provider need the override.
    const routed = (f) => fs.readFileSync(f, 'utf8').includes(`inferenceOrigin: ${CHAINS.dsh.inferenceOrigin}`);
    return files.some(routed);
  },
};
