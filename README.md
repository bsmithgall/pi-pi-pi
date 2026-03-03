# pi-pi-pi

Personal configuration, extensions, and skills for the [pi coding agent](https://buildwithpi.ai/).

## Setup

Run once per machine to symlink config files into `~/.pi/agent/`:

```bash
./install.sh
```

This creates:
- `~/.pi/agent/keybindings.json` → `keybindings.json`

Then install the package itself so pi loads the extensions:

```bash
pi install ./
```

## Keybindings

| Action | Key |
|--------|-----|
| Cycle model forward | `Ctrl+]` |
| Cycle model backward | `Ctrl+[` |

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
