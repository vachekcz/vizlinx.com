#!/usr/bin/env bash
set -euo pipefail

# Points git at the versioned .githooks/ directory for THIS worktree.
# Worktree-scoped so each git worktree can keep its own hooks config.
# Client hooks run from the worktree root, so a relative path survives moves.
# Wire up as an npm script (e.g. "hooks:install") and call it from postinstall so
# a fresh clone is protected automatically. This script self-skips where hooks
# make no sense (CI, or no .git checkout — Docker build, npm pack), but it cannot
# self-skip when it is absent: the usual Docker layer-caching pattern copies only
# package.json + lockfile before `npm ci`, so guard the postinstall on the file
# being there. See package.json.snippet.md.

case "${CI:-}" in
  "" | false | 0) ;;
  *)
    echo "Detekováno CI — instalace Git hooků přeskočena."
    exit 0
    ;;
esac

if ! ROOT=$(git rev-parse --show-toplevel 2>/dev/null); then
  echo "Mimo Git checkout — instalace Git hooků přeskočena."
  exit 0
fi

HOOKS_DIR="$ROOT/.githooks"

if [[ ! -d "$HOOKS_DIR" ]]; then
  echo "Chybí adresář s hooky: $HOOKS_DIR" >&2
  exit 1
fi

git config extensions.worktreeConfig true
git config --worktree core.hooksPath .githooks

# Hook files have no extension; skip docs and editor droppings.
for hook in "$HOOKS_DIR"/*; do
  [[ -f "$hook" ]] || continue
  case "$(basename "$hook")" in *.*) continue ;; esac
  chmod +x "$hook"
done

echo "Git hooky nastaveny pro tento worktree:"
echo "  core.hooksPath=.githooks"
