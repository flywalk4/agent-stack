# agent-stack

One installer for **rtk + bili (billion-context) + headroom + caveman** in front of
**Claude Code**, **Codex**, **OpenCode** and **DeepSeek Harness**. macOS and Windows.

Every request from those agents is routed through a local proxy chain that removes tokens
before they ever reach a provider — shell output, tool results and tool schemas — while
keeping the prompt prefix stable so the provider's own cache keeps hitting.

```
agent  →  rtk  →  bili  →  headroom  →  provider
          │       │         │
          │       │         └─ per-request compression (tool results / schemas)
          │       └─ session context folding, prefix-cache aware
          └─ shrinks shell output inside the agent (hooks / rules / skills)
```

## Quick start

```bash
# macOS
./install.sh
# or
curl -fsSL https://raw.githubusercontent.com/flywalk4/agent-stack/main/install.sh | bash
```

```powershell
# Windows (PowerShell 5.1+)
.\install.ps1
# or
irm https://raw.githubusercontent.com/flywalk4/agent-stack/main/install.ps1 | iex
```

The bootstrap installs node / uv (brew / winget), then runs the interactive installer:

1. **Install / update** or **Uninstall** — asked first, so a fresh checkout can also be used to tear down.
2. Which agents to wire up — <kbd>space</kbd> selects, <kbd>enter</kbd> continues.
3. Which layers to install — same keys.
4. A plan summary, then a confirmation.

Non-interactive: `agent-stack install --yes` takes every detected agent and every layer.
Interactive prompts need a TTY; without one the installer exits with a hint instead of hanging.

## Commands

| Command | What it does |
|---|---|
| `agent-stack install [--yes]` | Interactive setup (also what runs with no command). Asks install or uninstall. |
| `agent-stack doctor [--json]` | Services, agent configs and end-to-end chain probes. Exit code 1 if anything is down. |
| `agent-stack dashboard` | Opens the shared dashboard at <http://127.0.0.1:18800>. |
| `agent-stack uninstall` | Removes the services and restores every changed config from the backups. |

## Chains

| Agent | Chain |
|---|---|
| Claude Code | rtk → bili `:18788` → headroom `:8787` → api.anthropic.com |
| Codex | rtk → bili `:18788` → headroom `:8787` → chatgpt.com / api.openai.com (HTTP, no WS) |
| OpenCode | rtk → bili-native (in-process) → headroom transport plugin → `:8787` → provider |
| DeepSeek Harness | rtk → bili-native (dsh bundle) → headroom `:8788` → api.deepseek.com |

Why it is wired this way:

- **bili before headroom.** bili keeps a stable prefix (prompt cache); headroom runs in
  `cache` mode, compresses only the delta and never busts that prefix.
- **rtk and caveman live inside the agent** (hooks, rules, skills), they are not network hops.
  caveman's own launcher/proxy (`caveman claude`) is deliberately not installed — it would add
  a fourth network hop.
- **Codex without WebSocket.** On the WS transport bili and headroom both rewrite
  `previous_response_id`, and Codex fails with `previous_response_not_found`.
- **A separate headroom for DeepSeek** (`--openai-api-url https://api.deepseek.com`) so
  Codex's OpenAI traffic never lands on DeepSeek.

## Services

- **macOS** — launchd user agents `dev.agent-stack.*` in `~/Library/LaunchAgents`,
  logs in `~/Library/Logs/agent-stack/`. Each plist carries an explicit `PATH`
  (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.cargo/bin`, …) so jobs
  started by launchd can still find brew/cargo/uv binaries such as `rtk`.
- **Windows** — Task Scheduler tasks `agent-stack-*`, started at logon, hidden window,
  auto-restart. Logs in `%USERPROFILE%\.agent-stack\logs`.

Hand-made `bili` / `headroom` launchd agents that would fight for the ports are detected
and renamed to `*.plist.disabled-by-agent-stack` during install.

`launchctl bootstrap` can report `Bootstrap failed: 5: Input/output error` even though the
job loads: launchd tears the old job down asynchronously and it stays visible to
`launchctl print` for a moment. The installer therefore waits for the label to really
disappear before bootstrapping, retries the pair if needed, and confirms the job is still
loaded before reporting success — a bare "is it loaded?" check would mistake the dying old
job for the new one and silently leave the service down.

## Dashboard

<http://127.0.0.1:18800> — served by the `dev.agent-stack.dashboard` service.

- Saved tokens per layer: rtk (shell output), bili (prefix served from the provider's
  cache), headroom (compression + tool schemas), plus the combined total and the USD figure.
  - rtk and headroom save tokens by never sending them.
  - bili saves them by keeping the prefix stable so the provider's prompt cache keeps
    hitting; those tokens are billed at roughly a tenth of the normal input price.
  The total adds both, and breaks them down underneath.
- Agent chains with live hop health, service status and a one-click `e2e` probe that
  sends a bogus-key request through the whole chain (a provider-shaped `401` means the
  chain works and no tokens were spent).
- Recent bili sessions.

The UI is **English by default** with an **RU** toggle in the header (`localStorage`, per browser).

## Backups and uninstall

Every config agent-stack touches is copied **once** to `~/.agent-stack/backups`
(with a `manifest.json`) before the first change, so the backup always holds the state
from before agent-stack. `agent-stack uninstall` removes the services and puts those
files back. The tools themselves (rtk / bili / headroom) are left installed.

## Requirements

- macOS or Windows (on Linux only the config files are written, services are skipped)
- Node.js ≥ 20, uv, git
- brew (macOS) / winget (Windows) — used by the bootstrap when something is missing

## Repository layout

```
bin/agent-stack.js     CLI entry point
src/install.js         interactive installer and uninstaller
src/topology.js        ports, service definitions and each agent's chain (single source of truth)
src/services.js        launchd / Task Scheduler service management
src/status.js          stats collection for the dashboard and doctor
src/doctor.js          service, config and end-to-end checks
src/tools.js           rtk / bili / headroom install and agent-side add-ons
src/caveman.js         caveman rules, hooks and skills
src/targets/*.js       per-agent config writers (claude, codex, opencode, dsh)
src/dashboard/         dashboard HTTP server and its single-page UI
```
