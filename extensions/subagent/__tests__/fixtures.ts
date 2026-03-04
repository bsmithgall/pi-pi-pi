/**
 * Shared test fixtures for the subagent extension tests.
 */

import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage,
} from "@mariozechner/pi-ai";
import type { Runner, SingleResult, UsageStats } from "../types.js";

// ── Message builders ──────────────────────────────────────────────────────────

/** Build an AssistantMessage with the given content blocks. */
export function assistant(...content: AssistantMessage["content"]): AssistantMessage {
  return { role: "assistant", content };
}

/** A text content block. */
export function text(t: string): AssistantMessage["content"][number] & { type: "text" } {
  return { type: "text", text: t };
}

/** A toolCall content block. */
export function toolCall(
  name: string,
  args: Record<string, unknown> = {},
): AssistantMessage["content"][number] & { type: "toolCall" } {
  return { type: "toolCall", id: `tc-${name}`, name, arguments: args };
}

export function userMsg(content: string): UserMessage {
  return { role: "user", content };
}

export function toolResult(toolName: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: `tc-${toolName}`,
    toolName,
    content: [{ type: "text", text: "output" }],
  };
}

/**
 * Build a full AssistantMessage as it would come off the wire — with usage,
 * model, and stopReason. Used by runner/orchestration tests.
 */
export function assistantMsg(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
    model: "claude-haiku-4-5",
    stopReason: "end_turn",
    ...overrides,
  } as AssistantMessage;
}

export function toolResultMsg(toolName = "bash"): Message {
  return {
    role: "toolResult",
    toolCallId: `tc-${toolName}`,
    toolName,
    content: [{ type: "text", text: "ok" }],
  } as unknown as Message;
}

// ── Usage ────────────────────────────────────────────────────────────────────

/** Returns a fresh zero-valued UsageStats. Always use the function, not a shared const,
 *  to prevent accidental mutation across tests. */
export function zeroUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

// ── SingleResult ──────────────────────────────────────────────────────────────

export function makeSingleResult(overrides: Partial<SingleResult> = {}): SingleResult {
  return {
    name: "test",
    model: undefined,
    task: "do something",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: zeroUsage(),
    ...overrides,
  };
}

// ── Runner events ─────────────────────────────────────────────────────────────

/** A `message_end` event wrapping an assistant message. */
export function assistantEvent(
  textContent: string,
  overrides: Partial<AssistantMessage> = {},
): Record<string, unknown> {
  return {
    type: "message_end",
    message: assistantMsg({ content: [{ type: "text", text: textContent }], ...overrides }),
  };
}

export function toolResultEvent(toolName = "bash"): Record<string, unknown> {
  return {
    type: "tool_result_end",
    message: toolResultMsg(toolName),
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────

/** A fake Runner that emits a fixed sequence of JSON events then exits. */
export function fakeRunner(events: Array<Record<string, unknown>>, exitCode = 0): Runner {
  return {
    run(_args, _cwd, _signal, _onStderr) {
      const lines = events.map((e) => JSON.stringify(e));
      let i = 0;
      const iter: AsyncIterable<string> & { exitCode: Promise<number> } = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (i < lines.length) return { value: lines[i++], done: false };
              return { value: undefined as unknown as string, done: true };
            },
          };
        },
        exitCode: Promise.resolve(exitCode),
      };
      return iter;
    },
  };
}
