/**
 * Pure helper functions for the subagent extension.
 * No I/O, no pi imports — fully unit-testable.
 */

import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import type { AgentSpec, DisplayItem, RunEvent, SingleResult, UsageStats } from "./types.js";

export function agentDisplayName(spec: AgentSpec): string {
  return spec.name ?? spec.model ?? "agent";
}

export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function isAgentError(r: SingleResult): boolean {
  return r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
}

export function aggregateUsage(results: SingleResult[]): UsageStats {
  const total: UsageStats = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
  for (const r of results) {
    total.input += r.usage.input;
    total.output += r.usage.output;
    total.cacheRead += r.usage.cacheRead;
    total.cacheWrite += r.usage.cacheWrite;
    total.cost += r.usage.cost;
    total.turns += r.usage.turns;
  }
  return total;
}

export function formatUsageStats(usage: UsageStats & { turns?: number }, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns !== 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

/**
 * Return the text of the final assistant text block across all messages.
 * Scans messages back-to-front and content blocks back-to-front within each
 * message, so if an assistant message has [text("thinking"), toolCall("bash"),
 * text("final answer")] we return "final answer", not "thinking".
 */
export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (let j = msg.content.length - 1; j >= 0; j--) {
        const part = msg.content[j];
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

/**
 * Flatten all assistant message content into an ordered list of text blocks
 * and tool calls, preserving document order. Used for the collapsed / expanded
 * TUI display.
 */
export function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") {
          items.push({ type: "text", text: part.text });
        } else if (part.type === "toolCall") {
          items.push({ type: "toolCall", name: part.name, args: part.arguments });
        }
      }
    }
  }
  return items;
}

/**
 * Run `fn` over every item in `items`, keeping at most `concurrency` promises
 * in-flight at once. Results are returned in the same order as `items`.
 */
export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Substitute every `{previous}` placeholder in `task` with `previousOutput`.
 */
export function resolvePreviousPlaceholder(task: string, previousOutput: string): string {
  return task.replace(/\{previous\}/g, previousOutput);
}

/**
 * Build the CLI argument list for a `pi` subagent invocation.
 * Pure — no side effects, fully testable.
 */
export function buildAgentArgs(spec: AgentSpec, task: string, systemPromptPath?: string): string[] {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (spec.model) args.push("--model", spec.model);
  const tools = spec.tools ?? ["read", "grep", "find", "ls", "bash"];
  args.push("--tools", tools.join(","));
  if (systemPromptPath) args.push("--append-system-prompt", systemPromptPath);
  args.push(`Task: ${task}`);
  return args;
}

/**
 * Apply a single parsed JSON event from the pi JSON stream to `usage` and
 * the `messages` array in place. Returns the message that was pushed, if any.
 *
 * Pure — takes plain data in, mutates only the two provided mutable objects.
 */
type ApplyRunEventResult =
  | { message: AssistantMessage; isAssistant: true }
  | { message: Message; isAssistant: false };

export function applyRunEvent(
  event: RunEvent,
  messages: Message[],
  usage: UsageStats,
): ApplyRunEventResult | null {
  if (event.type === "message_end" && event.message) {
    const msg = event.message;
    messages.push(msg);
    if (msg.role === "assistant") {
      usage.turns++;
      const u = msg.usage;
      if (u) {
        usage.input += u.input ?? 0;
        usage.output += u.output ?? 0;
        usage.cacheRead += u.cacheRead ?? 0;
        usage.cacheWrite += u.cacheWrite ?? 0;
        usage.cost += (u.cost as { total?: number } | undefined)?.total ?? 0;
        usage.contextTokens = u.totalTokens ?? 0;
      }
      return { message: msg, isAssistant: true };
    }
    return { message: msg, isAssistant: false };
  }

  if (event.type === "tool_result_end" && event.message) {
    const msg = event.message;
    messages.push(msg);
    return { message: msg, isAssistant: false };
  }

  return null;
}

/**
 * Parse a single newline-delimited JSON line from the pi output stream.
 * Returns null for blank lines or parse failures.
 */
export function parseRunEvent(line: string): RunEvent | null {
  if (!line.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) return null;
    return parsed as RunEvent;
  } catch {
    return null;
  }
}
