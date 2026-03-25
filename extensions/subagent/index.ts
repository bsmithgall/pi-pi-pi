/**
 * Subagent Extension - Delegate tasks to general-purpose subagents
 *
 * Spawns a separate `pi` process for each subagent invocation, giving it an
 * isolated context window. Agents are defined inline in the tool call —
 * no predefined agent files required.
 *
 * The subagent tool is registered but kept **inactive** by default. It is only
 * added to the active tool set when the user's prompt explicitly requests
 * subagent/delegation, and removed again once the agent finishes.
 *
 * Supports three modes:
 *   - Single:   { agent: { ... }, task: "..." }
 *   - Parallel: { tasks: [{ agent: { ... }, task: "..." }, ...] }
 *   - Chain:    { chain: [{ agent: { ... }, task: "... {previous} ..." }, ...] }
 *
 * Agent definition fields (all optional):
 *   - name:         Display name shown in the TUI (defaults to model or "agent")
 *   - model:        Model ID to use, e.g. "claude-haiku-4-5" or "claude-sonnet-4-5"
 *                   (defaults to the session's active model)
 *   - tools:        Tool names to give the agent, e.g. ["read","grep","find","ls","bash"]
 *                   (defaults to read, grep, find, ls, bash — no edit or write)
 *   - systemPrompt: Additional system prompt appended to pi's default
 *
 * Typical use cases:
 *   - Exploration / recon with Haiku (cheap, fast)
 *   - Parallel investigation across multiple areas with Sonnet
 *   - Planning or summarisation with a focused system prompt
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { resolveModel } from "./helpers.js";
import { executeChain, executeParallel, executeSingle } from "./orchestration.js";
import { renderCall, renderResult } from "./render.js";
import type { AgentSpec } from "./types.js";
import { SubagentParams } from "./types.js";

const TOOL_NAME = "subagent";

/**
 * Validate and resolve the model field on an agent spec. If the LLM provided
 * a model string that matches an available model (exact, case-insensitive, or
 * substring), use the canonical ID. Otherwise, pass the original string
 * through as-is and let the subprocess resolve it — it may have access to
 * models the parent doesn't, or it will fail with a clear error. Silently
 * falling back to the parent session model was confusing: the subagent result
 * would display the parent model even though a different model was requested.
 */
function resolveAgentSpec(spec: AgentSpec, ctx: ExtensionContext): AgentSpec {
  if (!spec.model) return spec;

  const available = ctx.modelRegistry.getAvailable();
  const resolved = resolveModel(spec.model, available);

  if (resolved) {
    return {
      ...spec,
      requestedModel: spec.model,
      model: `${resolved.provider}/${resolved.id}`,
      resolvedProvider: resolved.provider,
    };
  }

  // Requested model not found — pass through as-is and let the child
  // process resolve it. It may have access to models the parent doesn't.
  return { ...spec, requestedModel: spec.model };
}

/**
 * Resolve model IDs for all agent specs in an array of task items.
 */
function resolveTaskSpecs<T extends { agent: AgentSpec }>(items: T[], ctx: ExtensionContext): T[] {
  return items.map((item) => ({ ...item, agent: resolveAgentSpec(item.agent, ctx) }));
}

/**
 * Keywords in a user prompt that signal they want subagent delegation.
 * Matched case-insensitively against the raw input text.
 */
const ACTIVATION_PATTERNS = [
  /\bsubagents?\b/i,
  /\bsub-agents?\b/i,
  /\bsub agents?\b/i,
  /\bdelegate\b/i,
  /\bin parallel\b/i,
  /\bparalleli[sz]e\b/i,
  /\bconcurrent(ly)?\b/i,
  /\bspawn\b/i,
  /\bfan[- ]?out\b/i,
];

export function shouldActivateSubagent(text: string): boolean {
  return ACTIVATION_PATTERNS.some((pattern) => pattern.test(text));
}

function removeSubagent(tools: string[]): string[] {
  return tools.filter((t) => t !== TOOL_NAME);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Subagent",
    description: [
      "Delegate tasks to general-purpose subagents with isolated context windows.",
      "Each agent is defined inline — no pre-registered agent files needed.",
      "Specify the model (e.g. claude-haiku-4-5, claude-sonnet-4-5),",
      "which tools the agent can use, and an optional system prompt.",
      "Supports three modes:",
      "  single   — one agent, one task",
      "  parallel — multiple agents run concurrently (tasks array)",
      "  chain    — sequential steps, each receiving the prior output via {previous}",
      "Good for: fast exploration with Haiku, parallelising independent research with Sonnet,",
      "or focused planning with a trimmed tool set.",
    ].join(" "),
    promptSnippet:
      "Delegate tasks to subagents with isolated context windows. Supports single, parallel, and chained execution.",
    promptGuidelines: [
      "When the user asks you to delegate, spawn, or use subagents, call the subagent tool directly.",
    ],
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      // Treat { task } without { agent } as single mode with default agent spec,
      // since models frequently omit the agent key when all its fields are optional.
      const hasSingle = Boolean(params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      if (modeCount === 0) {
        throw new Error(
          "No valid parameters received. This can happen if the tool arguments JSON was malformed. " +
            'Please retry with: { task: "...", agent: { model: "..." } }',
        );
      }

      if (modeCount !== 1) {
        throw new Error(
          "Invalid parameters: provide exactly one of { agent+task }, { task }, { tasks }, or { chain }.",
        );
      }

      if (params.chain && params.chain.length > 0) {
        return executeChain(resolveTaskSpecs(params.chain, ctx), ctx.cwd, signal, onUpdate);
      }

      if (params.tasks && params.tasks.length > 0) {
        return executeParallel(resolveTaskSpecs(params.tasks, ctx), ctx.cwd, signal, onUpdate);
      }

      if (params.task) {
        return executeSingle(
          {
            agent: resolveAgentSpec(params.agent ?? {}, ctx),
            task: params.task,
            cwd: params.cwd,
          },
          ctx.cwd,
          signal,
          onUpdate,
        );
      }

      throw new Error("Invalid parameters.");
    },

    renderCall(args, theme, _context) {
      return renderCall(args, theme);
    },

    renderResult(result, _opts, theme, context) {
      return renderResult(
        result as Parameters<typeof renderResult>[0],
        context?.expanded ?? false,
        theme,
      );
    },
  });

  // Start with subagent inactive — remove it from the default active tool set.
  pi.on("session_start", () => {
    pi.setActiveTools(removeSubagent(pi.getActiveTools()));
  });

  // Activate the subagent tool when the user's prompt signals delegation intent.
  pi.on("input", async (event) => {
    if (shouldActivateSubagent(event.text)) {
      const active = pi.getActiveTools();
      if (!active.includes(TOOL_NAME)) {
        pi.setActiveTools([...active, TOOL_NAME]);
      }
    }
    return { action: "continue" as const };
  });

  // Deactivate the subagent tool after the agent finishes so it doesn't
  // leak into subsequent turns where it wasn't requested.
  pi.on("agent_end", async () => {
    const active = pi.getActiveTools();
    if (active.includes(TOOL_NAME)) {
      pi.setActiveTools(removeSubagent(active));
    }
  });
}
