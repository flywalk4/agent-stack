import fs from 'node:fs';
import path from 'node:path';
import { out, home, isWin } from './platform.js';
import { SERVICES, CHAINS, url } from './topology.js';
import { TARGETS } from './targets/index.js';
import { probe } from './services.js';

async function json(port, p) {
  try {
    const r = await fetch(`${url(port)}${p}`, { signal: AbortSignal.timeout(5000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

const round1 = (n) => Math.round(n * 10) / 10;

// rtk is installed into the login shell's PATH, which launchd/Task Scheduler
// jobs do not inherit — resolve the binary once from the usual locations.
const RTK_CANDIDATES = [
  process.env.RTK_BIN,
  path.join(home, '.agent-stack', 'bin', isWin ? 'rtk.exe' : 'rtk'),
  '/opt/homebrew/bin/rtk',
  '/usr/local/bin/rtk',
  path.join(home, '.cargo', 'bin', isWin ? 'rtk.exe' : 'rtk'),
  path.join(home, '.local', 'bin', 'rtk'),
].filter(Boolean);

let rtkBin;
export function rtkPath() {
  if (rtkBin === undefined) {
    rtkBin = RTK_CANDIDATES.find((f) => {
      try {
        fs.accessSync(f, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }) ?? 'rtk';
  }
  return rtkBin;
}

function rtkSummary() {
  const raw = out(rtkPath(), ['gain', '-f', 'json']);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw).summary;
    return {
      commands: s.total_commands ?? 0,
      tokensIn: s.total_input ?? 0,
      tokensOut: s.total_output ?? 0,
      tokensSaved: s.total_saved ?? 0,
      savingsPct: round1(s.avg_savings_pct ?? 0),
    };
  } catch {
    return null;
  }
}

// headroom's /stats block is a per-process view of a file both proxies rewrite
// from their own memory, and its lifetime counters freeze while requests keep
// flowing. The append-only ledger beside it is the durable one — `headroom
// savings` aggregates it, it survives restarts and concurrent writers — so the
// savings numbers come from there and /stats is only used for live state.
const LEDGER_CANDIDATES = [
  process.env.HEADROOM_SAVINGS_EVENTS_PATH,
  path.join(home, '.headroom', 'savings_events.jsonl'),
].filter(Boolean);

export function headroomLedgerPath() {
  return LEDGER_CANDIDATES.find((f) => {
    try {
      return fs.statSync(f).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round2 = (n) => Math.round(n * 100) / 100;

function headroomLedger() {
  const file = headroomLedgerPath();
  if (!file) return null;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const acc = {
    calls: 0, tokensSaved: 0, tokensBefore: 0, toolTokensSaved: 0,
    cacheReadTokens: 0, costUsd: 0, costEffectiveUsd: 0, lastAt: null, byClient: {},
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== 'object') continue;
    acc.calls += 1;
    acc.tokensSaved += num(e.saved);
    acc.tokensBefore += num(e.before);
    // The ledger stores the two savings layers so that they SUM to `saved`:
    // tool-schema deferral is already part of `saved`, never an extra.
    acc.toolTokensSaved += num(e.saved_tool_schema);
    acc.cacheReadTokens += num(e.cache?.cr);
    acc.costUsd += num(e.cost_usd);
    acc.costEffectiveUsd += num(e.cost_effective_usd);
    if (e.ts && (!acc.lastAt || e.ts > acc.lastAt)) acc.lastAt = e.ts;
    const client = typeof e.client === 'string' && e.client ? e.client : 'unknown';
    acc.byClient[client] = (acc.byClient[client] ?? 0) + 1;
  }
  if (!acc.calls) return null;
  return {
    calls: acc.calls,
    tokensSaved: acc.tokensSaved,
    tokensBefore: acc.tokensBefore,
    compressionTokens: Math.max(acc.tokensSaved - acc.toolTokensSaved, 0),
    toolTokensSaved: Math.min(acc.toolTokensSaved, acc.tokensSaved),
    cacheReadTokens: acc.cacheReadTokens,
    costUsd: round2(acc.costUsd),
    costEffectiveUsd: round2(acc.costEffectiveUsd),
    savingsPct: acc.tokensBefore ? round1((acc.tokensSaved / acc.tokensBefore) * 100) : 0,
    lastAt: acc.lastAt,
    byClient: acc.byClient,
    source: file,
  };
}

// Fallback for a host with no ledger yet: /stats lifetime counters, where
// tokens_saved is the bare message figure and tool_tokens_saved is separate.
function headroomSummary(s) {
  if (!s) return null;
  const life = s.persistent_savings?.lifetime ?? {};
  const sess = s.persistent_savings?.display_session ?? s.display_session ?? {};
  const tokensSaved = life.tokens_saved ?? s.tokens?.saved ?? 0;
  const tokensIn = life.total_input_tokens ?? s.tokens?.input ?? 0;
  const savedUsd = (life.compression_savings_usd ?? 0)
    + (life.tool_schema_savings_usd ?? 0)
    + (life.cache_savings_usd ?? 0)
    + (life.output_savings_usd ?? 0);
  return {
    requests: s.requests?.total ?? 0,
    failed: s.requests?.failed ?? 0,
    lifetimeRequests: life.requests ?? sess.requests ?? 0,
    tokensIn,
    tokensSaved,
    toolTokensSaved: life.tool_tokens_saved ?? 0,
    cacheReadTokens: life.cache_read_tokens ?? 0,
    outputTokensSaved: life.output_tokens_saved ?? 0,
    allLayersSaved: s.tokens?.all_layers_saved ?? 0,
    savedUsd: Math.round(savedUsd * 100) / 100,
    savingsPct: tokensIn ? round1((tokensSaved / tokensIn) * 100) : 0,
    // Which instance/port answered — the two proxies are separate processes.
    store: s.persistent_savings?.storage_path ?? null,
  };
}

// Every headroom instance persists into the same savings file, so their
// lifetime counters hold identical numbers: merge with max(), never sum().
export function mergeHeadroom(a, b) {
  if (!a) return b;
  if (!b) return a;
  const pick = (k) => Math.max(a[k] ?? 0, b[k] ?? 0);
  const keys = [
    'requests', 'failed', 'lifetimeRequests', 'tokensIn', 'tokensSaved', 'toolTokensSaved',
    'cacheReadTokens', 'outputTokensSaved', 'allLayersSaved', 'savedUsd', 'savingsPct',
  ];
  return {
    ...a,
    ...Object.fromEntries(keys.map((k) => [k, pick(k)])),
    savingsPct: pick('tokensIn') ? round1((pick('tokensSaved') / pick('tokensIn')) * 100) : 0,
    instances: 2,
  };
}

function biliSummary(s) {
  if (!s) return null;
  const sessions = s.sessions ?? [];
  const sum = (k) => sessions.reduce((a, x) => a + (x[k] ?? 0), 0);
  const input = sum('inputTokens');
  const cached = sum('cachedTokens');
  return {
    sessions: sessions.length,
    requests: sum('requests'),
    tokensIn: input,
    cached,
    cacheHitPct: input ? round1((cached / input) * 100) : 0,
    // Skip empty sessions (doctor probes, aborted starts).
    recent: sessions.filter((x) => x.requests > 0).slice(0, 8).map((x) => ({
      title: (x.title ?? x.id).replace(/<\/?[\w-]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80),
      upstream: x.upstream,
      requests: x.requests,
      contextTokens: x.contextTokens,
    })),
  };
}

export async function collect() {
  const ups = await Promise.all(Object.values(SERVICES).map((s) => probe(s.port, s.health)));
  const services = Object.fromEntries(Object.entries(SERVICES).map(([id, s], i) => [id, { ...s, up: ups[i] }]));
  const [hr, hrDs, bili] = await Promise.all([
    json(SERVICES.headroom.port, '/stats'),
    json(SERVICES.headroomDeepseek.port, '/stats'),
    json(SERVICES.bili.port, '/__bili/stats'),
  ]);
  const agents = TARGETS.map((t) => {
    let wired = false;
    let current = null;
    try {
      wired = t.ok();
      current = t.current();
    } catch { /* unreadable config */ }
    return { id: t.id, label: t.label, installed: t.detect(), wired, current, hops: CHAINS[t.id].hops };
  });
  const headroom = headroomSummary(hr);
  const headroomDeepseek = headroomSummary(hrDs);
  const ledger = headroomLedger();
  const liveAll = mergeHeadroom(headroom, headroomDeepseek);
  // The ledger counts both proxies and every restart, so when it exists it
  // replaces the /stats figures outright instead of merging with them.
  const headroomAll = ledger ? {
    ...liveAll,
    tokensIn: ledger.tokensBefore,
    tokensSaved: ledger.tokensSaved,
    compressionTokens: ledger.compressionTokens,
    toolTokensSaved: ledger.toolTokensSaved,
    cacheReadTokens: ledger.cacheReadTokens,
    lifetimeRequests: ledger.calls,
    savedUsd: ledger.costUsd,
    savedUsdEffective: ledger.costEffectiveUsd,
    savingsPct: ledger.savingsPct,
    lastAt: ledger.lastAt,
    store: ledger.source,
    instances: liveAll?.instances ?? 1,
  } : liveAll;
  const stats = {
    rtk: rtkSummary(),
    bili: biliSummary(bili),
    headroom,
    headroomDeepseek,
    headroomAll,
    headroomLedger: ledger,
    rtkPath: rtkPath(),
  };
  // Two different kinds of saving, kept apart on purpose:
  //  - removedTokens: never left this machine — rtk shrinks shell output and
  //    headroom compresses requests and strips tool schemas before sending.
  //    headroom's tokensSaved already contains its tool-schema half (the ledger
  //    guarantees the two layers sum to `saved`), so it must not be added twice.
  //  - cachedTokens (bili): the request did go out, but the prefix hit the
  //    provider's prompt cache, which is billed at a fraction of the normal
  //    input price (10% for Anthropic and DeepSeek). Real money, but not real
  //    tokens, so it must never be presented as "tokens not sent".
  const removedTokens = (stats.rtk?.tokensSaved ?? 0) + (stats.headroomAll?.tokensSaved ?? 0);
  const cachedTokens = stats.bili?.cached ?? 0;
  stats.removedTokens = removedTokens;
  stats.cachedTokens = cachedTokens;
  stats.biliSaved = cachedTokens;
  stats.totalSaved = removedTokens + cachedTokens;
  return { at: new Date().toISOString(), services, agents, stats };
}
