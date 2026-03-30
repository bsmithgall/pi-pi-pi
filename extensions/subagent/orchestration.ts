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
    requestedModel: spec.requestedModel,
    resolvedProvider: spec.resolvedProvider,
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

  // Persist the child session so the full conversation is available via
  // `pi --session <file>` or `pi --export <file>` after the run.
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"));

  try {
    if (spec.systemPrompt?.trim()) {
      const tmp = writePromptToTempFile(displayName, spec.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
    }

    const args = buildAgentArgs(spec, task, tmpPromptPath ?? undefined, sessionDir);
    const stream = runner.run(args, opts.cwd ?? defaultCwd, opts.signal, (chunk) => {
      current.stderr += chunk;
    });

    // Semantic completion: resolve when we receive `agent_end` from the
    // pi JSON protocol. This fires well before the OS process actually
    // exits, so we use it as the primary "done" signal.
    let sawAgentEnd = false;
    let resolveAgentEnd!: () => void;
    const agentEndPromise = new Promise<void>((resolve) => {
      resolveAgentEnd = resolve;
    });

    const processLine = (line: string) => {
      const event = parseRunEvent(line);
      if (!event) return;
      if (event.type === "agent_end") {
        sawAgentEnd = true;
        resolveAgentEnd();
      }
      const applied = applyRunEvent(event, current.messages, current.usage);
      if (applied?.isAssistant) {
        const msg = applied.message;
        if (!current.model && msg.model) current.model = msg.model;
        if (msg.stopReason) current.stopReason = String(msg.stopReason);
        if (msg.errorMessage) current.errorMessage = String(msg.errorMessage);
      }
      if (applied) emitUpdate();
    };

    // Start draining stdout in the background.
    const drainStdout = (async () => {
      for await (const line of stream) processLine(line);
    })();

    // Wait for either:
    //   1. Semantic completion (agent_end) — the agent is done
    //   2. Process exit — fallback if agent_end never arrives
    //   3. Abort signal
    await Promise.race([
      agentEndPromise,
      stream.exitCode.then((code) => {
        current.exitCode = code;
      }),
      ...(opts.signal
        ? [
            new Promise<void>((_, reject) => {
              if (opts.signal?.aborted) reject(new Error("Subagent was aborted"));
              else
                opts.signal?.addEventListener(
                  "abort",
                  () => reject(new Error("Subagent was aborted")),
                  { once: true },
                );
            }),
          ]
        : []),
    ]);

    if (sawAgentEnd) {
      // Give a short grace period for the process to exit naturally.
      // If it doesn't, terminate it so we don't hang.
      const GRACE_MS = 250;
      const exited = await Promise.race([
        stream.exitCode.then((code) => {
          current.exitCode = code;
          return true as const;
        }),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), GRACE_MS)),
      ]);

      if (!exited) {
        stream.terminate();
        // Wait briefly for the terminated process to actually close.
        current.exitCode = await Promise.race([
          stream.exitCode,
          new Promise<number>((resolve) => setTimeout(() => resolve(0), 500)),
        ]);
      }
    }

    // If we got here via exitCode (no agent_end), drain remaining stdout briefly.
    if (!sawAgentEnd) {
      await Promise.race([drainStdout, new Promise<void>((resolve) => setTimeout(resolve, 250))]);
    }

    // Find the session file that pi created in our temp session dir.
    try {
      const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
      if (files.length > 0) {
        current.sessionFile = path.join(sessionDir, files[0]);
      }
    } catch {
      /* ignore — session dir may not exist if process failed early */
    }

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
    requestedModel: t.agent.requestedModel,
    resolvedProvider: t.agent.resolvedProvider,
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
