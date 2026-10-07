import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_PATHS, home, isWin, run, out } from './platform.js';
import { backupOnce, writeAtomic } from './backup.js';

const REPO = 'JuliusBrussee/caveman';
const RULE_URL = `https://raw.githubusercontent.com/${REPO}/main/src/rules/caveman-activate.md`;
const BEGIN = '<!-- caveman-begin (agent-stack) -->';
const END = '<!-- caveman-end (agent-stack) -->';

const must = (r, what) => {
  if (r.status !== 0) throw new Error(`${what}: ${(r.stderr || r.stdout || '').trim().slice(-400)}`);
  return r;
};

// Same lookup order as caveman's own hooks (src/hooks/caveman-config.js).
function userConfigFile() {
  const dir = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, 'caveman')
    : isWin
      ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'caveman')
      : path.join(home, '.config', 'caveman');
  return path.join(dir, 'config.json');
}

// Hook-driven agents (Claude, OpenCode plugin) read defaultMode on every new
// session; anything but "off" keeps caveman always on.
export function ensureDefaultOn() {
  const f = userConfigFile();
  const c = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  if (c.defaultMode && c.defaultMode !== 'off') return;
  backupOnce(f);
  writeAtomic(f, `${JSON.stringify({ ...c, defaultMode: 'full' }, null, 2)}\n`);
}

// npm 12 refuses git-hosted packages unless explicitly allowed.
const npxGit = () => {
  const major = Number(out('npm', ['--version'])?.split('.')[0] ?? 0);
  return major >= 12 ? ['--allow-git=root', '-y'] : ['-y'];
};

// Codex has no session hook for caveman, only skills (manual /caveman), so
// the always-on rule goes into the global ~/.codex/AGENTS.md it always loads.
async function codexAlwaysOn() {
  const rule = (await (await fetch(RULE_URL)).text()).trim();
  const f = path.join(home, '.codex', 'AGENTS.md');
  backupOnce(f);
  const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  const re = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripped = text.replace(new RegExp(`\\n*${re(BEGIN)}[\\s\\S]*?${re(END)}\\n?`, 'g'), '').replace(/\n*$/, '');
  writeAtomic(f, `${stripped ? `${stripped}\n\n` : ''}${BEGIN}\n${rule}\n${END}\n`);
}

// Only the rule/hook layer: caveman's own `caveman <agent>` launcher and
// proxy would add a fourth network hop in front of bili.

const V2_BEGIN = '// --- agent-stack: OpenCode V2 support (V1 server() + V2 setup()) ---';
const V2_END = '// --- end agent-stack OpenCode V2 support ---';
const V2_BLOCK = `${V2_BEGIN}
// caveman's hooks were written for the V1 plugin API only, so on OpenCode 2.x
// (and any 1.18.29+ build that validates object entrypoints) the module
// default-exports a definition carrying both APIs: V1 calls server(), V2 calls
// setup(). The V1 hook object is built once by CavemanPlugin and reused, which
// keeps one implementation and one behaviour on both lines. Everything below
// is registered defensively: a build without the seam stays inert instead of
// breaking the host.
const CAVEMAN_V2_ID = 'caveman-opencode';

const cavemanV2Guard = (fn) => (...args) => {
  try {
    return fn(...args);
  } catch {
    return undefined;
  }
};

const CavemanPluginV2 = {
  id: CAVEMAN_V2_ID,
  server: (input, options) => CavemanPlugin(input, options),
  async setup(ctx) {
    const hooks = await CavemanPlugin(ctx);
    const controller = new AbortController();

    // V1 \`event\` -> ctx.event.subscribe()
    if (typeof hooks.event === 'function' && ctx.event && typeof ctx.event.subscribe === 'function') {
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            await cavemanV2Guard(hooks.event)({ event });
          }
        } catch {
          // stream ends when the plugin unloads
        }
      })();
    }

    // V1 \`experimental.chat.system.transform\` -> ctx.session.hook('context').
    // V2 hands out system parts ({ type: 'text', text }), V1 plain strings, so
    // the V1 hook runs over a string view and the result is written back into
    // the original parts.
    const systemHook = hooks['experimental.chat.system.transform'];
    if (typeof systemHook === 'function' && ctx.session && typeof ctx.session.hook === 'function') {
      await ctx.session.hook(
        'context',
        cavemanV2Guard((event) => {
          if (!event || !Array.isArray(event.system)) return;
          const parts = event.system;
          const view = {
            system: parts.map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : '')),
          };
          systemHook({}, view);
          for (let i = 0; i < view.system.length; i++) {
            const p = parts[i];
            if (typeof p === 'string') parts[i] = view.system[i];
            else if (p && typeof p === 'object') p.text = view.system[i];
            else parts.push({ type: 'text', text: view.system[i] });
          }
        }),
      );
    }

    // V1 \`chat.message\` -> ctx.session.hook('prompt'). The V1 hook mutates the
    // text parts in place, which is what reaches the model either way.
    const messageHook = hooks['chat.message'];
    if (typeof messageHook === 'function' && ctx.session && typeof ctx.session.hook === 'function') {
      await ctx.session.hook(
        'prompt',
        cavemanV2Guard((event) => {
          if (!event) return;
          const parts = Array.isArray(event.parts)
            ? event.parts
            : Array.isArray(event.prompt)
              ? event.prompt
              : event.message && Array.isArray(event.message.parts)
                ? event.message.parts
                : null;
          if (parts) {
            messageHook({}, { parts });
            return;
          }
          if (typeof event.prompt === 'string') {
            const wrapped = [{ type: 'text', text: event.prompt }];
            messageHook({}, { parts: wrapped });
            event.prompt = wrapped[0].text;
          }
        }),
      );
    }

    return () => controller.abort();
  },
};

export default CavemanPluginV2;
${V2_END}
`;

// Object default exports (one plugin serving both APIs) are only understood by
// OpenCode 1.18.29+ and by 2.x; older 1.x releases need the bare function, so
// the patch is version-gated and simply skipped there.
function supportsDualExport() {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(out('opencode', ['--version']) ?? '');
  if (!m) return true;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (major >= 2) return true;
  if (major === 1 && minor === 18) return patch >= 29;
  return false;
}

// Rewrites caveman's installed opencode plugin so it also runs under the V2
// plugin API. Idempotent: a previous block is removed before the new one is
// appended, and the original file is backed up on the first pass.
export function patchOpencodeForV2({ force = false } = {}) {
  const f = path.join(CONFIG_PATHS.opencodeDir, 'plugins', 'caveman', 'plugin.js');
  if (!fs.existsSync(f)) return 'not installed';
  if (!force && !supportsDualExport()) return 'skipped (opencode < 1.18.29)';

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const original = fs.readFileSync(f, 'utf8');
  const stripped = original
    .replace(new RegExp(`\\n?${esc(V2_BEGIN)}[\\s\\S]*?${esc(V2_END)}\\n?`, 'g'), '\n')
    .replace(/^export default CavemanPluginV2;\n?/m, '')
    .replace(/^export default CavemanPlugin;\n?/m, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s*$/, '');
  if (!/export const CavemanPlugin\b/.test(stripped)) return 'unsupported plugin layout';

  const patched = `${stripped}\n\n${V2_BLOCK}`;
  if (patched === original) return 'already patched';
  backupOnce(f);
  writeAtomic(f, patched);
  return 'patched';
}

// Doctor/dashboard helper: does the installed opencode plugin carry both APIs?
export function opencodeV2PatchState() {
  const f = path.join(CONFIG_PATHS.opencodeDir, 'plugins', 'caveman', 'plugin.js');
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, 'utf8').includes(V2_BEGIN) ? 'dual' : 'v1';
}

export const CAVEMAN = {
  claude() {
    ensureDefaultOn();
    run('claude', ['plugin', 'marketplace', 'add', REPO]);
    return must(run('claude', ['plugin', 'install', 'caveman@caveman']), 'claude plugin install caveman');
  },
  async codex() {
    ensureDefaultOn();
    must(run('npx', [...npxGit(), 'skills', 'add', REPO, '--skill', '*', '-a', 'codex', '--yes', '-g']), 'skills add caveman codex');
    await codexAlwaysOn();
  },
  // Native opencode plugin auto-activates and adds the AGENTS.md ruleset.
  opencode() {
    ensureDefaultOn();
    const r = must(run('npx', [...npxGit(), `github:${REPO}`, '--', '--only', 'opencode', '--non-interactive']), 'caveman install opencode');
    // caveman ships a V1-only plugin; teach the installed copy the V2 API too.
    patchOpencodeForV2();
    return r;
  },
};
