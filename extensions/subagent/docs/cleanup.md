# Subagent Extension — Code Review (Round 2)

## Overview

The subagent extension delegates tasks to isolated `pi` child processes in three
modes (single, parallel, chain). After the first review, the code was split from
a 799-line `index.ts` monolith into focused modules:

| File | Lines | Responsibility |
|------|------:|----------------|
| `types.ts` | 139 | Shared interfaces, `RunAgentOpts`, TypeBox schemas |
| `helpers.ts` | 193 | Pure utility functions (formatting, parsing, arg building, error detection) |
| `runner.ts` | 54 | Real process spawner (`spawn("pi", …)`) |
| `orchestration.ts` | 255 | `runSingleAgent`, `executeSingle`, `executeChain`, `executeParallel` |
| `render.ts` | 443 | `renderCall`, `renderResult`, shared rendering blocks |
| `index.ts` | 85 | Extension entry point — thin wiring only |

Tests: 87 passing across 3 files (helpers: 47, orchestration: 16, runner: 24).

---

## Status of previous review items

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | Split `index.ts` into render + orchestration | ✅ Done | `index.ts` is now 85 lines of pure wiring |
| 2 | De-duplicate render logic across modes | ✅ Done | `renderMultiResultExpanded`, `renderMultiResultCollapsed`, `renderResultBlockExpanded`, `renderResultBlockCollapsed` |
| 3 | Extract mode-specific execute functions & test them | ✅ Done | `orchestration.test.ts` covers single/chain/parallel with fake runners |
| 4 | Fix `runner.ts` error listener ordering | ✅ Done | `proc.on("error")` now attached immediately after spawn |
| 5 | Collapse `runSingleAgent` params into options object | ✅ Done | `RunAgentOpts` interface in `types.ts` |
| 6 | Extract `isAgentError` and `aggregateUsage` to helpers | ✅ Done | Both in `helpers.ts` with tests |
| 7 | Name magic numbers in render code | ✅ Done | `COLLAPSED_STEP_ITEM_COUNT`, `COLLAPSED_ITEM_COUNT`, `CALL_PREVIEW_LIMIT` |
| 8 | Clarify `getFinalOutput` text-block scan direction | ✅ Done | Now scans content blocks back-to-front; docstring updated; test added |
| 9 | Add comment for `file_path ?? path` fallback | ✅ Done | Comment in `render.ts` explains both parameter names |

---

## New findings

### 1. `renderSingleResult` doesn't use the shared building blocks

`renderChainResult` and `renderParallelResult` both delegate to
`renderMultiResultExpanded` / `renderMultiResultCollapsed` → `renderResultBlockExpanded`
/ `renderResultBlockCollapsed`. But `renderSingleResult` (lines ~250–310 of
`render.ts`) is still a standalone 60-line function that manually constructs
the header, tool calls, markdown, and usage — duplicating the same pattern.

The expanded branch of `renderSingleResult` is structurally identical to
`renderResultBlockExpanded` with an extra "Task" section and error display.
The collapsed branch is similar to `renderResultBlockCollapsed` with the addition
of the expand hint.

**Suggestion:** Refactor `renderSingleResult` to compose from the existing blocks.
The extra bits (error banner, task section, expand hint) can be layered on top:

```ts
function renderSingleResult(r, expanded, theme, mdTheme) {
  const icon = resultIcon(r, theme);
  const header = buildSingleHeader(r, icon, theme); // error badge etc.

  if (expanded) {
    const container = new Container();
    container.addChild(new Text(header, 0, 0));
    // ... error message if present ...
    container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
    container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
    // delegate to shared block for output + usage
    const block = renderResultBlockExpanded(r, theme.fg("muted", "─── Output ───"), theme, mdTheme);
    for (const child of block.children) container.addChild(child);
    return container;
  }

  // collapsed: compose from renderResultBlockCollapsed + expand hint
}
```

This isn't urgent — the single-result path is only one case — but it would
complete the de-duplication story.

### 2. `executeSingle` has a different signature shape than its siblings

```ts
// executeSingle — 7 positional parameters
export async function executeSingle(
  agent: AgentSpec, task: string, cwd: string | undefined,
  defaultCwd: string, signal: AbortSignal | undefined,
  onUpdate: ... | undefined, runner?: Runner,
)

// executeChain — 5 positional parameters
export async function executeChain(
  chain: Array<{...}>, defaultCwd: string,
  signal: ... | undefined, onUpdate: ... | undefined,
  runner?: Runner,
)

// executeParallel — same as executeChain
export async function executeParallel(
  tasks: Array<{...}>, defaultCwd: string,
  signal: ... | undefined, onUpdate: ... | undefined,
  runner?: Runner,
)
```

`executeSingle` takes `agent`, `task`, and `cwd` as three separate positional
args while chain/parallel receive a single structured array. This makes the call
site in `index.ts` read differently for each mode.

**Suggestion:** Unify all three to accept an options bag, or at minimum have
`executeSingle` take the same `{ agent, task, cwd }` shape that already exists
in the chain/parallel item type:

```ts
export async function executeSingle(
  item: { agent: AgentSpec; task: string; cwd?: string },
  defaultCwd: string,
  signal?: AbortSignal,
  onUpdate?: OnUpdateCallback,
  runner?: Runner,
)
```

### 3. `executeParallel` validation error uses `throw` while sibling functions return results

In `orchestration.ts`, `executeParallel` throws on too many tasks:

```ts
if (tasks.length > MAX_PARALLEL_TASKS) {
  throw new Error(`Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`);
}
```

Meanwhile `index.ts` throws for invalid mode combinations. And the chain /
single paths return error results rather than throwing when an agent fails.

This is fine — the "too many tasks" case is a validation error before any work
starts, so throwing is reasonable. But it would be worth a brief comment in
`orchestration.ts` distinguishing validation errors (thrown) from agent execution
errors (returned in the result):

```ts
// Validation errors are thrown — they indicate a bug in the caller.
// Agent execution errors are returned as results so the LLM can inspect them.
```

The existing comment above `executeSingle` partially covers this but only
mentions the "not throwing for agent errors" side.

### 4. `render.ts` has no tests

The rendering module is 443 lines — the largest file in the extension — and has
zero test coverage. The shared building blocks (`renderResultBlockExpanded`,
`renderResultBlockCollapsed`, `renderMultiResultExpanded`, etc.) are pure
functions that take a `Theme` interface, which is trivially fakeable:

```ts
const fakeTheme: Theme = {
  fg: (_color, text) => text,   // passthrough: no ANSI, just content
  bold: (text) => text,
};
```

Worth testing at minimum:
- `formatToolCall` for each tool type (bash, read, write, edit, ls, find, grep, unknown)
- `renderCall` for single / chain / parallel mode inputs
- `renderResult` collapsed vs. expanded for each mode

This would prevent regressions in display logic when refactoring the rendering
blocks further.

### 5. Shared test helpers are duplicated across test files

`helpers.test.ts`, `runner.test.ts`, and `orchestration.test.ts` each define
their own message builder utilities (`assistantMsg`, `toolResultMsg`,
`zeroUsage`, etc.) with slight variations:

| Helper | `helpers.test.ts` | `runner.test.ts` | `orchestration.test.ts` |
|--------|:-:|:-:|:-:|
| `assistantMsg` / `assistant` | ✓ (variadic content) | ✓ (overrides object) | ✓ (via `assistantEvent`) |
| `toolResultMsg` / `toolResult` | ✓ | ✓ | ✓ (via `toolResultEvent`) |
| `zeroUsage` | ✓ (const) | ✓ (function) | — |
| `fakeRunner` | — | — | ✓ |
| `text()` / `toolCall()` | ✓ | — | — |

**Suggestion:** Extract a shared `__tests__/fixtures.ts` with canonical builders.
This avoids drift (e.g. `zeroUsage` is a const in one file and a factory function
in another — the const version is subtly dangerous if a test mutates it, though
currently none do).

### 6. Minor: `OnUpdateCallback` type is defined in two places

`types.ts` defines `RunAgentOpts.onUpdate` inline with the full type signature.
`orchestration.ts` used to have a `OnUpdateCallback` type alias — it's now gone
from the type aliases but the inline type in `executeSingle`'s parameter list
spells it out as `((partial: AgentToolResult<SubagentDetails>) => void) | undefined`.

This long type appears three times in `orchestration.ts` (once per execute
function). A named type alias would improve readability:

```ts
// In types.ts:
export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;
```

### 7. Minor: `renderResult` accepts `AgentToolResult<SubagentDetails>` but index.ts casts

In `index.ts`:

```ts
renderResult(result, { expanded }, theme) {
  return renderResult(result as Parameters<typeof renderResult>[0], expanded, theme);
}
```

The `as Parameters<typeof renderResult>[0]` cast is needed because the pi
extension API types `result` more broadly. This is fine but fragile — if the
signature of `render.renderResult` changes, the cast silently keeps compiling.
Consider adding a brief comment explaining why the cast is necessary.

---

## Suggested next steps (priority order)

| Priority | Item | Effort |
|----------|------|--------|
| **Medium** | Add render tests with a fake `Theme` | Medium |
| **Medium** | Extract shared test fixtures to `__tests__/fixtures.ts` | Small |
| **Low** | Compose `renderSingleResult` from existing building blocks | Small |
| **Low** | Unify `executeSingle` parameter shape with chain/parallel | Small |
| **Low** | Extract `OnUpdateCallback` type alias | Trivial |
| **Low** | Add comment distinguishing thrown vs. returned errors | Trivial |
| **Low** | Add comment on `index.ts` render cast | Trivial |
