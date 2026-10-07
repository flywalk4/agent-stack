import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './platform.js';

const BACKUP_DIR = path.join(STATE_DIR, 'backups');
const MANIFEST = path.join(BACKUP_DIR, 'manifest.json');

const load = () => (fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {});
const save = (m) => {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
};

// Only the first backup per file is kept: that is the pre-agent-stack state
// uninstall must return to, no matter how many times install is re-run.
export function backupOnce(file) {
  const m = load();
  if (m[file]) return;
  const existed = fs.existsSync(file);
  let copy = null;
  if (existed) {
    copy = path.join(BACKUP_DIR, `${Date.now()}-${path.basename(file)}`);
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.copyFileSync(file, copy);
  }
  m[file] = { existed, copy };
  save(m);
}

export function restore(file) {
  const m = load();
  const entry = m[file];
  if (!entry) return false;
  if (entry.existed) fs.copyFileSync(entry.copy, file);
  else fs.rmSync(file, { force: true });
  delete m[file];
  save(m);
  return true;
}

export const backedUpFiles = () => Object.keys(load());

export function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.agent-stack.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}
