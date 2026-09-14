#!/usr/bin/env bash
set -u

# Runs one named git-hook step quietly: hides its output behind a per-step log
# file and only prints a short success line. On failure it shows the exit code,
# the log path and the last N lines so you can diagnose without re-running.
# If the log file cannot be created, the step streams live instead — a failed
# redirect must never masquerade as a step failure.
#
# Env switches:
#   HOOK_VERBOSE=1     stream the command's output live instead of logging it
#   HOOK_LOG_FILE=...  write this step's log to an explicit file
#   HOOK_LOG_DIR=...   directory for auto-named logs (default: $TMPDIR/<repo>-hooks)
#   HOOK_TAIL_LINES=N  how many trailing log lines to show on failure (default 80)
#
# Usage: hook-run-step.sh <label> <command> [args...]

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <label> <command> [args...]" >&2
  exit 2
fi

LABEL="$1"
shift

if [ "${HOOK_VERBOSE:-}" = "1" ]; then
  echo "▶ ${LABEL}…"
  "$@"
  exit $?
fi

LOG_FILE="${HOOK_LOG_FILE:-}"
if [ -z "$LOG_FILE" ]; then
  REPO_NAME="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
  LOG_DIR="${HOOK_LOG_DIR:-${TMPDIR:-/tmp}/${REPO_NAME}-hooks}"
  LABEL_SLUG="$(printf '%s' "$LABEL" | tr -cs '[:alnum:]' '-' | sed 's/^-*//;s/-*$//')"
  LOG_FILE="$LOG_DIR/${LABEL_SLUG:-step}-$(date +%Y%m%d%H%M%S)-$$.log"
fi

if ! mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || ! : >"$LOG_FILE" 2>/dev/null; then
  echo "⚠ ${LABEL}: nelze zapsat log (${LOG_FILE}) — streamuju výstup naživo." >&2
  echo "▶ ${LABEL}…"
  "$@"
  exit $?
fi

echo "▶ ${LABEL}…"
if "$@" >"$LOG_FILE" 2>&1; then
  echo "✓ ${LABEL}"
  exit 0
else
  STATUS=$?
fi

TAIL_LINES="${HOOK_TAIL_LINES:-80}"

echo "❌ ${LABEL} selhalo (exit ${STATUS})."
echo "   Log: ${LOG_FILE}"
echo ""
echo "── posledních ${TAIL_LINES} řádků ──"
tail -n "$TAIL_LINES" "$LOG_FILE" || true

exit "$STATUS"
