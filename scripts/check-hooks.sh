#!/usr/bin/env bash
set -euo pipefail

# Verifies the hooks are wired up and executable for this worktree.
# Useful as a doctor command (e.g. "hooks:doctor") and as a CI guard so a
# misconfigured worktree fails loudly instead of silently skipping checks.
# Checks every hook file present in .githooks/, not a hardcoded list.

ROOT=$(git rev-parse --show-toplevel)
EXPECTED="$ROOT/.githooks"
CONFIGURED=$(git config --get core.hooksPath || true)

# Accept the old absolute value while it still points at this worktree.
# Read effective config, including overrides, just as Git does when running hooks.
if [[ "$CONFIGURED" != ".githooks" && "$CONFIGURED" != "$EXPECTED" ]]; then
  echo "Cesta k hookům neodpovídá tomuto worktree." >&2
  echo "  očekáváno: .githooks nebo $EXPECTED" >&2
  echo "  nastaveno: ${CONFIGURED:-<nenastaveno>}" >&2
  echo "Spusť: bash scripts/setup-hooks.sh" >&2
  exit 1
fi

shopt -s nullglob
FOUND=""
for hook in "$EXPECTED"/*; do
  [[ -f "$hook" ]] || continue
  # Hook files have no extension; skip docs and editor droppings.
  case "$(basename "$hook")" in *.*) continue ;; esac
  if [[ ! -x "$hook" ]]; then
    echo "Hook není spustitelný: $hook" >&2
    echo "Spusť: bash scripts/setup-hooks.sh" >&2
    exit 1
  fi
  FOUND="${FOUND:+$FOUND, }$(basename "$hook")"
done

if [[ -z "$FOUND" ]]; then
  echo "V adresáři nejsou žádné hooky: $EXPECTED" >&2
  exit 1
fi

echo "Git hooky jsou správně zapojené pro tento worktree."
echo "  core.hooksPath=$CONFIGURED"
echo "  hooks: $FOUND"
