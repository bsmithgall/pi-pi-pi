#!/bin/bash
# Remove the worktree created for a PR review
# Usage: cleanup.sh [--host <hostname>] <owner/repo> <pr_number>

set -euo pipefail

export GIT_TERMINAL_PROMPT=0

echo "[cleanup] Starting cleanup..." >&2

# --- Parse arguments ---
GH_HOST_OVERRIDE=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --host)
            GH_HOST_OVERRIDE="${2:?--host requires a value}"
            shift 2
            ;;
        *)
            break
            ;;
    esac
done

REPO="${1:?Usage: cleanup.sh [--host <hostname>] <owner/repo> <pr_number>}"
PR_NUM="${2:?Usage: cleanup.sh [--host <hostname>] <owner/repo> <pr_number>}"

echo "[cleanup] Repo: $REPO, PR: $PR_NUM" >&2

OWNER="${REPO%/*}"
REPO_NAME="${REPO#*/}"

# --- Resolve host (same logic as setup.sh) ---
if [[ -n "$GH_HOST_OVERRIDE" ]]; then
    RESOLVED_HOST="$GH_HOST_OVERRIDE"
else
    REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")
    if [[ "$REMOTE_URL" =~ ^https?://([^/]+)/ ]]; then
        RESOLVED_HOST="${BASH_REMATCH[1]}"
    elif [[ "$REMOTE_URL" =~ ^git@([^:]+): ]]; then
        RESOLVED_HOST="${BASH_REMATCH[1]}"
    else
        RESOLVED_HOST="github.com"
    fi
fi

SAFE_HOST="${RESOLVED_HOST//./-}"
WORKTREE_DIR="$HOME/.pi/pr-worktrees/$SAFE_HOST/$OWNER/$REPO_NAME/PR-$PR_NUM"

echo "[cleanup] Worktree: $WORKTREE_DIR" >&2

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo "[cleanup] Error: Not in a git repository" >&2
    exit 1
}
cd "$REPO_ROOT"

if [[ -d "$WORKTREE_DIR" ]]; then
    echo "[cleanup] Removing worktree..." >&2
    git worktree remove --force "$WORKTREE_DIR" 2>/dev/null || rm -rf "$WORKTREE_DIR"
    echo "[cleanup] Removed: $WORKTREE_DIR" >&2

    echo "[cleanup] Removing local branch pr-$PR_NUM..." >&2
    git branch -D "pr-$PR_NUM" 2>/dev/null || true
    echo "[cleanup] Done!" >&2
else
    echo "[cleanup] No worktree found at $WORKTREE_DIR, nothing to do." >&2
fi
