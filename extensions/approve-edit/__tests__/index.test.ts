/**
 * Integration tests for the approve-edit extension entry point (index.ts).
 *
 * These tests verify that the tool_call handler correctly destructures the
 * current EditToolInput / WriteToolInput schemas. They exist primarily to
 * catch breaking schema changes in @mariozechner/pi-coding-agent — the kind
 * of bug that only surfaces at runtime without a TypeScript compilation step.
 *
 * The approach: register the extension against a minimal mock ExtensionAPI,
 * capture the registered tool_call handler, and invoke it with events built
 * from the real tool input types.
 *
 * Because the full review flow calls into pi internals (renderDiff, highlightCode,
 * initTheme), we mock ctx.ui.custom to resolve immediately and test that the
 * handler reaches it without crashing on schema destructuring.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEventResult,
} from "@mariozechner/pi-coding-agent";
import type { EditToolInput } from "@mariozechner/pi-coding-agent/dist/core/tools/edit.js";
import type { WriteToolInput } from "@mariozechner/pi-coding-agent/dist/core/tools/write.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMode } from "../state.js";

// Mock fs so reviewChange doesn't hit the real filesystem.
vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue("hello world\n"),
  };
});

// Mock renderDiff and highlightCode which require initTheme().
vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    renderDiff: vi.fn().mockReturnValue("+   1 hello\n-   1 world"),
    highlightCode: vi.fn().mockImplementation((content: string) => content.split("\n")),
    getLanguageFromPath: vi.fn().mockReturnValue("text"),
  };
});

/**
 * Build a minimal mock ExtensionAPI that captures registered handlers and tools.
 */
type Handler = (...args: never[]) => unknown;
interface ToolDef {
  name: string;
}

function createMockAPI() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDef>();

  const api = {
    _handlers: handlers,
    _tools: tools,
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool: ToolDef) {
      tools.set(tool.name, tool);
    },
    registerShortcut: vi.fn(),
    registerCommand: vi.fn(),
    setActiveTools: vi.fn(),
    getActiveTools: () => [],
    appendEntry: vi.fn(),
  };

  return api;
}

/**
 * Build a minimal mock ExtensionContext.
 * ui.custom resolves to "approve" by default (pass the diff through).
 */
function createMockCtx(hasUI: boolean) {
  return {
    hasUI,
    cwd: "/tmp",
    ui: {
      custom: vi.fn().mockResolvedValue("approve"),
      notify: vi.fn(),
      setStatus: vi.fn(),
      setFooter: vi.fn(),
    },
    sessionManager: { getEntries: () => [], getBranch: () => [] },
    modelRegistry: { getAvailable: () => [] },
    model: { id: "test-model" },
  } as unknown as ExtensionContext;
}

describe("approve-edit tool_call handler", () => {
  let api: ReturnType<typeof createMockAPI>;
  let toolCallHandler: (
    // biome-ignore lint/suspicious/noExplicitAny: mock handler needs to accept arbitrary event shapes
    event: any,
    ctx: ExtensionContext,
  ) => Promise<ToolCallEventResult | undefined>;

  beforeEach(async () => {
    api = createMockAPI();
    const mod = await import("../index.js");
    mod.default(api as unknown as ExtensionAPI);
    const handlers = api._handlers.get("tool_call") ?? [];
    expect(handlers.length).toBeGreaterThan(0);
    toolCallHandler = handlers[0] as typeof toolCallHandler;
    setMode("review");
  });

  it("destructures EditToolInput with edits array (not flat oldText/newText)", async () => {
    const ctx = createMockCtx(true);

    // Build event using the real EditToolInput shape. If the schema changes
    // again, this will fail to typecheck (with a tsconfig) or the handler
    // will crash at runtime — either way, we catch it.
    const input: EditToolInput = {
      path: "/tmp/test.txt",
      edits: [{ oldText: "hello", newText: "world" }],
    };

    const event = {
      type: "tool_call" as const,
      toolCallId: "tc-1",
      toolName: "edit" as const,
      input,
    };

    // Must not throw "Cannot read properties of undefined (reading 'split')"
    const result = await toolCallHandler(event, ctx);

    // ui.custom was called (we reached the diff overlay, didn't crash before it)
    expect(ctx.ui.custom).toHaveBeenCalled();
    // "approve" => pass through (undefined = don't block)
    expect(result).toBeUndefined();
  });

  it("destructures WriteToolInput correctly", async () => {
    const ctx = createMockCtx(true);

    const input: WriteToolInput = {
      path: "/tmp/test-write.txt",
      content: "new file content\n",
    };

    const event = {
      type: "tool_call" as const,
      toolCallId: "tc-2",
      toolName: "write" as const,
      input,
    };

    const result = await toolCallHandler(event, ctx);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("skips review when not in review mode", async () => {
    setMode("auto");
    const ctx = createMockCtx(true);

    const input: EditToolInput = {
      path: "/tmp/test.txt",
      edits: [{ oldText: "a", newText: "b" }],
    };

    const event = {
      type: "tool_call" as const,
      toolCallId: "tc-3",
      toolName: "edit" as const,
      input,
    };

    const result = await toolCallHandler(event, ctx);
    expect(result).toBeUndefined();
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });

  it("skips review when no UI is available", async () => {
    const ctx = createMockCtx(false);

    const input: EditToolInput = {
      path: "/tmp/test.txt",
      edits: [{ oldText: "a", newText: "b" }],
    };

    const event = {
      type: "tool_call" as const,
      toolCallId: "tc-4",
      toolName: "edit" as const,
      input,
    };

    const result = await toolCallHandler(event, ctx);
    expect(result).toBeUndefined();
  });

  it("blocks the whole call if any edit in a batch is rejected", async () => {
    const ctx = createMockCtx(true);
    (ctx.ui.custom as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("approve")
      .mockResolvedValueOnce("reject");

    const input: EditToolInput = {
      path: "/tmp/test.txt",
      edits: [
        { oldText: "first", newText: "FIRST" },
        { oldText: "second", newText: "SECOND" },
      ],
    };

    const event = {
      type: "tool_call" as const,
      toolCallId: "tc-5",
      toolName: "edit" as const,
      input,
    };

    const result = await toolCallHandler(event, ctx);
    expect(result?.block).toBe(true);
  });
});
