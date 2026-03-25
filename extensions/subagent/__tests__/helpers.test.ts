import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  agentDisplayName,
  aggregateUsage,
  formatTokens,
  formatUsageStats,
  getDisplayItems,
  getFinalOutput,
  isAgentError,
  mapWithConcurrencyLimit,
  resolveModel,
  resolvePreviousPlaceholder,
} from "../helpers.js";
import { shouldActivateSubagent } from "../index.js";
import type { UsageStats } from "../types.js";
import {
  assistant,
  makeSingleResult,
  text,
  toolCall,
  toolResult,
  userMsg,
  zeroUsage,
} from "./fixtures.js";

// Snapshot for spread/equality checks in this file — zeroUsage() returns a fresh
// object each time; we capture one instance here for convenience.
const zeroUsageObj: UsageStats = zeroUsage();

describe("agentDisplayName", () => {
  it("prefers name over model over fallback", () => {
    expect(agentDisplayName({ name: "scout", model: "claude-haiku-4-5" })).toBe("scout");
  });

  it("falls back to model when name is absent", () => {
    expect(agentDisplayName({ model: "claude-haiku-4-5" })).toBe("claude-haiku-4-5");
  });

  it("falls back to 'agent' when both are absent", () => {
    expect(agentDisplayName({})).toBe("agent");
  });
});

describe("isAgentError", () => {
  it("returns false for a successful result", () => {
    expect(isAgentError(makeSingleResult())).toBe(false);
  });

  it("returns true for non-zero exit code", () => {
    expect(isAgentError(makeSingleResult({ exitCode: 1 }))).toBe(true);
  });

  it("returns true for stopReason 'error'", () => {
    expect(isAgentError(makeSingleResult({ stopReason: "error" }))).toBe(true);
  });

  it("returns true for stopReason 'aborted'", () => {
    expect(isAgentError(makeSingleResult({ stopReason: "aborted" }))).toBe(true);
  });

  it("returns false for other stopReasons", () => {
    expect(isAgentError(makeSingleResult({ stopReason: "end_turn" }))).toBe(false);
  });
});

describe("aggregateUsage", () => {
  it("returns zero usage for empty array", () => {
    expect(aggregateUsage([])).toEqual(zeroUsageObj);
  });

  it("sums usage across multiple results", () => {
    const r1 = makeSingleResult({
      usage: {
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 5,
        cost: 0.01,
        contextTokens: 200,
        turns: 1,
      },
    });
    const r2 = makeSingleResult({
      usage: {
        input: 200,
        output: 100,
        cacheRead: 20,
        cacheWrite: 10,
        cost: 0.02,
        contextTokens: 400,
        turns: 2,
      },
    });
    expect(aggregateUsage([r1, r2])).toEqual({
      input: 300,
      output: 150,
      cacheRead: 30,
      cacheWrite: 15,
      cost: 0.03,
      contextTokens: 0,
      turns: 3,
    });
  });

  it("does not sum contextTokens (they are per-turn, not cumulative)", () => {
    const r1 = makeSingleResult({
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 500,
        turns: 1,
      },
    });
    expect(aggregateUsage([r1]).contextTokens).toBe(0);
  });
});

describe("formatTokens", () => {
  it("returns exact count below 1k", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats 1k–9.9k with one decimal", () => {
    expect(formatTokens(1_000)).toBe("1.0k");
    expect(formatTokens(1_500)).toBe("1.5k");
    expect(formatTokens(9_999)).toBe("10.0k");
  });

  it("formats 10k–999k rounded to nearest k", () => {
    expect(formatTokens(10_000)).toBe("10k");
    expect(formatTokens(10_499)).toBe("10k");
    expect(formatTokens(10_500)).toBe("11k");
    expect(formatTokens(999_999)).toBe("1000k");
  });

  it("formats millions with one decimal", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatTokens(2_000_000)).toBe("2.0M");
  });
});

describe("formatUsageStats", () => {
  it("returns empty string for all-zero usage with no model", () => {
    expect(formatUsageStats(zeroUsageObj)).toBe("");
  });

  it("includes only non-zero fields", () => {
    expect(formatUsageStats({ ...zeroUsageObj, input: 1000, output: 500 })).toBe("↑1.0k ↓500");
  });

  it("uses singular 'turn' for exactly one turn", () => {
    expect(formatUsageStats({ ...zeroUsageObj, turns: 1 })).toBe("1 turn");
  });

  it("uses plural 'turns' for more than one", () => {
    expect(formatUsageStats({ ...zeroUsageObj, turns: 3 })).toBe("3 turns");
  });

  it("formats cost to 4 decimal places", () => {
    expect(formatUsageStats({ ...zeroUsageObj, cost: 0.001234 })).toBe("$0.0012");
  });

  it("includes model at the end when provided", () => {
    expect(formatUsageStats({ ...zeroUsageObj, turns: 2 }, "claude-haiku-4-5")).toBe(
      "2 turns claude-haiku-4-5",
    );
  });

  it("includes ctx tokens when > 0", () => {
    expect(formatUsageStats({ ...zeroUsageObj, contextTokens: 50_000 })).toBe("ctx:50k");
  });

  it("omits ctx when contextTokens is 0", () => {
    expect(formatUsageStats({ ...zeroUsageObj, contextTokens: 0 })).toBe("");
  });

  it("assembles all fields in correct order", () => {
    const usage: UsageStats = {
      input: 1000,
      output: 500,
      cacheRead: 200,
      cacheWrite: 100,
      cost: 0.005,
      contextTokens: 10_000,
      turns: 2,
    };
    expect(formatUsageStats(usage, "claude-haiku-4-5")).toBe(
      "2 turns ↑1.0k ↓500 R200 W100 $0.0050 ctx:10k claude-haiku-4-5",
    );
  });
});

describe("getFinalOutput", () => {
  it("returns empty string for empty messages", () => {
    expect(getFinalOutput([])).toBe("");
  });

  it("returns the last assistant text block", () => {
    expect(getFinalOutput([assistant(text("first")), assistant(text("second"))])).toBe("second");
  });

  it("skips non-assistant messages", () => {
    expect(getFinalOutput([assistant(text("answer")), toolResult("bash")])).toBe("answer");
  });

  it("skips toolCall content blocks within an assistant message", () => {
    expect(getFinalOutput([assistant(toolCall("bash", { command: "ls" }), text("done"))])).toBe(
      "done",
    );
  });

  it("returns the last text block within a message, not the first", () => {
    expect(
      getFinalOutput([assistant(text("thinking"), toolCall("bash"), text("final answer"))]),
    ).toBe("final answer");
  });

  it("returns empty string if the last assistant message has no text block", () => {
    expect(getFinalOutput([assistant(toolCall("bash"))])).toBe("");
  });

  it("scans backwards past an assistant message with only tool calls", () => {
    expect(
      getFinalOutput([
        assistant(text("early")),
        assistant(toolCall("grep")),
        assistant(text("final answer")),
      ]),
    ).toBe("final answer");
  });
});

describe("getDisplayItems", () => {
  it("returns empty array for empty messages", () => {
    expect(getDisplayItems([])).toEqual([]);
  });

  it("ignores user and toolResult messages", () => {
    expect(getDisplayItems([userMsg("hello"), toolResult("bash")])).toEqual([]);
  });

  it("extracts text blocks from assistant messages", () => {
    expect(getDisplayItems([assistant(text("hello"))])).toEqual([{ type: "text", text: "hello" }]);
  });

  it("extracts toolCall blocks from assistant messages", () => {
    expect(getDisplayItems([assistant(toolCall("bash", { command: "ls" }))])).toEqual([
      { type: "toolCall", name: "bash", args: { command: "ls" } },
    ]);
  });

  it("preserves document order across multiple messages and content blocks", () => {
    expect(
      getDisplayItems([
        assistant(text("thinking"), toolCall("grep", { pattern: "foo" })),
        assistant(text("done")),
      ]),
    ).toEqual([
      { type: "text", text: "thinking" },
      { type: "toolCall", name: "grep", args: { pattern: "foo" } },
      { type: "text", text: "done" },
    ]);
  });
});

describe("mapWithConcurrencyLimit", () => {
  it("returns empty array for empty input", async () => {
    expect(await mapWithConcurrencyLimit([], 4, async (x) => x)).toEqual([]);
  });

  it("preserves order of results regardless of completion order", async () => {
    const delays = [30, 10, 20];
    const result = await mapWithConcurrencyLimit(delays, 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(result).toEqual([0, 1, 2]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    await mapWithConcurrencyLimit([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });

    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("handles concurrency larger than item count", async () => {
    expect(await mapWithConcurrencyLimit([10, 20, 30], 100, async (x) => x * 2)).toEqual([
      20, 40, 60,
    ]);
  });

  it("clamps concurrency to at least 1", async () => {
    expect(await mapWithConcurrencyLimit([1, 2], 0, async (x) => x + 1)).toEqual([2, 3]);
  });

  it("propagates errors from the worker function", async () => {
    await expect(
      mapWithConcurrencyLimit([1], 1, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("resolvePreviousPlaceholder", () => {
  it("substitutes {previous} with the provided output", () => {
    expect(resolvePreviousPlaceholder("Summarise: {previous}", "some text")).toBe(
      "Summarise: some text",
    );
  });

  it("replaces all occurrences", () => {
    expect(resolvePreviousPlaceholder("{previous} and {previous}", "x")).toBe("x and x");
  });

  it("leaves task unchanged when there is no placeholder", () => {
    expect(resolvePreviousPlaceholder("Do something independent", "ignored")).toBe(
      "Do something independent",
    );
  });

  it("handles empty previousOutput", () => {
    expect(resolvePreviousPlaceholder("Based on {previous}, do X", "")).toBe("Based on , do X");
  });

  it("handles empty task", () => {
    expect(resolvePreviousPlaceholder("", "anything")).toBe("");
  });
});

describe("shouldActivateSubagent", () => {
  it.each([
    "Use a subagent to explore this",
    "Can you delegate this to a sub-agent?",
    "Run these tasks in parallel",
    "Parallelize the search across files",
    "Parallelise the investigation",
    "Spawn a worker to check the tests",
    "Can you fan out across these directories?",
    "Do this concurrently",
    "Search concurrently across repos",
    "Please delegate this work",
    "Fan-out across the three modules",
    "Use a sub agent for this",
  ])("activates for: %s", (text) => {
    expect(shouldActivateSubagent(text)).toBe(true);
  });

  it.each([
    "Fix the bug in the login page",
    "Read the file and explain it",
    "Write a test for the helper function",
    "What does this code do?",
    "Run the tests",
    "Search for usages of this function",
    "",
  ])("does not activate for: %s", (text) => {
    expect(shouldActivateSubagent(text)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(shouldActivateSubagent("SUBAGENT do this")).toBe(true);
    expect(shouldActivateSubagent("Delegate this task")).toBe(true);
    expect(shouldActivateSubagent("IN PARALLEL please")).toBe(true);
  });
});

// ── resolveModel ──────────────────────────────────────────────────────────────

/** Minimal fake Model for testing resolveModel. */
function fakeModel(id: string): Model<Api> {
  return { id, provider: "anthropic" } as Model<Api>;
}

const AVAILABLE_MODELS = [
  fakeModel("claude-haiku-4-5"),
  fakeModel("claude-sonnet-4-5"),
  fakeModel("claude-opus-4-5"),
];

describe("resolveModel", () => {
  it("returns the matched model object including provider metadata", () => {
    const model = resolveModel("claude-haiku-4-5", AVAILABLE_MODELS);
    expect(model).toMatchObject({ id: "claude-haiku-4-5", provider: "anthropic" });
  });

  it("matches fully-qualified provider/model requests exactly", () => {
    const models = [
      { id: "gpt-5.1", provider: "azure-openai-responses" },
      { id: "gpt-5.1", provider: "openai-codex" },
    ] as Model<Api>[];
    expect(resolveModel("openai-codex/gpt-5.1", models)).toMatchObject({
      id: "gpt-5.1",
      provider: "openai-codex",
    });
  });

  it("matches case-insensitively on model id", () => {
    expect(resolveModel("Claude-Haiku-4-5", AVAILABLE_MODELS)).toMatchObject({
      id: "claude-haiku-4-5",
    });
  });

  it("returns undefined for unknown models", () => {
    expect(resolveModel("gpt-4o", AVAILABLE_MODELS)).toBeUndefined();
    expect(resolveModel("nonexistent", AVAILABLE_MODELS)).toBeUndefined();
  });

  it("returns undefined for empty available list", () => {
    expect(resolveModel("claude-haiku-4-5", [])).toBeUndefined();
  });

  it("prefers exact id match over case-insensitive", () => {
    const models = [fakeModel("claude-haiku-4-5"), fakeModel("HAIKU")];
    expect(resolveModel("HAIKU", models)).toMatchObject({ id: "HAIKU" });
  });
});
