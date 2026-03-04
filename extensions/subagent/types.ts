/**
 * Shared types and TypeBox parameter schemas for the subagent extension.
 */

import type { Message } from "@mariozechner/pi-ai";
import type { AgentToolResult } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

/**
 * A single parsed event from the pi JSON output stream.
 * `type` and `message` are the fields we act on; the index signature preserves
 * any additional fields the stream may carry without casting them away.
 */
export interface RunEvent {
  type: string;
  message?: Message;
  [key: string]: unknown;
}

/**
 * Injectable process runner — receives the CLI args and working directory,
 * yields newline-delimited JSON strings from stdout, and resolves with the
 * exit code when the process finishes.
 *
 * The real implementation spawns `pi`; tests supply a fake async generator.
 */
export interface Runner {
  run(
    args: string[],
    cwd: string,
    signal: AbortSignal | undefined,
    onStderr: (chunk: string) => void,
  ): AsyncIterable<string> & { exitCode: Promise<number> };
}

export interface AgentSpec {
  name?: string;
  model?: string;
  tools?: string[];
  systemPrompt?: string;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  /** Display name (from spec.name, or model id, or "agent") */
  name: string;
  model: string | undefined;
  task: string;
  /** -1 = still running (parallel streaming placeholder) */
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

export interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  results: SingleResult[];
}

export interface RunAgentOpts {
  spec: AgentSpec;
  task: string;
  cwd?: string;
  defaultCwd: string;
  step?: number;
  signal?: AbortSignal;
  onUpdate?: (partial: AgentToolResult<SubagentDetails>) => void;
  mode: "single" | "parallel" | "chain";
  runner?: Runner;
}

export type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> };

const AgentSpecSchema = Type.Object({
  name: Type.Optional(Type.String({ description: "Display name for this agent (cosmetic only)" })),
  model: Type.Optional(
    Type.String({
      description:
        'Model ID to use, e.g. "claude-haiku-4-5" or "claude-sonnet-4-5". Defaults to the session model.',
    }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Tool names to give the agent. Defaults to ["read", "grep", "find", "ls", "bash"] — no edit or write. Add "edit" and "write" explicitly to allow file modifications.',
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({
      description: "Additional system prompt appended to pi's default system prompt.",
    }),
  ),
});

const TaskItem = Type.Object({
  agent: AgentSpecSchema,
  task: Type.String({ description: "Task to delegate to this agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
  agent: AgentSpecSchema,
  task: Type.String({
    description:
      "Task with optional {previous} placeholder substituted with the prior step's output",
  }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

export const SubagentParams = Type.Object({
  agent: Type.Optional(AgentSpecSchema),
  task: Type.Optional(Type.String({ description: "Task for single-agent mode" })),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the agent process (single mode)" }),
  ),
  tasks: Type.Optional(
    Type.Array(TaskItem, { description: "Array of {agent, task} pairs for parallel execution" }),
  ),
  chain: Type.Optional(
    Type.Array(ChainItem, {
      description: "Array of {agent, task} pairs for sequential execution",
    }),
  ),
});
