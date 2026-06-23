#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# SessionStart hook: record HEAD at session start so the Stop hook
# (docs-sync-reminder.sh) can scope "what changed" to THIS session's commits
# rather than the whole branch.
#
# State lives under .git/claude-docs-hook/<session_id>.base — inside .git, so it
# is never tracked and never dirties the working tree. Markers older than 7 days
# are pruned. Failures are silent (never block session start).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

command -v git >/dev/null 2>&1 || exit 0
command -v jq  >/dev/null 2>&1 || exit 0

sid="$(cat | jq -r '.session_id // empty' 2>/dev/null || true)"
[ -z "$sid" ] && exit 0

root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
dir="$root/.git/claude-docs-hook"
mkdir -p "$dir" 2>/dev/null || exit 0

# Prune stale markers so they don't accumulate.
find "$dir" -type f -mtime +7 -delete 2>/dev/null || true

git -C "$root" rev-parse HEAD > "$dir/${sid}.base" 2>/dev/null || true
exit 0
