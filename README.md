# agent-stack

One installer for **rtk + bili (billion-context) + headroom + caveman** in front of
**Claude Code**, **Codex**, **OpenCode** and **DeepSeek Harness**. macOS, Linux (systemd)
and Windows.

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

```bash
# Debian / Ubuntu — same script, apt path (node, uv and git are installed for you)
curl -fsSL https://raw.githubusercontent.com/flywalk4/agent-stack/main/install.sh | bash
# unattended (no prompts, every detected agent + layer)
curl -fsSL https://raw.githubusercontent.com/flywalk4/agent-stack/main/install.sh | bash -s -- --yes
```

```powershell
# Windows (PowerShell 5.1+)
.\install.ps1
# or
irm https://raw.githubusercontent.com/flywalk4/agent-stack/main/install.ps1 | iex
```

The bootstrap installs node / uv (brew on macOS, apt on Debian/Ubuntu, winget on Windows),
then runs the interactive installer:

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
- **OpenCode is wired with a directory, not a file.** OpenCode V2 silently drops a configured
  `.js` path (`configured plugin path must be a directory`) and resolves a plugin directory
  through its own `package.json`. agent-stack therefore generates
  `~/.config/opencode/plugins/agent-stack-headroom/` — a wrapper around the transport plugin
  headroom ships inside its uv tool — and points the config at that directory, which the V1 line
  loads just as well. Legacy `…/plugins/<name>/<file>.js` entries are rewritten to their
  parent directory, and the entry is written back into whichever key the config already uses
  (`plugins` on V2-line configs, `plugin` otherwise).
- **Both plugins are dual-API (V1 `server()` + V2 `setup()`).** Upstream ships headroom's
  transport and caveman's plugin for the V1 hook API only, so agent-stack adapts both: the
  generated headroom wrapper default-exports `{ id, server, setup }`, and caveman's installed
  `plugin.js` is patched to the same shape. On the V1 line the plugin object is loaded through
  more than one lane (1.18.29+ calls `server()`, its native lane calls `setup()`), so the wrapper
  installs the fetch transport exactly once per process and releases it once, and every V2
  registration is guarded by a `typeof ctx.x?.y === 'function'` check so a build without that
  seam stays inert instead of crashing. `agent-stack doctor` reports both
  (`caveman: plugin runs on both plugin APIs`, `headroom: transport wrapper runs on both plugin
  APIs`); a caveman self-update overwrites `plugin.js`, and the next `agent-stack install`
  re-applies the patch.
- **Codex without WebSocket.** On the WS transport bili and headroom both rewrite
  `previous_response_id`, and Codex fails with `previous_response_not_found`.
- **A separate headroom for DeepSeek** (`--openai-api-url https://api.deepseek.com`
  `--anthropic-api-url https://api.deepseek.com/anthropic`) so Codex's OpenAI traffic never
  lands on DeepSeek. Both upstreams are needed: the harness speaks Anthropic Messages, and
  without the Anthropic URL headroom would forward DeepSeek keys and payloads to
  api.anthropic.com.
- **DeepSeek Harness is patched, not reconfigured.** Its profile
  (`~/.dsh/profiles/<name>/cordis.patch.yml`) gets one entry per mounted DeepSeek route —
  `llm-deepseek` (`baseURL`, the api-key / `deepseek-official` route) and
  `llm-deepseek-account` (`inferenceOrigin`, the platform-account route) — both pointed at
  headroom `:8788`. Neither endpoint is in the profile's settings storage, so this patch layer
  is the only place that can redirect the route. The patch is written idempotently (the old
  `deepseek-account` entry and any stray markers are scrubbed) and the harness picks it up
  without a restart.

## Services

- **macOS** — launchd user agents `dev.agent-stack.*` in `~/Library/LaunchAgents`,
  logs in `~/Library/Logs/agent-stack/`. Each plist carries an explicit `PATH`
  (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.cargo/bin`, …) so jobs
  started by launchd can still find brew/cargo/uv binaries such as `rtk`.
- **Linux** — systemd user units `dev-agent-stack-<name>.service` in
  `~/.config/systemd/user/`, enabled with `systemctl --user enable --now`, logs appended to
  `~/.agent-stack/logs/<name>.log` (and mirrored into the journal, `SyslogIdentifier=agent-stack-<name>`).
  The unit sets the same explicit `PATH` plus each service's own environment (e.g. the
  DeepSeek proxy's separate `HEADROOM_SAVINGS_PATH`), restarts on failure, and stops with
  `SIGTERM`/20 s so bili can flush its sessions. On a server, enable lingering once so the
  units survive logout and start at boot:
  ```bash
  sudo loginctl enable-linger "$USER"      # then: systemctl --user status dev-agent-stack-bili
  journalctl --user -u dev-agent-stack-headroom -f
  ```
  When the installer runs as root (a container or a root shell without a user manager) it
  writes system-wide units to `/etc/systemd/system/` instead. `uninstall` removes whichever
  scope it finds.
- **Windows** — Task Scheduler tasks `agent-stack-*`, started at logon, hidden window,
  auto-restart. Logs in `%USERPROFILE%\.agent-stack\logs`.

Hand-made `bili` / `headroom` services that would fight for the ports (launchd agents or
systemd units, user and system scope) are detected and renamed to
`*.disabled-by-agent-stack` during install.

`launchctl bootstrap` can report `Bootstrap failed: 5: Input/output error` even though the
job loads: launchd tears the old job down asynchronously and it stays visible to
`launchctl print` for a moment. The installer therefore waits for the label to really
disappear before bootstrapping, retries the pair if needed, and confirms the job is still
loaded before reporting success — a bare "is it loaded?" check would mistake the dying old
job for the new one and silently leave the service down.

### Linux troubleshooting

| Symptom | Fix |
|---|---|
| `systemd user manager is not reachable` | `sudo loginctl enable-linger "$USER"`, log in again, re-run `agent-stack install` |
| Services disappear after logout | lingering is off: `loginctl show-user "$USER" --property=Linger` |
| Container without systemd | run the installer as root — it falls back to system units in `/etc/systemd/system` |
| A service does not come up | `systemctl --user status dev-agent-stack-bili`, `journalctl --user -u dev-agent-stack-bili -n 50` |
| `npm i -g billion-context` needs a compiler | `sudo apt-get install -y build-essential python3` |
| `rtk: command not found` inside a service | the unit's `PATH` includes `~/.agent-stack/bin`; check `agent-stack doctor` reports the rtk path it uses |

## Dashboard

<http://127.0.0.1:18800> — served by the dashboard service (`dev.agent-stack.dashboard` on
macOS, `dev-agent-stack-dashboard` under systemd).

- Saved tokens per layer: rtk (shell output), bili (prefix served from the provider's
  cache), headroom (compression + deferred tool schemas), plus the combined total and the
  USD figure.
  - rtk and headroom save tokens by never sending them. headroom's tool-schema share is
    shown as a nested row, because the ledger stores its two layers so that they *sum*
    to the total rather than stacking on top of it.
  - bili saves them by keeping the prefix stable so the provider's prompt cache keeps
    hitting; those tokens are billed at roughly a tenth of the normal input price.
  The total adds both, and breaks them down underneath.
- headroom's numbers come from its durable savings ledger
  (`~/.headroom/savings_events.jsonl`, the file `headroom savings` aggregates), not from
  the `/stats` counters: those live in `~/.headroom/proxy_savings.json`, are rewritten
  wholesale by whichever proxy saves last, and freeze while requests keep flowing. Each
  proxy gets its own `HEADROOM_SAVINGS_PATH`; the append-only ledger stays shared.
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

- macOS, Debian/Ubuntu (anything with a systemd user manager) or Windows
- Node.js ≥ 20, uv, git — installed by the bootstrap when missing
- brew (macOS) / apt (Debian, Ubuntu) / winget (Windows) for the dependencies

## Repository layout

```
bin/agent-stack.js     CLI entry point
install.sh             bootstrap for macOS / Debian / Ubuntu (node + uv, then the installer)
install.ps1            bootstrap for Windows
src/install.js         interactive installer and uninstaller
src/topology.js        ports, service definitions and each agent's chain (single source of truth)
src/services.js        launchd / systemd / Task Scheduler service management
src/status.js          stats collection for the dashboard and doctor
src/doctor.js          service, config and end-to-end checks
src/tools.js           rtk / bili / headroom install and agent-side add-ons
src/caveman.js         caveman rules, hooks and skills
src/targets/*.js       per-agent config writers (claude, codex, opencode, dsh)
src/dashboard/         dashboard HTTP server and its single-page UI
```
