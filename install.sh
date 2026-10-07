#!/usr/bin/env bash
# agent-stack bootstrap: makes sure node + uv are present, then runs the
# installer. macOS uses Homebrew, Debian/Ubuntu use apt (no node/tooling has to
# exist beforehand). Other Linux needs node >= 20 and uv already installed.
#
#   curl -fsSL https://raw.githubusercontent.com/flywalk4/agent-stack/main/install.sh | bash
#
# Flags given to this script are passed through to `agent-stack install`,
# e.g. --yes for an unattended run.
set -euo pipefail

REPO="${AGENT_STACK_REPO:-https://github.com/flywalk4/agent-stack.git}"
DIR="${AGENT_STACK_DIR:-$HOME/.agent-stack/app}"

say()  { printf '\033[1m→ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1; }

# apt needs root; servers usually run this as root, desktops have sudo.
as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"
  elif need sudo; then sudo "$@"
  else die "need root (or sudo) for: $*"
  fi
}

node_ok() {
  if ! need node; then return 1; fi
  node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>/dev/null
}

install_uv() {
  if need uv; then return 0; fi
  say "installing uv into ~/.local/bin"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
  if ! need uv; then die "uv install failed — see https://docs.astral.sh/uv/"; fi
}

# --- macOS ------------------------------------------------------------------

setup_macos() {
  if ! need brew && { ! need node || ! need uv; }; then
    say "installing Homebrew"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
  fi
  if ! node_ok; then say "installing node"; brew install node; fi
  install_uv
  if ! node_ok; then die "node >= 20 is required"; fi
}

# --- Debian / Ubuntu --------------------------------------------------------

# Last resort when neither the distro nor NodeSource can give us node 20: the
# official static build, unpacked under ~/.local (no root involved).
install_node_tarball() {
  case "$(uname -m)" in
    x86_64 | amd64) NODE_ARCH=linux-x64 ;;
    aarch64 | arm64) NODE_ARCH=linux-arm64 ;;
    *) die "no official node build for $(uname -m)" ;;
  esac
  local sums name ver tmp
  sums="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt)" || return 1
  name="$(printf '%s\n' "$sums" | awk '{print $2}' | grep -- "-${NODE_ARCH}.tar.gz\$" | head -1)"
  if [ -z "$name" ]; then return 1; fi
  ver="${name#node-}"
  ver="${ver%-$NODE_ARCH.tar.gz}"
  say "unpacking node $ver into ~/.local/node"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/$name" "https://nodejs.org/dist/latest-v22.x/$name"
  tar -xzf "$tmp/$name" -C "$tmp"
  rm -rf "$HOME/.local/node"
  mv "$tmp/node-$ver-$NODE_ARCH" "$HOME/.local/node"
  rm -rf "$tmp"
  mkdir -p "$HOME/.local/bin"
  for b in node npm npx; do ln -sf "$HOME/.local/node/bin/$b" "$HOME/.local/bin/$b"; done
  export PATH="$HOME/.local/bin:$PATH"
}

install_node_debian() {
  if node_ok; then return 0; fi
  say "installing node from apt"
  if as_root apt-get install -y --no-install-recommends nodejs; then
    if node_ok; then return 0; fi
  fi
  say "apt node is older than 20 — adding the NodeSource repository"
  if curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/agent-stack-nodesource.sh; then
    if as_root bash /tmp/agent-stack-nodesource.sh >/dev/null; then
      if as_root apt-get install -y --no-install-recommends nodejs; then
        if node_ok; then return 0; fi
      fi
    fi
    warn "NodeSource did not provide node >= 20"
  fi
  warn "falling back to the official node tarball"
  install_node_tarball && node_ok
}

setup_debian() {
  say "installing base packages (curl, git, tar, ca-certificates)"
  as_root apt-get update -qq
  as_root apt-get install -y --no-install-recommends curl ca-certificates git tar
  if ! install_node_debian; then die "could not install node >= 20"; fi
  install_uv
  # A system-wide npm prefix needs root for every package install; keep the
  # global packages in ~/.local instead — it is also on the services' PATH.
  export npm_config_prefix="${npm_config_prefix:-$HOME/.local}"
  mkdir -p "$HOME/.local/bin"
  export PATH="$HOME/.local/bin:$PATH"
  if ! systemctl --user show-environment >/dev/null 2>&1; then
    warn "no systemd user manager for $USER yet — enable lingering so the services start at boot:"
    warn "  sudo loginctl enable-linger $USER"
  fi
}

# --- anywhere else ----------------------------------------------------------

setup_generic() {
  if ! node_ok; then die "node >= 20 is required — install it first (https://nodejs.org)"; fi
  install_uv
  if ! systemctl --user show-environment >/dev/null 2>&1; then
    warn "systemd user manager not reachable — services may not start; try: sudo loginctl enable-linger $USER"
  fi
}

# ----------------------------------------------------------------------------

case "$(uname -s)" in
  Darwin) setup_macos ;;
  Linux)
    if need apt-get; then setup_debian; else setup_generic; fi ;;
  *) die "unsupported OS: $(uname -s) — on Windows use install.ps1" ;;
esac

# Running from a checkout? use it; otherwise fetch the repo.
SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$SRC" ] && [ -f "$SRC/bin/agent-stack.js" ]; then
  DIR="$SRC"
elif [ -d "$DIR/.git" ]; then
  say "updating $DIR"
  git -C "$DIR" pull --ff-only -q
else
  say "cloning into $DIR"
  git clone -q --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"
say "installing node dependencies"
npm install --omit=dev --silent
if ! npm link --silent >/dev/null 2>&1; then
  warn "npm link failed — run the CLI as: node $DIR/bin/agent-stack.js"
fi

# The prompts need a real terminal. When this script is piped from curl, stdin is
# the script itself, so the installer borrows /dev/tty — but only if stdin is not
# already a terminal and /dev/tty can actually be opened.
if [ -n "${AGENT_STACK_NO_TTY:-}" ]; then
  exec node bin/agent-stack.js install "$@"
fi
if [ -t 0 ]; then
  exec node bin/agent-stack.js install "$@"
fi
if ( exec </dev/tty ) 2>/dev/null; then
  exec node bin/agent-stack.js install "$@" </dev/tty
fi
exec node bin/agent-stack.js install "$@"
