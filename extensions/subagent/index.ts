/**
 * Subagent Extension - Delegate tasks to general-purpose subagents
 *
 * Spawns a separate `pi` process for each subagent invocation, giving it an
 * isolated context window. Agents are defined inline in the tool call —
 * no predefined agent files required.
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

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { executeChain, executeParallel, executeSingle } from "./orchestration.js";
import { renderCall, renderResult } from "./render.js";
import { SubagentParams } from "./types.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
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
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      if (modeCount !== 1) {
        throw new Error(
          "Invalid parameters: provide exactly one of { agent+task }, { tasks }, or { chain }.",
        );
      }

      if (params.chain && params.chain.length > 0) {
        return executeChain(params.chain, ctx.cwd, signal, onUpdate);
      }

      if (params.tasks && params.tasks.length > 0) {
        return executeParallel(params.tasks, ctx.cwd, signal, onUpdate);
      }

      if (params.agent && params.task) {
        return executeSingle(
          { agent: params.agent, task: params.task, cwd: params.cwd },
          ctx.cwd,
          signal,
          onUpdate,
        );
      }

      throw new Error("Invalid parameters.");
    },

    renderCall(args, theme) {
      return renderCall(args, theme);
    },

    renderResult(result, { expanded }, theme) {
      return renderResult(result as Parameters<typeof renderResult>[0], expanded, theme);
    },
  });
}
