#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Stop hook: keep the Markdown docs in sync with code changes.
#
# Fires when Claude finishes a turn. If this session changed code in a
# "documented" area (routes/ lib/ shared/ public/js/ prisma/schema.prisma /
# server.ts / app.ts) but touched NO Markdown file, it blocks the stop once and
# asks Claude to update the relevant doc(s) — or to confirm none are needed —
# before finishing. A stop_hook_active guard prevents an infinite loop.
#
# Repo-agnostic: it locates the repo via `git rev-parse`, so the same script
# works dropped into ~/.claude/hooks/ for every project, or committed per-repo.
#
# Testing escape hatch: set CLAUDE_DOCS_HOOK_TEST_FILES to a newline-separated
# file list to bypass git and exercise the classification logic directly.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

input="$(cat)"

# Don't loop: if we already blocked once this stop-cycle, allow the stop.
if printf '%s' "$input" | jq -e '.stop_hook_active == true' >/dev/null 2>&1; then
  exit 0
fi

if [ -n "${CLAUDE_DOCS_HOOK_TEST_FILES:-}" ]; then
  changed="$CLAUDE_DOCS_HOOK_TEST_FILES"
else
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
  cd "$root" || exit 0
  # Fork point with the default branch, so committed session work counts too.
  base="$(git merge-base HEAD origin/main 2>/dev/null \
        || git merge-base HEAD main 2>/dev/null || true)"
  changed="$(
    {
      git diff --name-only 2>/dev/null || true            # unstaged
      git diff --name-only --cached 2>/dev/null || true   # staged
      git ls-files --others --exclude-standard 2>/dev/null || true  # untracked
      [ -n "$base" ] && git diff --name-only "$base"...HEAD 2>/dev/null || true
    } | sort -u
  )"
fi

[ -z "$changed" ] && exit 0

# Code areas whose behaviour the docs describe.
code="$(printf '%s\n' "$changed" \
  | grep -Ei '^(routes/|lib/|shared/|public/js/|prisma/schema\.prisma|server\.ts|app\.ts)' || true)"
# Any Markdown doc touched at all.
docs="$(printf '%s\n' "$changed" | grep -Ei '\.md$' || true)"

if [ -n "$code" ] && [ -z "$docs" ]; then
  reason="This session changed code but no Markdown docs were updated. Before finishing, check whether the behaviour of these files is described in CLAUDE.md / DESIGN.md / TEBI.md / DRINKS_DOMAIN.md / SETUP_GUIDE.md (or another .md) and update the relevant doc(s) to match — or briefly confirm that none need changes. Changed code files:
${code}"
  jq -n --arg r "$reason" '{decision:"block", reason:$r}'
  exit 0
fi

exit 0
