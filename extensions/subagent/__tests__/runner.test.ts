import { describe, expect, it } from "vitest";
import { applyRunEvent, buildAgentArgs, parseRunEvent } from "../helpers.js";
import { assistantMsg, toolResultMsg, zeroUsage } from "./fixtures.js";

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
