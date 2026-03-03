#!/bin/bash
# Setup a git worktree for PR review
# Usage: setup.sh [--host <hostname>] <pr_number> [owner/repo]
#
# Host resolution order:
#   1. --host flag (explicit override)
#   2. Auto-detected from current git remote URL
#   3. Falls back to github.com
#
# If owner/repo is not provided, it is detected from the current git remote.

set -euo pipefail

export GIT_TERMINAL_PROMPT=0
export GH_PROMPT_DISABLED=1

echo "[setup] Starting setup..." >&2

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

PR_NUM="${1:?Usage: setup.sh [--host <hostname>] <pr_number> [owner/repo]}"
REPO="${2:-}"

echo "[setup] PR: $PR_NUM" >&2

# --- Detect repo root (optional — we just need a git context for worktrees) ---
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo "[setup] Error: Not in a git repository" >&2
    exit 1
}
echo "[setup] Repo root: $REPO_ROOT" >&2
cd "$REPO_ROOT"

# --- Resolve GH_HOST ---
if [[ -n "$GH_HOST_OVERRIDE" ]]; then
    RESOLVED_HOST="$GH_HOST_OVERRIDE"
    echo "[setup] Host: $RESOLVED_HOST (from --host flag)" >&2
else
    # Try to extract hostname from the remote URL
    REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")
    if [[ "$REMOTE_URL" =~ ^https?://([^/]+)/ ]]; then
        RESOLVED_HOST="${BASH_REMATCH[1]}"
    elif [[ "$REMOTE_URL" =~ ^git@([^:]+): ]]; then
        RESOLVED_HOST="${BASH_REMATCH[1]}"
    else
        RESOLVED_HOST="github.com"
    fi
    echo "[setup] Host: $RESOLVED_HOST (auto-detected from remote)" >&2
fi

# Only set GH_HOST when it's not the default public GitHub
if [[ "$RESOLVED_HOST" != "github.com" ]]; then
    export GH_HOST="$RESOLVED_HOST"
    echo "[setup] GH_HOST=$GH_HOST" >&2
fi

# --- Detect repo if not provided ---
if [[ -z "$REPO" ]]; then
    echo "[setup] Detecting repo via gh CLI..." >&2
    REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null) || {
        echo "[setup] Error: Could not detect repo via gh CLI. Are you in a repo checkout, or did you mean to pass owner/repo?" >&2
        exit 1
    }
fi

echo "[setup] Repo: $REPO" >&2

OWNER="${REPO%/*}"
REPO_NAME="${REPO#*/}"

# Include host in worktree path so different hosts never collide
SAFE_HOST="${RESOLVED_HOST//./-}"
WORKTREE_BASE="$HOME/.pi/pr-worktrees"
WORKTREE_DIR="$WORKTREE_BASE/$SAFE_HOST/$OWNER/$REPO_NAME/PR-$PR_NUM"

echo "[setup] Worktree: $WORKTREE_DIR" >&2

# --- Get PR branch ---
echo "[setup] Fetching PR branch from $RESOLVED_HOST..." >&2
BRANCH=$(gh pr view "$PR_NUM" --repo "$REPO" --json headRefName --jq '.headRefName')

if [[ -z "$BRANCH" ]]; then
    echo "[setup] Error: Could not find PR #$PR_NUM in $REPO on $RESOLVED_HOST" >&2
    exit 1
fi
echo "[setup] PR branch: $BRANCH" >&2

# --- Create worktree ---
if [[ -d "$WORKTREE_DIR" ]]; then
    echo "[setup] Removing existing worktree..." >&2
    git worktree remove --force "$WORKTREE_DIR" 2>/dev/null || rm -rf "$WORKTREE_DIR"
fi

echo "[setup] Fetching branch '$BRANCH'..." >&2
git fetch origin "$BRANCH:pr-$PR_NUM" --no-tags

echo "[setup] Creating worktree..." >&2
mkdir -p "$(dirname "$WORKTREE_DIR")"
git worktree add "$WORKTREE_DIR" "pr-$PR_NUM"

echo "[setup] Done!" >&2
echo "WORKTREE_DIR=$WORKTREE_DIR"
echo "BRANCH=$BRANCH"
echo "REPO=$REPO"
echo "HOST=$RESOLVED_HOST"
