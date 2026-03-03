#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="$HOME/.pi/agent"

mkdir -p "$PI_DIR"

link() {
  local src="$REPO_DIR/$1"
  local dst="$PI_DIR/$1"
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
    echo "  already linked: $1"
  else
    ln -sf "$src" "$dst"
    echo "  linked: $1 -> $dst"
  fi
}

echo "Linking pi config files into $PI_DIR ..."
link keybindings.json

echo "Done."
