# pi-pi-pi

Personal configuration, extensions, and skills for the [pi coding agent](https://buildwithpi.ai/).

## Setup

```bash
pi install git:github.com/bsmithgall/pi-pi-pi
```

That's it. The `postinstall` hook in `package.json` runs `install.mjs` automatically,
which symlinks `keybindings.json` into `~/.pi/agent/`. You can also run
`node install.mjs` manually at any time if needed.

## Keybindings

| Action | Key |
|--------|-----|
| Cursor up | `Ctrl+P` |
| Cursor down | `Ctrl+N` |
| Cycle model forward | `Alt+Shift+.` |
| Cycle model backward | `Alt+Shift+,` |
| Toggle review mode | `Ctrl+Shift+A` |

The default `Ctrl+P` / `Ctrl+N` model cycle actions are disabled so those keys
are free for emacs-style cursor movement. Model cycling is handled entirely by
the `model-filter` extension via `Alt+Shift+.` / `Alt+Shift+,`.

## Extensions

### `model-filter`

Overrides model cycling (`Ctrl+[` / `Ctrl+]`) to step only through the latest
version of each Anthropic model family — Haiku, Sonnet, Opus — in that order.
"Latest" is determined dynamically at startup, so no hardcoded IDs need
updating as new models are released.

The full `/model` picker is unaffected.

### `web-search`

Adds a `web_search` tool the LLM can call to search the internet. Uses
Anthropic's native web search beta, routed through `claude-haiku-4-5`
regardless of the active session model. No third-party API key required —
it reuses the same Anthropic credentials already configured in pi.

Returns a concise summary with source URLs. The tool result is collapsible
in the TUI (`Ctrl+O` to expand).

### `approve-edit`

Interactive approval system for file modifications. Toggle between review mode
and auto-approve with `Ctrl+Shift+A`.

**Modes:**
- **Review** (`●`): Every edit shows a diff overlay for approval
- **Auto** (`○`): Edits apply automatically (default)

In review mode, use `y` to approve, `n` to reject, or `e` to edit in `$EDITOR`
before applying. The agent receives feedback about rejections and modifications,
with a system prompt that prevents it from bypassing rejections.

## Skills

### `pr-review`

Deep code review of GitHub or GitHub Enterprise pull requests. Loads full file
context in an isolated git worktree.

**Usage:**
```bash
/skill:pr-review <PR-number> [options]
/skill:pr-review myorg/myrepo <PR-number> "focus on error handling"
/skill:pr-review --host ghe.company.com myorg/myrepo <PR-number>
```

The host is auto-detected from the current git repo's `origin` remote, or can
be overridden with `--host`. Reviews are persistent in `~/.pi/pr-reviews/`.
