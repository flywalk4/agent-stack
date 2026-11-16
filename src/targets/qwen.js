import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_PATHS, STATE_DIR, which } from '../platform.js';
import { CHAINS, PORTS, url } from '../topology.js';
import { backupOnce, restore, writeAtomic } from '../backup.js';

const file = CONFIG_PATHS.qwenSettings;
const HEADER = 'x-headroom-base-url';
const CHAIN = CHAINS.qwen.baseUrl;
const PROVIDER_CHAIN = CHAINS.qwen.providerBaseUrl;
const STATE = path.join(STATE_DIR, 'qwen-upstream.json');

const isChained = (base) => typeof base === 'string' && base.startsWith(`${url(PORTS.bili)}/bili/`);
const isProviderChain = (base) => base === PROVIDER_CHAIN;

const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));

const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return null;
  }
};

const writeState = (state) => writeAtomic(STATE, `${JSON.stringify(state, null, 2)}\n`);

// Routes Qwen can dial: every modelProviders[] entry that names a baseUrl, plus
// the legacy `model.baseUrl` fallback. A model whose entry omits baseUrl uses
// the provider default, which we cannot know here and therefore leave alone.
export function routes(settings) {
  const out = [];
  const providers = settings.modelProviders;
  if (providers && typeof providers === 'object') {
    for (const models of Object.values(providers)) {
      if (!Array.isArray(models)) continue;
      for (const model of models) {
        if (model && typeof model.baseUrl === 'string') out.push(model);
      }
    }
  }
  if (settings.model && typeof settings.model.baseUrl === 'string') out.push(settings.model);
  return out;
}

// Qwen's newer custom-provider registry (`providers`) has no per-route headers,
// so its selected provider needs a dedicated headroom instance with a pinned
// upstream. `model.name` is `provider/model`, which names the provider.
function activeProvider(settings) {
  const providers = settings.providers;
  const name = typeof settings.model?.name === 'string' ? settings.model.name : '';
  const id = name.includes('/') ? name.slice(0, name.indexOf('/')) : '';
  if (!providers || typeof providers !== 'object' || !id) return null;
  const provider = providers[id];
  if (!provider || typeof provider.baseUrl !== 'string') return null;
  return { id, provider, baseUrl: provider.baseUrl };
}

// Resolves the upstream for the dedicated Qwen headroom service. During the
// first install the settings still hold the original gateway; after that the
// original is kept in the state file because baseUrl now names the chain.
export function qwenHeadroomUpstream() {
  const state = readState();
  if (state && typeof state.upstream === 'string') return state.upstream;
  if (!fs.existsSync(file)) return null;
  try {
    const active = activeProvider(read());
    if (!active || isChained(active.baseUrl)) return null;
    return active.baseUrl;
  } catch {
    return null;
  }
}

function wire(model) {
  const generation = model.generationConfig && typeof model.generationConfig === 'object'
    ? model.generationConfig
    : (model.generationConfig = {});
  const headers = generation.customHeaders && typeof generation.customHeaders === 'object'
    ? generation.customHeaders
    : (generation.customHeaders = {});

  // Re-runs see the chain URL in baseUrl, so the real gateway is remembered in
  // the header that headroom already understands. Without it, headroom would
  // forward every Qwen request to its default OpenAI upstream.
  const upstream = headers[HEADER] || model.baseUrl;
  if (isChained(upstream)) return false;
  headers[HEADER] = upstream;
  model.baseUrl = CHAIN;
  return true;
}

export default {
  id: 'qwen',
  label: CHAINS.qwen.label,
  detect: () => Boolean(which('qwen')) || fs.existsSync(file),

  current() {
    if (!fs.existsSync(file)) return null;
    try {
      const settings = read();
      const active = activeProvider(settings);
      if (active && isProviderChain(active.baseUrl)) return PROVIDER_CHAIN;
      return routes(settings).some((model) => isChained(model.baseUrl)) ? CHAIN : null;
    } catch {
      return null;
    }
  },

  apply() {
    if (!fs.existsSync(file)) {
      throw new Error(`Qwen Code settings not found at ${file}; start Qwen Code once, then re-run install`);
    }
    backupOnce(file);
    const settings = read();
    const all = routes(settings);
    const active = activeProvider(settings);
    if (!all.length && !active) {
      throw new Error('no modelProviders/model.baseUrl route to wire; configure a model in Qwen Code first');
    }
    for (const model of all) wire(model);

    if (active) {
      if (!isProviderChain(active.baseUrl)) {
        // Keep the real gateway before baseUrl starts naming the local chain.
        writeState({ providerId: active.id, upstream: active.baseUrl });
        active.provider.baseUrl = PROVIDER_CHAIN;
      } else if (!readState()?.upstream) {
        // Already chained but the state file is gone: the shared routes still
        // carry their original gateway in a header, which is the same host in
        // every stock Qwen setup.
        const upstream = all.map((model) => model.generationConfig?.customHeaders?.[HEADER]).find(Boolean);
        if (upstream) writeState({ providerId: active.id, upstream });
      }
    }

    writeAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
  },

  revert() {
    const done = restore(file);
    fs.rmSync(STATE, { force: true });
    return done;
  },

  ok() {
    if (!fs.existsSync(file)) return false;
    try {
      const settings = read();
      const all = routes(settings);
      if (!all.length) return false;
      if (!all.every((model) => model.baseUrl === CHAIN
        && Boolean(model.generationConfig?.customHeaders?.[HEADER]))) return false;
      const active = activeProvider(settings);
      return !active || (isProviderChain(active.baseUrl) && Boolean(qwenHeadroomUpstream()));
    } catch {
      return false;
    }
  },
};
