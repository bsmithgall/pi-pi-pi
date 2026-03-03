#!/bin/bash
# Fetch PR metadata, diff, and comments
# Usage: pr-info.sh [--host <hostname>] <owner/repo> <pr_number>

set -euo pipefail

export GIT_TERMINAL_PROMPT=0
export GH_PROMPT_DISABLED=1
export GH_PAGER=""

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

REPO="${1:?Usage: pr-info.sh [--host <hostname>] <owner/repo> <pr_number>}"
PR_NUM="${2:?Usage: pr-info.sh [--host <hostname>] <owner/repo> <pr_number>}"

if [[ -n "$GH_HOST_OVERRIDE" && "$GH_HOST_OVERRIDE" != "github.com" ]]; then
    export GH_HOST="$GH_HOST_OVERRIDE"
fi

# --- PR metadata ---
echo "=== PR #$PR_NUM ==="
gh pr view "$PR_NUM" --repo "$REPO" \
    --json title,author,state,baseRefName,headRefName,additions,deletions,createdAt \
    --jq '"Title: \(.title)
Author: \(.author.login)
State: \(.state)
Branch: \(.headRefName) → \(.baseRefName)
Changes: +\(.additions) -\(.deletions)
Created: \(.createdAt)"'

echo ""
echo "=== Description ==="
gh pr view "$PR_NUM" --repo "$REPO" --json body --jq '.body // "(no description)"'

echo ""
echo "=== Changed Files ==="
gh pr view "$PR_NUM" --repo "$REPO" --json files \
    --jq '.files[] | "\(.path) (+\(.additions) -\(.deletions))"'

echo ""
echo "=== Review Status ==="
gh api "repos/$REPO/pulls/$PR_NUM/reviews" \
    --jq 'group_by(.user.login) | .[] | "\(.[0].user.login): \([.[] | .state] | unique | join(", "))"' 2>/dev/null || echo "(none)"

echo ""
echo "=== Review Comments ==="
COMMENT_COUNT=$(gh api "repos/$REPO/pulls/$PR_NUM/comments" --jq 'length' 2>/dev/null || echo "0")
if [[ "$COMMENT_COUNT" -gt 0 ]]; then
    echo "($COMMENT_COUNT comments)"
    echo ""
    gh api "repos/$REPO/pulls/$PR_NUM/comments" \
        --jq '.[] | "[\(.path):\(.line // .original_line // "?")] \(.user.login):\n\(.body)\n---"' 2>/dev/null
else
    echo "(none)"
fi

echo ""
echo "=== Diff ==="
gh pr diff "$PR_NUM" --repo "$REPO"
