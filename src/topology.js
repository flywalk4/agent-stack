// Single source of truth for how the proxies are wired.
//
// Order of layers for every client:
//   rtk (inside agent: shrinks shell output before it enters context)
//   → bili (billion-context: session-level context folding, prefix-cache aware)
//   → headroom (per-request compression of tool results / schemas)
//   → upstream provider
//
// bili goes first so its folds are what headroom sees; headroom runs in
// `cache` mode (delta-only), so it never busts the prefix bili keeps stable.

export const PORTS = {
  bili: 18788,
  headroom: 8787,
  headroomDeepseek: 8788,
  dashboard: 18800,
};

const host = '127.0.0.1';
export const url = (port) => `http://${host}:${port}`;
export const biliPrefix = (upstream) => `${url(PORTS.bili)}/bili/${upstream}`;

export const SERVICES = {
  bili: {
    label: 'bili (billion-context)',
    port: PORTS.bili,
    health: '/__bili/health',
  },
  headroom: {
    label: 'headroom (Anthropic + OpenAI)',
    port: PORTS.headroom,
    health: '/health',
  },
  headroomDeepseek: {
    label: 'headroom (DeepSeek)',
    port: PORTS.headroomDeepseek,
    health: '/health',
    upstream: 'https://api.deepseek.com',
  },
  dashboard: {
    label: 'agent-stack dashboard',
    port: PORTS.dashboard,
    health: '/api/ping',
  },
};

// Chains per client. `hops` are what the dashboard draws and doctor probes.
export const CHAINS = {
  claude: {
    label: 'Claude Code',
    hops: ['rtk', 'bili', 'headroom', 'api.anthropic.com'],
    baseUrl: biliPrefix(url(PORTS.headroom)),
  },
  codex: {
    label: 'Codex',
    hops: ['rtk', 'bili', 'headroom', 'chatgpt.com / api.openai.com'],
    baseUrl: biliPrefix(`${url(PORTS.headroom)}/v1`),
    // bili + headroom both rewrite previous_response_id on the WS transport
    // (→ previous_response_not_found), so codex must use plain HTTP.
    websockets: false,
  },
  opencode: {
    label: 'OpenCode',
    // bili as in-process native plugin; headroom's transport plugin then
    // catches every outbound request (also the ChatGPT-OAuth one).
    hops: ['rtk', 'bili-native', 'headroom', 'provider'],
  },
  dsh: {
    label: 'DeepSeek Harness',
    // bili runs in-process in dsh (bili-native plugin), so no bili hop here.
    hops: ['rtk', 'bili-native', 'headroom-deepseek', 'api.deepseek.com'],
    inferenceOrigin: url(PORTS.headroomDeepseek),
  },
};
