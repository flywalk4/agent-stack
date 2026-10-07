import { collect } from './status.js';
import { CHAINS, PORTS, url } from './topology.js';

// End-to-end probes with a bogus key: a provider-shaped 401 proves the request
// walked the whole chain and reached the real upstream, without spending tokens.
const PROBES = {
  claude: {
    url: `${CHAINS.claude.baseUrl}/v1/messages`,
    headers: { 'x-api-key': 'agent-stack-probe', 'anthropic-version': '2023-06-01' },
    body: { model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
  },
  codex: {
    url: `${CHAINS.codex.baseUrl}/responses`,
    // bili refuses Responses requests without a conversation identity.
    headers: { authorization: 'Bearer agent-stack-probe', 'x-session-id': 'agent-stack-probe' },
    body: { model: 'gpt-4.1-mini', input: 'hi', max_output_tokens: 16 },
  },
  dsh: {
    url: `${url(PORTS.headroomDeepseek)}/v1/chat/completions`,
    headers: { authorization: 'Bearer agent-stack-probe' },
    body: { model: 'deepseek-chat', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
  },
};

export async function probeChain(id) {
  const pr = PROBES[id];
  if (!pr) return { ok: null, detail: 'нет сетевого пробника (in-process плагины)' };
  try {
    const r = await fetch(pr.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...pr.headers },
      body: JSON.stringify(pr.body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = (await r.text()).slice(0, 160).replace(/\s+/g, ' ');
    // 401/403 with a provider error body = reached upstream.
    const ok = (r.status === 401 || r.status === 403) && /auth|api.key|invalid|incorrect/i.test(text);
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

  console.log('\nСервисы');
  for (const [id, v] of Object.entries(s.services)) console.log(`  ${mark(v.up)} ${v.label.padEnd(32)} :${v.port}  (${id})`);
  console.log('\nАгенты');
  for (const a of s.agents) {
    if (!a.installed) {
      console.log(`  · ${a.label} — не найден`);
      continue;
    }
    console.log(`  ${mark(a.wired)} ${a.label}: ${a.hops.join(' → ')}`);
    console.log(`      конфиг: ${a.current ?? '—'}`);
    console.log(`      e2e:    ${mark(probes[a.id].ok)} ${probes[a.id].detail}`);
  }
  const { rtk, bili, headroom } = s.stats;
  console.log('\nЭкономия');
  if (rtk) console.log(`  rtk:      ${rtk.tokensSaved.toLocaleString()} ток. (${rtk.savingsPct}%) за ${rtk.commands} команд`);
  if (bili) console.log(`  bili:     ${bili.sessions} сессий, cache hit ${bili.cacheHitPct}%`);
  if (headroom) console.log(`  headroom: ${headroom.tokensSaved.toLocaleString()} ток. (${headroom.savingsPct}%) за ${headroom.requests} запросов`);
  const bad = Object.values(s.services).some((v) => !v.up) || s.agents.some((a) => a.installed && probes[a.id].ok === false);
  process.exitCode = bad ? 1 : 0;
}
