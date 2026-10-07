#!/usr/bin/env bash
# agent-stack bootstrap (macOS): ensures node + uv, then runs the interactive installer.
set -euo pipefail

REPO="${AGENT_STACK_REPO:-https://github.com/flywalk4/agent-stack.git}"
DIR="${AGENT_STACK_DIR:-$HOME/.agent-stack/app}"

need() { command -v "$1" >/dev/null 2>&1; }

if ! need brew && { ! need node || ! need uv; }; then
  echo "→ installing Homebrew"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
fi
need node || { echo "→ installing node"; brew install node; }
need uv   || { echo "→ installing uv";   brew install uv; }
node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' || { echo "node >= 20 is required"; exit 1; }

# Running from a checkout? use it; otherwise fetch the repo.
SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$SRC" ] && [ -f "$SRC/bin/agent-stack.js" ]; then
  DIR="$SRC"
elif [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only -q
else
  git clone -q --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"
npm install --omit=dev --silent
npm link --silent >/dev/null 2>&1 || true   # puts `agent-stack` on PATH
exec node bin/agent-stack.js install "$@" </dev/tty
