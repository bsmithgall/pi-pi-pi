# approve-edit

A pi extension that intercepts `edit` and `write` tool calls, showing a
syntax-highlighted diff overlay for approval before changes are applied.

## Features

- **Review Mode**: Pause before every file change for approval, rejection, or modification
- **Auto Mode**: Let changes apply normally without interruption
- **Syntax Highlighting**: Full language-aware syntax highlighting in diffs
- **External Editor**: Edit proposed changes in your preferred editor with diff view
- **Session Persistence**: Mode preference survives `/reload` and session restore
- **Smart Diff Rendering**: Uses pi's native diff rendering + language highlighting
- **Vim Navigation**: Full vim-style keybindings in the diff overlay
- **Mutex Serialization**: Parallel edits queue up for review

## Setup

Place this directory in `.pi/extensions/approve-edit/` (project) or
`~/.pi/agent/extensions/approve-edit/` (global), or run directly:

```bash
pi -e ./extensions/approve-edit
```

## Modes

| Mode | Behavior |
|------|----------|
| **auto** (default) | Edits apply normally, no interception |
| **review** | Every edit/write shows a diff overlay for approval |

Toggle with `Ctrl+Shift+A` or the `/approve-edit` command. Mode persists
across `/reload` and session restore via session entries.

When in review mode, a system prompt injection ensures the agent understands
that file modifications require explicit user approval.

## Diff Overlay

When in review mode, a scrollable diff overlay appears for each edit/write:

```
╔═══════════════════════════════════════════════════╗
║ edit: src/components/Button.tsx                   ║
║                                                   ║
║ @@ -12,7 +12,7 @@                                ║
║   const handleClick = () => {                     ║
║ -   onClick(id)                                   ║
║ +   onClick(id, event)                            ║
║     setActive(true);                              ║
║   };                                              ║
╚ y approve · n reject · e $EDITOR · jk · [] hunk ═╝
```

For **new files**, the overlay shows all lines as additions with syntax highlighting.

For **edits**, the diff shows context lines (default 3 per side) with added/removed
lines highlighted and inline changes marked.

### Keybindings

| Key | Action |
|-----|--------|
| `y` / `Enter` | Approve — tool runs normally |
| `n` / `Escape` | Reject — tool is blocked, agent is told to stop and ask |
| `e` | Open in external editor (see below) |
| `h` | Toggle hide/show overlay to read scrollback |
| `j` / `k` / `↑` / `↓` | Move cursor line by line |
| `[` / `]` or `{` / `}` | Jump to previous/next hunk |
| `Ctrl+U` / `Ctrl+D` | Half-page up/down |
| `g` / `G` | Jump to top / bottom |

## External Editor

Pressing `e` opens the **full proposed file** in `$VISUAL` / `$EDITOR` / `vim`.
For editors that support it, both the original and proposed files are opened in
diff mode:

- **nvim/vim**: `nvim -d original.ext proposed.ext` (vimdiff) with right pane focused
- **VS Code**: `code --diff original.ext proposed.ext --wait`
- **Others**: opens just the proposed file for editing

The original file is read-only (`chmod 444`). Edit the proposed side, save and
quit. The extension detects whether you modified the content:

- **Modified**: Changes are applied to disk immediately
- **Unmodified**: Treated as an approve, tool runs normally
- **Cancelled**: Treated as a rejection

## Tool Override Behavior

In **review mode**:
- Tool calls render minimally in the history (just the filename), since the overlay
  handles all display
- This prevents a (possibly stale) syntax-highlighted diff from appearing underneath
  the interactive overlay

In **auto mode**:
- Tool calls use pi's built-in renderer with full syntax-highlighted diffs
- No custom rendering — completely transparent to the normal flow

## Footer

The extension replaces the default footer with a compact two-line version:

```
~/projects/my-app
● review  ↑1.2k ↓450 $0.032  claude-sonnet-4-20250514 (main)
```

- `●` = review mode, `○` = auto mode
- Token stats: `↑input ↓output $cost`
- Context usage percentage (warning color if > 80%)
- Model ID
- Git branch (if available)
- Other extension statuses

Updates automatically when you toggle mode or switch models.

## Architecture

### Diff Algorithm

Uses the **Myers diff algorithm** (Eugene W. Myers, 1986: "An O(ND) Difference Algorithm")
for efficient computation of edit distances. The algorithm:

1. Walks a shortest-edit-path through an edit graph
2. Outputs unified diff format that pi's `renderDiff()` understands
3. Applies language-aware syntax highlighting to the rendered lines
4. Groups changes into hunks with context

### Mutex Serialization

Parallel edits are serialized via a promise-based review lock. This ensures:
- Only one diff overlay is shown at a time
- Edits queue up fairly
- The agent waits for approval before proceeding

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Entry point — tool_call hook, tool overrides, shortcut, command, high-level flow |
| `state.ts` | Mode toggle, footer rendering, session persistence via appendEntry |
| `diff.ts` | Myers diff algorithm → unified diff in renderDiff format |
| `DiffViewer.ts` | Scrollable TUI overlay with cursor, vim keybindings, action selection |
| `editor.ts` | External editor integration with diff mode detection and temp file handling |
| `apply.ts` | Disk write helpers for edit/write mutations |

## Testing

Test files exist in `__tests__/`:
- `apply.test.ts` — edit/write mutation logic
- `editor.test.ts` — editor command building
- `diff.test.ts` — Myers diff and hunk grouping

Run with: `npm test` (in the monorepo root)
