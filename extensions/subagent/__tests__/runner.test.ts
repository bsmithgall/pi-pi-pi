import { PassThrough } from "node:stream";
import type { Message } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { applyRunEvent, buildAgentArgs, parseRunEvent } from "../helpers.js";
import type { ChildLike } from "../runner.js";
import { linesFrom } from "../runner.js";
import { assistantMsg, toolResultMsg, zeroUsage } from "./fixtures.js";

// ── helpers for ChildLike fakes ──────────────────────────────────────────────

/** Create a fake ChildLike whose stdout, exit, close, and error events we control. */
function fakeChild(): {
  child: ChildLike;
  stdout: PassThrough;
  emitExit: (code: number) => void;
  emitClose: (code: number) => void;
  emitError: (err: Error) => void;
} {
  const stdout = new PassThrough();
  const listeners: {
    exit: Array<(code: number | null) => void>;
    close: Array<(code: number | null) => void>;
    error: Array<(err: Error) => void>;
  } = {
    exit: [],
    close: [],
    error: [],
  };
  const child: ChildLike = {
    stdout,
    on(event: string, cb: (...args: never[]) => void) {
      if (event === "exit") listeners.exit.push(cb as (code: number | null) => void);
      if (event === "close") listeners.close.push(cb as (code: number | null) => void);
      if (event === "error") listeners.error.push(cb as (err: Error) => void);
    },
  };
  return {
    child,
    stdout,
    emitExit: (code) => {
      for (const cb of listeners.exit) cb(code);
    },
    emitClose: (code) => {
      for (const cb of listeners.close) cb(code);
    },
    emitError: (err) => {
      for (const cb of listeners.error) cb(err);
    },
  };
}

describe("buildAgentArgs", () => {
  it("always includes the base flags", () => {
    const args = buildAgentArgs({}, "do something");
    expect(args).toContain("--mode");
    expect(args).toContain("json");
    expect(args).toContain("-p");
    expect(args).toContain("--no-session");
  });

  it("appends the task as the final argument", () => {
    const args = buildAgentArgs({}, "summarise this");
    expect(args[args.length - 1]).toBe("Task: summarise this");
  });

  it("includes --model when spec.model is set", () => {
    const args = buildAgentArgs({ model: "claude-haiku-4-5" }, "go");
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("claude-haiku-4-5");
  });

  it("omits --model when spec.model is absent", () => {
    expect(buildAgentArgs({}, "go")).not.toContain("--model");
  });

  it("uses the spec tools list when provided", () => {
    const args = buildAgentArgs({ tools: ["read", "grep"] }, "go");
    const idx = args.indexOf("--tools");
    expect(args[idx + 1]).toBe("read,grep");
  });

  it("defaults to read,grep,find,ls,bash when tools is absent", () => {
    const args = buildAgentArgs({}, "go");
    const idx = args.indexOf("--tools");
    expect(args[idx + 1]).toBe("read,grep,find,ls,bash");
  });

  it("includes --append-system-prompt when systemPromptPath is provided", () => {
    const args = buildAgentArgs({}, "go", "/tmp/prompt.md");
    const idx = args.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("/tmp/prompt.md");
  });

  it("omits --append-system-prompt when systemPromptPath is absent", () => {
    expect(buildAgentArgs({}, "go")).not.toContain("--append-system-prompt");
  });
});

describe("parseRunEvent", () => {
  it("returns null for blank lines", () => {
    expect(parseRunEvent("")).toBeNull();
    expect(parseRunEvent("   ")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseRunEvent("not json")).toBeNull();
    expect(parseRunEvent("{bad}")).toBeNull();
  });

  it("parses a valid JSON event", () => {
    const event = parseRunEvent(
      JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
    );
    expect(event?.type).toBe("message_end");
  });

  it("returns the parsed object as-is", () => {
    const raw = { type: "tool_result_end", message: { role: "toolResult" }, extra: 42 };
    expect(parseRunEvent(JSON.stringify(raw))).toEqual(raw);
  });
});

describe("applyRunEvent", () => {
  it("returns null and mutates nothing for an unrecognised event type", () => {
    const messages: Message[] = [];
    const usage = zeroUsage();
    const result = applyRunEvent({ type: "unknown" }, messages, usage);
    expect(result).toBeNull();
    expect(messages).toHaveLength(0);
    expect(usage).toEqual(zeroUsage());
  });

  it("returns null for message_end with no message field", () => {
    const result = applyRunEvent({ type: "message_end" }, [], zeroUsage());
    expect(result).toBeNull();
  });

  it("returns null for tool_result_end with no message field", () => {
    const result = applyRunEvent({ type: "tool_result_end" }, [], zeroUsage());
    expect(result).toBeNull();
  });

  describe("message_end with assistant message", () => {
    it("pushes the message and returns isAssistant: true", () => {
      const messages: Message[] = [];
      const usage = zeroUsage();
      const msg = assistantMsg();
      const result = applyRunEvent({ type: "message_end", message: msg }, messages, usage);
      expect(result).toEqual({ message: msg, isAssistant: true });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toBe(msg);
    });

    it("increments turns", () => {
      const usage = zeroUsage();
      applyRunEvent({ type: "message_end", message: assistantMsg() }, [], usage);
      expect(usage.turns).toBe(1);
    });

    it("accumulates token counts from usage", () => {
      const usage = zeroUsage();
      const msg = assistantMsg({
        usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10, totalTokens: 180 },
      });
      applyRunEvent({ type: "message_end", message: msg }, [], usage);
      expect(usage.input).toBe(100);
      expect(usage.output).toBe(50);
      expect(usage.cacheRead).toBe(20);
      expect(usage.cacheWrite).toBe(10);
      expect(usage.contextTokens).toBe(180);
    });

    it("accumulates cost from usage.cost.total", () => {
      const usage = zeroUsage();
      const msg = assistantMsg({
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { total: 0.005 },
        },
      });
      applyRunEvent({ type: "message_end", message: msg }, [], usage);
      expect(usage.cost).toBeCloseTo(0.005);
    });

    it("accumulates across multiple events", () => {
      const usage = zeroUsage();
      const msg = (input: number) =>
        assistantMsg({
          usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input },
        });
      applyRunEvent({ type: "message_end", message: msg(100) }, [], usage);
      applyRunEvent({ type: "message_end", message: msg(200) }, [], usage);
      expect(usage.input).toBe(300);
      expect(usage.turns).toBe(2);
    });
  });

  describe("message_end with non-assistant message", () => {
    it("pushes the message and returns isAssistant: false", () => {
      const messages: Message[] = [];
      const usage = zeroUsage();
      const msg = toolResultMsg();
      const result = applyRunEvent({ type: "message_end", message: msg }, messages, usage);
      expect(result).toEqual({ message: msg, isAssistant: false });
      expect(messages).toHaveLength(1);
    });

    it("does not increment turns", () => {
      const usage = zeroUsage();
      applyRunEvent({ type: "message_end", message: toolResultMsg() }, [], usage);
      expect(usage.turns).toBe(0);
    });
  });

  describe("tool_result_end", () => {
    it("pushes the message and returns isAssistant: false", () => {
      const messages: Message[] = [];
      const msg = toolResultMsg();
      const result = applyRunEvent(
        { type: "tool_result_end", message: msg },
        messages,
        zeroUsage(),
      );
      expect(result).toEqual({ message: msg, isAssistant: false });
      expect(messages).toHaveLength(1);
    });

    it("does not affect usage", () => {
      const usage = zeroUsage();
      applyRunEvent({ type: "tool_result_end", message: toolResultMsg() }, [], usage);
      expect(usage).toEqual(zeroUsage());
    });
  });
});

// ── linesFrom ────────────────────────────────────────────────────────────────

describe("linesFrom", () => {
  it("yields newline-delimited lines from stdout", async () => {
    const { child, stdout, emitExit, emitClose } = fakeChild();
    const stream = linesFrom(child);
    stdout.write("line1\nline2\n");
    stdout.end();
    emitExit(0);
    emitClose(0);

    const lines: string[] = [];
    for await (const line of stream) lines.push(line);
    expect(lines).toEqual(["line1", "line2"]);
    expect(await stream.exitCode).toBe(0);
  });

  it("yields a trailing partial line (no final newline)", async () => {
    const { child, stdout, emitExit, emitClose } = fakeChild();
    const stream = linesFrom(child);
    stdout.write("complete\npartial");
    stdout.end();
    emitExit(0);
    emitClose(0);

    const lines: string[] = [];
    for await (const line of stream) lines.push(line);
    expect(lines).toEqual(["complete", "partial"]);
  });

  it("resolves exitCode with the exit code", async () => {
    const { child, stdout, emitExit, emitClose } = fakeChild();
    const stream = linesFrom(child);
    stdout.end();
    emitExit(42);
    emitClose(42);

    for await (const _ of stream) {
      /* drain */
    }
    expect(await stream.exitCode).toBe(42);
  });

  it("resolves exitCode as 1 on error event", async () => {
    const { child, stdout, emitError } = fakeChild();
    const stream = linesFrom(child);
    stdout.end();
    emitError(new Error("spawn ENOENT"));

    for await (const _ of stream) {
      /* drain */
    }
    expect(await stream.exitCode).toBe(1);
  });

  it("does not hang when exit/close fires before stdout is drained", async () => {
    // This is the race condition that caused parallel mode to hang.
    // Simulate: exit+close fires immediately, then stdout data arrives and ends.
    const { child, stdout, emitExit, emitClose } = fakeChild();
    const stream = linesFrom(child);

    // Exit+close fires BEFORE any stdout data — the generator hasn't started yet
    emitExit(0);
    emitClose(0);

    // Now push data and end stdout
    stdout.write("data\n");
    stdout.end();

    const lines: string[] = [];
    // This must complete without hanging — before the fix it would block forever
    for await (const line of stream) lines.push(line);
    expect(lines).toEqual(["data"]);
    expect(await stream.exitCode).toBe(0);
  });

  it("does not hang when exit/close fires between stdout chunks", async () => {
    const { child, stdout, emitExit, emitClose } = fakeChild();
    const stream = linesFrom(child);

    // Write some data, fire exit+close, then end stdout
    stdout.write("first\n");
    emitExit(0);
    emitClose(0);
    stdout.write("second\n");
    stdout.end();

    const lines: string[] = [];
    for await (const line of stream) lines.push(line);
    expect(lines).toEqual(["first", "second"]);
    expect(await stream.exitCode).toBe(0);
  });

  it("handles empty stdout with immediate close", async () => {
    const { child, stdout, emitExit, emitClose } = fakeChild();
    const stream = linesFrom(child);
    emitExit(0);
    emitClose(0);
    stdout.end();

    const lines: string[] = [];
    for await (const line of stream) lines.push(line);
    expect(lines).toEqual([]);
    expect(await stream.exitCode).toBe(0);
  });

  it("does not hang when process exits but close never fires", async () => {
    // Reproduces the real-world hang: the subagent process exits (exit event
    // fires), stdout is drained, but `close` never fires because a grandchild
    // process inherited the pipe fd. Before the fix, the generator awaited
    // `closed` which was only resolved by `close`, causing a permanent hang.
    const { child, stdout, emitExit } = fakeChild();
    const stream = linesFrom(child);

    stdout.write("output\n");
    stdout.end();
    // Process exits — but close never fires (grandchild holds pipe open)
    emitExit(0);

    const lines: string[] = [];
    const timeout = setTimeout(() => {
      throw new Error("linesFrom hung — close never fired and generator blocked");
    }, 1_000);

    for await (const line of stream) lines.push(line);
    clearTimeout(timeout);

    expect(lines).toEqual(["output"]);
    expect(await stream.exitCode).toBe(0);
    // Note: emitClose is never called — this is the bug scenario
  });

  it("resolves exitCode from exit even when close arrives later", async () => {
    const { child, stdout, emitExit, emitClose } = fakeChild();
    const stream = linesFrom(child);

    stdout.end();
    emitExit(0);

    for await (const _ of stream) {
      /* drain */
    }

    // exitCode should already be resolved from 'exit', not waiting for 'close'
    expect(await stream.exitCode).toBe(0);

    // Late close with a different code should not change the result
    emitClose(1);
    expect(await stream.exitCode).toBe(0);
  });
});
