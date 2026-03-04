# subagent

A pi extension that delegates tasks to general-purpose subagents running in isolated
`pi` processes. Each agent has its own context window and configurable tool set. 
Based on the the [example subagent extension][example], but modified to remove pre-defined
agents and split into multiple files to add testability.

[example]: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts

## Features

- **Three Execution Modes**: Single (one agent), Parallel (concurrent), Chain (sequential with output carryover)
- **Inline Agent Definition**: No pre-registered files — specify model, tools, and system prompt per-task
- **Read-Only by Default**: Agents get `read`, `grep`, `find`, `ls`, `bash` — no `edit`/`write` unless added
- **Isolated Context**: Each agent starts fresh; independent token limits and cache
- **Live Streaming**: Results update as agents complete; no blocking on all tasks finishing
- **Smart Rendering**: Collapsible TUI with syntax highlighting, usage stats, step numbers
