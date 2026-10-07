import { out } from './platform.js';
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

function headroomSummary(s) {
  if (!s) return null;
  return {
    requests: s.requests?.total ?? 0,
    failed: s.requests?.failed ?? 0,
    byProvider: s.requests?.by_provider ?? {},
    tokensIn: s.tokens?.input ?? 0,
    tokensSaved: s.tokens?.saved ?? 0,
    savingsPct: s.tokens?.savings_percent ?? 0,
    costWithout: s.summary?.cost?.without_headroom_usd ?? null,
    costWith: s.summary?.cost?.with_headroom_usd ?? null,
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
    cacheHitPct: input ? Math.round((cached / input) * 1000) / 10 : 0,
    // Skip empty sessions (doctor probes, aborted starts).
    recent: sessions.filter((x) => x.requests > 0).slice(0, 8).map((x) => ({
      title: (x.title ?? x.id).replace(/<\/?[\w-]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80),
      upstream: x.upstream,
      requests: x.requests,
      contextTokens: x.contextTokens,
    })),
  };
}

function rtkSummary() {
  const raw = out('rtk', ['gain', '-f', 'json']);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw).summary;
    return {
      commands: s.total_commands,
      tokensIn: s.total_input,
      tokensSaved: s.total_saved,
      savingsPct: Math.round(s.avg_savings_pct * 10) / 10,
    };
  } catch {
    return null;
  }
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
  return {
    at: new Date().toISOString(),
    services,
    agents,
    stats: {
      rtk: rtkSummary(),
      bili: biliSummary(bili),
      headroom: headroomSummary(hr),
      headroomDeepseek: headroomSummary(hrDs),
    },
  };
}
