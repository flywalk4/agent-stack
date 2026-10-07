import { collect } from './status.js';
import { opencodeV2PatchState } from './caveman.js';
import { headroomWrapperState } from './targets/opencode.js';
import { CHAINS, PORTS, url } from './topology.js';

// End-to-end probes with a bogus key: a provider-shaped 401 proves the request
// walked the whole chain and reached the real upstream, without spending tokens.
// `expect` pins the provider: a chain that silently forwards to the wrong
// upstream also answers 401, only with a different provider's wording.
const PROBES = {
  claude: {
    url: `${CHAINS.claude.baseUrl}/v1/messages`,
    headers: { 'x-api-key': 'agent-stack-probe', 'anthropic-version': '2023-06-01' },
    body: { model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
    expect: /invalid x-api-key/i,
  },
  codex: {
    url: `${CHAINS.codex.baseUrl}/responses`,
    // bili refuses Responses requests without a conversation identity.
    headers: { authorization: 'Bearer agent-stack-probe', 'x-session-id': 'agent-stack-probe' },
    body: { model: 'gpt-4.1-mini', input: 'hi', max_output_tokens: 16 },
    expect: /incorrect api key|api\.openai\.com/i,
  },
  dsh: {
    // The harness speaks Anthropic Messages to headroom, so probe that path —
    // headroom's OpenAI-compatible one (/v1/chat/completions) is a different
    // forwarder and proves nothing about the route the app uses.
    url: `${url(PORTS.headroomDeepseek)}/v1/messages`,
    headers: { 'x-api-key': 'agent-stack-probe', 'anthropic-version': '2023-06-01' },
    body: { model: 'deepseek-chat', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
    expect: /authentication fails|deepseek/i,
  },
};

export async function probeChain(id) {
  const pr = PROBES[id];
  if (!pr) return { ok: null, detail: 'no network probe (in-process plugin)' };
  try {
    const r = await fetch(pr.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...pr.headers },
      body: JSON.stringify(pr.body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = (await r.text()).slice(0, 160).replace(/\s+/g, ' ');
    // 401/403 with a provider error body = reached upstream.
    const ok = (r.status === 401 || r.status === 403)
      && /auth|api.key|invalid|incorrect/i.test(text)
      && (!pr.expect || pr.expect.test(text));
    return { ok, detail: `${r.status} ${text}` };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

const mark = (v) => (v === null ? '·' : v ? '✓' : '✗');

export async function doctor({ json = false } = {}) {
  const s = await collect();
  const probes = {};
  await Promise.all(s.agents.map(async (a) => { probes[a.id] = await probeChain(a.id); }));
  if (json) return console.log(JSON.stringify({ ...s, probes }, null, 2));

  console.log('\nServices');
  for (const [id, v] of Object.entries(s.services)) console.log(`  ${mark(v.up)} ${v.label.padEnd(32)} :${v.port}  (${id})`);
  console.log('\nAgents');
  for (const a of s.agents) {
    if (!a.installed) {
      console.log(`  · ${a.label} — not found`);
      continue;
    }
    console.log(`  ${mark(a.wired)} ${a.label}: ${a.hops.join(' → ')}`);
    console.log(`      config: ${a.current ?? '—'}`);
    console.log(`      e2e:    ${mark(probes[a.id].ok)} ${probes[a.id].detail}`);
    const cavemanPlugin = a.id === 'opencode' ? opencodeV2PatchState() : null;
    if (cavemanPlugin === 'dual') console.log('      caveman: plugin runs on both plugin APIs (V1 server() + V2 setup())');
    else if (cavemanPlugin === 'v1') console.log(`      caveman: ${mark(false)} V1-only plugin — re-run install to add V2 support`);
    const headroomPlugin = a.id === 'opencode' ? headroomWrapperState() : null;
    if (headroomPlugin === 'dual') console.log('      headroom: transport wrapper runs on both plugin APIs');
    else if (headroomPlugin === 'v1') console.log(`      headroom: ${mark(false)} V1-only wrapper — re-run install to add V2 support`);
  }
  const { rtk, bili, headroomAll, headroomLedger } = s.stats;
  const n = (v) => v.toLocaleString('en-US');
  console.log('\nSavings');
  if (rtk) console.log(`  rtk:      ${n(rtk.tokensSaved)} tokens (${rtk.savingsPct}%) over ${n(rtk.commands)} commands`);
  else console.log(`  rtk:      no data (no rtk binary at ${s.stats.rtkPath})`);
  if (bili) console.log(`  bili:     ${n(bili.cached)} tokens saved via cache (${bili.cacheHitPct}% of ${n(bili.tokensIn)} in, ${n(bili.sessions)} sessions)`);
  if (headroomAll) {
    console.log(`  headroom: ${n(headroomAll.tokensSaved)} tokens saved (${headroomAll.savingsPct}% of ${n(headroomAll.tokensIn)} in) over ${n(headroomAll.lifetimeRequests)} requests`);
    console.log(`            of which tool schemas ${n(headroomAll.toolTokensSaved)} · cache reads ${n(headroomAll.cacheReadTokens)}`
      + ` · $${headroomAll.savedUsdEffective ?? headroomAll.savedUsd} saved`
      + (headroomAll.savedUsdEffective ? ` ($${headroomAll.savedUsd} at list prices)` : ''));
    console.log(`            source: ${headroomLedger ? headroomLedger.source : 'proxy /stats (no ledger yet)'}`);
  } else console.log('  headroom: no data (no ledger and no proxy answering /stats)');
  if (s.stats.totalSaved) {
    console.log(`  saved:    ${n(s.stats.totalSaved)} tokens saved (rtk + headroom ${n(s.stats.removedTokens)}, bili cache ${n(s.stats.cachedTokens)})`);
    console.log('            bili\'s share is served from the provider prompt cache, billed at about a tenth of full price');
  }
  const bad = Object.values(s.services).some((v) => !v.up) || s.agents.some((a) => a.installed && probes[a.id].ok === false);
  process.exitCode = bad ? 1 : 0;
}
