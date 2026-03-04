/**
 * Agent execution orchestration — runSingleAgent + mode dispatch functions.
 * Separated from the extension entry point for testability.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-coding-agent";
import {
  agentDisplayName,
  applyRunEvent,
  buildAgentArgs,
  getFinalOutput,
  isAgentError,
  mapWithConcurrencyLimit,
  parseRunEvent,
  resolvePreviousPlaceholder,
} from "./helpers.js";
import { spawnRunner } from "./runner.js";
import type {
  AgentSpec,
  RunAgentOpts,
  Runner,
  SingleResult,
  SubagentDetails,
  UsageStats,
} from "./types.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

function makeDetails(mode: "single" | "parallel" | "chain") {
  return (results: SingleResult[]): SubagentDetails => ({ mode, results });
}

function zeroUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function writePromptToTempFile(label: string, content: string): { dir: string; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const safe = label.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(dir, `prompt-${safe}.md`);
  fs.writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o600 });
  return { dir, filePath };
}

function agentErrorText(r: SingleResult): string {
  return r.errorMessage || r.stderr || getFinalOutput(r.messages) || "(no output)";
}

export async function runSingleAgent(opts: RunAgentOpts): Promise<SingleResult> {
  const { spec, task, defaultCwd, runner = spawnRunner } = opts;
  const displayName = agentDisplayName(spec);

  const current: SingleResult = {
    name: displayName,
    model: spec.model,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: zeroUsage(),
    step: opts.step,
  };

  const details = makeDetails(opts.mode);
  const emitUpdate = () => {
    opts.onUpdate?.({
      content: [{ type: "text", text: getFinalOutput(current.messages) || "(running...)" }],
      details: details([current]),
    });
  };

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  try {
    if (spec.systemPrompt?.trim()) {
      const tmp = writePromptToTempFile(displayName, spec.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
    }

    const args = buildAgentArgs(spec, task, tmpPromptPath ?? undefined);
    const stream = runner.run(args, opts.cwd ?? defaultCwd, opts.signal, (chunk) => {
      current.stderr += chunk;
    });

    for await (const line of stream) {
      const event = parseRunEvent(line);
      if (!event) continue;
      const applied = applyRunEvent(event, current.messages, current.usage);
      if (applied?.isAssistant) {
        const msg = applied.message;
        if (!current.model && msg.model) current.model = msg.model;
        if (msg.stopReason) current.stopReason = String(msg.stopReason);
        if (msg.errorMessage) current.errorMessage = String(msg.errorMessage);
      }
      if (applied) emitUpdate();
    }

    current.exitCode = await stream.exitCode;
    if (opts.signal?.aborted) throw new Error("Subagent was aborted");
    return current;
  } finally {
    if (tmpPromptPath)
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
        /* ignore */
      }
    if (tmpPromptDir)
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {
        /* ignore */
      }
  }
}

// Subagent errors (non-zero exit, error stop reason) are not tool execution
// errors — they're results the parent agent should interpret. We always return
// normally with the details attached so the LLM can see what happened. Throwing
// would cause the agent loop to discard our details and replace them with {}.

export async function executeSingle(
  item: { agent: AgentSpec; task: string; cwd?: string },
  defaultCwd: string,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: AgentToolResult<SubagentDetails>) => void) | undefined,
  runner?: Runner,
): Promise<AgentToolResult<SubagentDetails>> {
  const result = await runSingleAgent({
    spec: item.agent,
    task: item.task,
    cwd: item.cwd,
    defaultCwd,
    signal,
    onUpdate,
    mode: "single",
    runner,
  });

  const output = isAgentError(result)
    ? `Agent ${result.stopReason ?? "failed"}: ${agentErrorText(result)}`
    : getFinalOutput(result.messages) || "(no output)";

  return {
    content: [{ type: "text", text: output }],
    details: makeDetails("single")([result]),
  };
}

export async function executeChain(
  chain: Array<{ agent: AgentSpec; task: string; cwd?: string }>,
  defaultCwd: string,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: AgentToolResult<SubagentDetails>) => void) | undefined,
  runner?: Runner,
): Promise<AgentToolResult<SubagentDetails>> {
  const results: SingleResult[] = [];
  let previousOutput = "";

  for (let i = 0; i < chain.length; i++) {
    const step = chain[i];
    const resolvedTask = resolvePreviousPlaceholder(step.task, previousOutput);

    const chainUpdate: typeof onUpdate = onUpdate
      ? (partial) => {
          const cur = partial.details?.results[0];
          if (cur) {
            onUpdate({
              content: partial.content,
              details: makeDetails("chain")([...results, cur]),
            });
          }
        }
      : undefined;

    const result = await runSingleAgent({
      spec: step.agent,
      task: resolvedTask,
      cwd: step.cwd,
      defaultCwd,
      step: i + 1,
      signal,
      onUpdate: chainUpdate,
      mode: "chain",
      runner,
    });
    results.push(result);

    if (isAgentError(result)) {
      return {
        content: [
          {
            type: "text",
            text: `Chain stopped at step ${i + 1} (${result.name}): ${agentErrorText(result)}`,
          },
        ],
        details: makeDetails("chain")(results),
      };
    }
    previousOutput = getFinalOutput(result.messages);
  }

  return {
    content: [
      {
        type: "text",
        text: getFinalOutput(results[results.length - 1].messages) || "(no output)",
      },
    ],
    details: makeDetails("chain")(results),
  };
}

export async function executeParallel(
  tasks: Array<{ agent: AgentSpec; task: string; cwd?: string }>,
  defaultCwd: string,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: AgentToolResult<SubagentDetails>) => void) | undefined,
  runner?: Runner,
): Promise<AgentToolResult<SubagentDetails>> {
  if (tasks.length > MAX_PARALLEL_TASKS) {
    throw new Error(`Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`);
  }

  const allResults: SingleResult[] = tasks.map((t) => ({
    name: agentDisplayName(t.agent),
    model: t.agent.model,
    task: t.task,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: zeroUsage(),
  }));

  const emitParallelUpdate = () => {
    if (!onUpdate) return;
    const running = allResults.filter((r) => r.exitCode === -1).length;
    const done = allResults.filter((r) => r.exitCode !== -1).length;
    onUpdate({
      content: [
        {
          type: "text",
          text: `Parallel: ${done}/${allResults.length} done, ${running} running…`,
        },
      ],
      details: makeDetails("parallel")([...allResults]),
    });
  };

  const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
    const result = await runSingleAgent({
      spec: t.agent,
      task: t.task,
      cwd: t.cwd,
      defaultCwd,
      signal,
      onUpdate: (partial) => {
        if (partial.details?.results[0]) {
          allResults[index] = partial.details.results[0];
          emitParallelUpdate();
        }
      },
      mode: "parallel",
      runner,
    });
    allResults[index] = result;
    emitParallelUpdate();
    return result;
  });

  const successCount = results.filter((r) => r.exitCode === 0).length;
  const summaries = results.map((r) => {
    const out = getFinalOutput(r.messages);
    const preview = out.slice(0, 100) + (out.length > 100 ? "..." : "");
    return `[${r.name}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
  });

  return {
    content: [
      {
        type: "text",
        text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
      },
    ],
    details: makeDetails("parallel")(results),
  };
}
