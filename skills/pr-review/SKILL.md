---
name: pr-review
description: Deep code review of a GitHub or GitHub Enterprise pull request. Loads full file context in an isolated git worktree. Use when asked to review a PR or pull request.
allowed-tools: Bash({baseDir}/scripts:*), Bash(mkdir -p ~/.pi/pr-reviews:*), Write(~/.pi/pr-reviews/**), Bash(ln -sf:*)
---

# PR Review Skill

Review a pull request by checking out the code in an isolated worktree and loading full file context.

## Input

Required:
- **PR number**: e.g., `12345`

Optional:
- **`--host`**: GitHub Enterprise hostname, e.g., `--host ghe.company.com`. Omit for public GitHub.
- **Repo**: e.g., `myorg/myrepo` (auto-detected from git remote if not provided)
- **Focus/directions**: e.g., `"focus on error handling and concurrency"`

### Host Resolution

The scripts resolve the GitHub host in this order:
1. `--host <hostname>` flag (explicit override — use when reviewing a repo from a different host than your CWD, or when running outside any git repo)
2. Auto-detected from the `origin` remote URL of the current git repo
3. Falls back to `github.com`

This means **the common case requires no flags at all**: if you're sitting in a checkout of a GHE repo and ask to review one of its PRs, the host is detected automatically.

### Examples

```
/skill:pr-review 12345
/skill:pr-review 12345 "focus on security and input validation"
/skill:pr-review myorg/other-repo 12345
/skill:pr-review --host ghe.company.com myorg/myrepo 12345 "check for race conditions"
```

## Directory Structure

**Worktrees** (keyed by host so different GitHub instances never collide):
```
~/.pi/pr-worktrees/<host>/<owner>/<repo>/PR-<number>/
```

Where `<host>` has dots replaced with dashes, e.g. `ghe-company-com` or `github-com`.

**Reviews** (persistent):
```
~/.pi/pr-reviews/<host>/<owner>/<repo>/PR-<number>/
├── 2024-01-27-143052.md
├── 2024-01-27-161230-security-focus.md
└── latest.md -> 2024-01-27-161230-security-focus.md
```

## Process

### 1. Resolve Arguments

Parse the user's input to extract:
- `--host` flag (if present)
- PR number (required)
- `owner/repo` (optional — omit to auto-detect)
- Focus directions (optional free text)

### 2. Setup Worktree

```bash
{baseDir}/scripts/setup.sh [--host <hostname>] <pr_number> [owner/repo]
```

This outputs `WORKTREE_DIR`, `BRANCH`, `REPO`, and `HOST`. Capture them — you'll need `REPO` and `HOST` for the remaining scripts.

**All subsequent file operations use the worktree directory.**

### 3. Fetch PR Information

```bash
{baseDir}/scripts/pr-info.sh [--host <hostname>] <owner/repo> <pr_number>
```

Pass the `HOST` and `REPO` values from setup's output. This fetches:
- PR title, body, author, state
- Changed files with additions/deletions
- Existing reviews and inline comments
- The full diff

### 4. Load Full File Context

`cd` into the worktree, then read each changed file **completely** with the Read tool — not just the diff. For wider context, use Bash to grep for callers/callees of modified functions, locate related test files, and find similar patterns in the codebase.

### 5. Check for Repo Guidance

Look for `AGENTS.md` or `CLAUDE.md` in:
- The repo root
- The component directory (for monorepos)

These often contain testing commands, architecture notes, or known pitfalls.

### 6. Analyze Changes

Look for issues that CI won't catch:
- Logic errors and edge cases
- Race conditions or concurrency issues
- Security concerns (injection, auth bypass, data exposure)
- API contract violations
- Performance regressions in hot paths
- Backwards compatibility breaks
- Missing error handling for realistic failure modes
- Incorrect assumptions about external systems

Also think about the change from an architectural perspective, and consider the negative space. What are we missing?

**Do NOT flag:**
- Style issues (formatters/linters catch these)
- Missing tests unless a specific untested edge case is critical
- Theoretical concerns unlikely to occur in practice

If the user provided focus directions, prioritize those areas.

### 7. Verify Concerns

When uncertain about a potential issue:
- Trace call paths to understand impact
- Check if existing tests cover the scenario
- Look for the same pattern elsewhere in the codebase

Only report issues you have confidence in. Minimize false positives.

## Output

### 1. Create the review directory

```bash
mkdir -p ~/.pi/pr-reviews/<host>/<owner>/<repo>/PR-<number>
```

Use the same `<host>` slug format as the worktree path (dots → dashes).

### 2. Generate filename

- Without focus: `2024-01-27-143052.md`
- With focus: `2024-01-27-143052-security-focus.md`

### 3. Write the review

Write to `~/.pi/pr-reviews/<host>/<owner>/<repo>/PR-<number>/<filename>.md`

### 4. Update the symlink

```bash
ln -sf <filename>.md ~/.pi/pr-reviews/<host>/<owner>/<repo>/PR-<number>/latest.md
```

### Review Format

```markdown
# Review: <owner>/<repo>#<number>

**Host:** <hostname>
**Title:** <PR title>
**Author:** <author>
**Branch:** <head_branch> → <base_branch>
**Reviewed:** <timestamp>
**Focus:** <user-provided directions or "General review">

## Summary

<1-2 sentences: what the PR does and overall assessment>

## Findings

### [Blocker] <Brief description>
**File:** `path/to/file.go:45-52`

<Explanation of the issue and why it matters>

**Suggestion:**
<concrete fix>

---

### [Suggestion] <Brief description>
**File:** `path/to/file.go:120`

<Explanation>

---

## Files Reviewed

- `path/to/file1.go` (modified) - <brief note>
- `path/to/file2.go` (added)
- `path/to/related.go` (context)

## Notes

<Any additional context, questions for the author, or observations>
```

### Severity Levels

- **Blocker**: Must fix before merge. Bugs, security issues, data loss risks.
- **Suggestion**: Worth considering. Improvements, minor issues, clarity.

## Cleanup

After writing the review, remove the worktree:

```bash
{baseDir}/scripts/cleanup.sh [--host <hostname>] <owner/repo> <pr_number>
```

## Completion

1. Write the review to the file
2. Print the full review in the conversation
3. Print the file path
4. Run cleanup
