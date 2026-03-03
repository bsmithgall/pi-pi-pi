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
| Cycle model forward | `Ctrl+}` (`Ctrl+Shift+]`) |
| Cycle model backward | `Ctrl+{` (`Ctrl+Shift+[`) |

The default `Ctrl+P` / `Ctrl+N` model cycle actions are disabled so those keys
are free for emacs-style cursor movement. Model cycling is handled entirely by
the `model-filter` extension via `Ctrl+{` / `Ctrl+}`.

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
