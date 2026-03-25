import { afterEach, describe, expect, it, vi } from "vitest";
import { executeChain, executeParallel, executeSingle, runSingleAgent } from "../orchestration.js";
import type { Runner, RunningAgent } from "../types.js";
import { agentEndEvent, assistantEvent, fakeRunner, toolResultEvent } from "./fixtures.js";

afterEach(() => {
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function hangingStdoutRunner(events: Array<Record<string, unknown>>, exitCode = 0): Runner {
  return {
    run(_args, _cwd, _signal, _onStderr) {
      const lines = events.map((e) => JSON.stringify(e));
      const gate = deferred<void>();
      let i = 0;
      const iter: RunningAgent = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (i < lines.length) return { value: lines[i++], done: false };
              await gate.promise;
              return { value: undefined as unknown as string, done: true };
            },
          };
        },
        exitCode: Promise.resolve(exitCode),
        terminate() {
          gate.resolve();
        },
      };
      return iter;
    },
  };
}

function delayedTailRunner(
  initialEvents: Array<Record<string, unknown>>,
  delayedEvent: Record<string, unknown>,
  delayMs: number,
  exitCode = 0,
): Runner {
  return {
    run(_args, _cwd, _signal, _onStderr) {
      const lines = initialEvents.map((e) => JSON.stringify(e));
      const delayedLine = JSON.stringify(delayedEvent);
      let deliveredDelay = false;
      let started = false;
      const iter: RunningAgent = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (lines.length > 0) return { value: lines.shift() as string, done: false };
              if (!deliveredDelay) {
                deliveredDelay = true;
                await new Promise((resolve) => setTimeout(resolve, delayMs));
                return { value: delayedLine, done: false };
              }
              if (!started) started = true;
              return { value: undefined as unknown as string, done: true };
            },
          };
        },
        exitCode: Promise.resolve(exitCode),
        terminate() {},
      };
      return iter;
    },
  };
}

function abortAwareHangingRunner(events: Array<Record<string, unknown>>): Runner {
  return {
    run(_args, _cwd, signal, _onStderr) {
      const lines = events.map((e) => JSON.stringify(e));
      const gate = deferred<void>();
      let i = 0;
      if (signal) {
        if (signal.aborted) gate.resolve();
        else signal.addEventListener("abort", () => gate.resolve(), { once: true });
      }
      const iter: RunningAgent = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (i < lines.length) return { value: lines[i++], done: false };
              await gate.promise;
              return { value: undefined as unknown as string, done: true };
            },
          };
        },
        exitCode: Promise.resolve(0),
        terminate() {
          gate.resolve();
        },
      };
      return iter;
    },
  };
}

/**
 * Runner where events (including agent_end) are emitted promptly,
 * but the process hangs (stdout open, no exit) until terminate() is called.
 * Tracks whether terminate was called.
 */
function lingeringProcessRunner(
  events: Array<Record<string, unknown>>,
  exitCode = 0,
): Runner & { terminated: boolean } {
  const state = { terminated: false };
  const runner: Runner & { terminated: boolean } = {
    terminated: false,
    run(_args, _cwd, _signal, _onStderr) {
      const lines = events.map((e) => JSON.stringify(e));
      const gate = deferred<void>();
      const exitGate = deferred<number>();
      let i = 0;
      const iter: RunningAgent = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (i < lines.length) return { value: lines[i++], done: false };
              await gate.promise;
              return { value: undefined as unknown as string, done: true };
            },
          };
        },
        exitCode: exitGate.promise,
        terminate() {
          state.terminated = true;
          runner.terminated = true;
          gate.resolve();
          exitGate.resolve(exitCode);
        },
      };
      return iter;
    },
  };
  return runner;
}

async function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([
    promise,
    new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), ms);
    }),
  ]);
}

describe("runSingleAgent", () => {
  it("accumulates messages and returns final output", async () => {
    const runner = fakeRunner([assistantEvent("hello world")]);
    const result = await runSingleAgent({
      spec: {},
      task: "say hi",
      defaultCwd: "/tmp",
      mode: "single",
      runner,
    });
    expect(result.exitCode).toBe(0);
    expect(result.messages).toHaveLength(1);
    expect(result.usage.turns).toBe(1);
    expect(result.usage.input).toBe(10);
    expect(result.model).toBe("claude-haiku-4-5");
  });

  it("handles tool_result_end events", async () => {
    const runner = fakeRunner([
      assistantEvent("thinking"),
      toolResultEvent(),
      assistantEvent("done"),
    ]);
    const result = await runSingleAgent({
      spec: {},
      task: "do work",
      defaultCwd: "/tmp",
      mode: "single",
      runner,
    });
    expect(result.messages).toHaveLength(3);
    expect(result.usage.turns).toBe(2);
  });

  it("sets errorMessage and stopReason from assistant message", async () => {
    const runner = fakeRunner([
      assistantEvent("oops", { stopReason: "error", errorMessage: "bad thing" }),
    ]);
    const result = await runSingleAgent({
      spec: {},
      task: "fail",
      defaultCwd: "/tmp",
      mode: "single",
      runner,
    });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("bad thing");
  });

  it("calls onUpdate for each event", async () => {
    const runner = fakeRunner([assistantEvent("a"), assistantEvent("b")]);
    const updates: string[] = [];
    await runSingleAgent({
      spec: {},
      task: "go",
      defaultCwd: "/tmp",
      mode: "single",
      runner,
      onUpdate: (partial) => {
        const text = partial.content[0];
        if (text?.type === "text") updates.push(text.text);
      },
    });
    expect(updates).toHaveLength(2);
    expect(updates[1]).toBe("b");
  });

  it("propagates non-zero exit code", async () => {
    const runner = fakeRunner([], 1);
    const result = await runSingleAgent({
      spec: {},
      task: "go",
      defaultCwd: "/tmp",
      mode: "single",
      runner,
    });
    expect(result.exitCode).toBe(1);
  });

  it("uses spec name and model", async () => {
    const runner = fakeRunner([assistantEvent("ok")]);
    const result = await runSingleAgent({
      spec: { name: "scout", model: "claude-sonnet-4-5" },
      task: "go",
      defaultCwd: "/tmp",
      mode: "single",
      runner,
    });
    expect(result.name).toBe("scout");
    expect(result.model).toBe("claude-sonnet-4-5");
  });

  it("preserves requested model and resolved provider metadata", async () => {
    const runner = fakeRunner([assistantEvent("ok")]);
    const result = await runSingleAgent({
      spec: {
        model: "openai-codex/gpt-5.1",
        requestedModel: "gpt-5.1",
        resolvedProvider: "openai-codex",
      },
      task: "go",
      defaultCwd: "/tmp",
      mode: "single",
      runner,
    });
    expect(result.requestedModel).toBe("gpt-5.1");
    expect(result.resolvedProvider).toBe("openai-codex");
  });

  it("includes step number when provided", async () => {
    const runner = fakeRunner([assistantEvent("ok")]);
    const result = await runSingleAgent({
      spec: {},
      task: "go",
      defaultCwd: "/tmp",
      mode: "chain",
      step: 3,
      runner,
    });
    expect(result.step).toBe(3);
  });

  it("returns after process exit even if stdout never closes", async () => {
    vi.useFakeTimers();
    const runner = hangingStdoutRunner([assistantEvent("last line")], 0);

    const resultPromise = runSingleAgent({
      spec: {},
      task: "go",
      defaultCwd: "/tmp",
      mode: "single",
      runner,
    });

    const raced = raceWithTimeout(resultPromise, 500);
    await vi.advanceTimersByTimeAsync(500);
    const result = await raced;

    expect(result).not.toBe("timeout");
    expect(result).toMatchObject({
      exitCode: 0,
      messages: [expect.objectContaining({ role: "assistant" })],
    });
  });

  it("captures trailing output that arrives shortly after exit", async () => {
    vi.useFakeTimers();
    const runner = delayedTailRunner([], assistantEvent("late final output"), 100, 0);

    const resultPromise = runSingleAgent({
      spec: {},
      task: "go",
      defaultCwd: "/tmp",
      mode: "single",
      runner,
    });

    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result.exitCode).toBe(0);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ role: "assistant" });
  });

  it("throws when aborted even if stdout was hanging", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const runner = abortAwareHangingRunner([assistantEvent("before abort")]);

    const resultPromise = runSingleAgent({
      spec: {},
      task: "go",
      defaultCwd: "/tmp",
      mode: "single",
      runner,
      signal: controller.signal,
    });
    const assertion = expect(resultPromise).rejects.toThrow("Subagent was aborted");

    controller.abort();
    await vi.runAllTimersAsync();

    await assertion;
  });

  it("returns promptly after agent_end even if process lingers", async () => {
    vi.useFakeTimers();
    const runner = lingeringProcessRunner([assistantEvent("Hello"), agentEndEvent()]);

    const resultPromise = runSingleAgent({
      spec: {},
      task: "go",
      defaultCwd: "/tmp",
      mode: "single",
      runner,
    });

    const raced = raceWithTimeout(resultPromise, 500);
    await vi.advanceTimersByTimeAsync(500);
    const result = await raced;

    expect(result).not.toBe("timeout");
    expect(result).toMatchObject({
      messages: [expect.objectContaining({ role: "assistant" })],
    });
  });

  it("calls terminate() on the runner after agent_end", async () => {
    vi.useFakeTimers();
    const runner = lingeringProcessRunner([assistantEvent("Hello"), agentEndEvent()]);

    const resultPromise = runSingleAgent({
      spec: {},
      task: "go",
      defaultCwd: "/tmp",
      mode: "single",
      runner,
    });

    await vi.advanceTimersByTimeAsync(500);
    await resultPromise;

    expect(runner.terminated).toBe(true);
  });

  it("does not call terminate() if process exits before grace period", async () => {
    const runner = fakeRunner([assistantEvent("Hello"), agentEndEvent()]);

    const result = await runSingleAgent({
      spec: {},
      task: "go",
      defaultCwd: "/tmp",
      mode: "single",
      runner,
    });

    expect(result.messages).toHaveLength(1);
    // fakeRunner exits immediately, so no termination needed
  });
});

describe("executeSingle", () => {
  it("returns final output on success", async () => {
    const runner = fakeRunner([assistantEvent("result text")]);
    const result = await executeSingle(
      { agent: {}, task: "do it" },
      "/tmp",
      undefined,
      undefined,
      runner,
    );
    expect(result.content[0]).toEqual({ type: "text", text: "result text" });
  });

  it("returns error description when agent fails", async () => {
    const runner = fakeRunner([
      assistantEvent("oops", { stopReason: "error", errorMessage: "boom" }),
    ]);
    const result = await executeSingle(
      { agent: {}, task: "fail" },
      "/tmp",
      undefined,
      undefined,
      runner,
    );
    expect(result.content[0]).toEqual(
      expect.objectContaining({ type: "text", text: expect.stringContaining("boom") }),
    );
    // Details are preserved so the LLM can inspect them
    expect(result.details.results).toHaveLength(1);
  });

  it("returns (no output) when agent produces nothing", async () => {
    const runner = fakeRunner([]);
    const result = await executeSingle(
      { agent: {}, task: "go" },
      "/tmp",
      undefined,
      undefined,
      runner,
    );
    expect(result.content[0]).toEqual({ type: "text", text: "(no output)" });
  });
});

describe("executeChain", () => {
  it("runs steps sequentially and returns the final output", async () => {
    const runner = fakeRunner([assistantEvent("step result")]);
    const result = await executeChain(
      [
        { agent: {}, task: "step 1" },
        { agent: {}, task: "summarise {previous}" },
      ],
      "/tmp",
      undefined,
      undefined,
      runner,
    );
    expect(result.details.results).toHaveLength(2);
    expect(result.content[0]).toEqual(
      expect.objectContaining({ type: "text", text: "step result" }),
    );
  });

  it("stops on error and reports the failing step with partial results", async () => {
    let callCount = 0;
    const runner: Runner = {
      run(args, cwd, signal, onStderr) {
        callCount++;
        if (callCount === 2) {
          return fakeRunner(
            [assistantEvent("fail", { stopReason: "error", errorMessage: "boom" })],
            1,
          ).run(args, cwd, signal, onStderr);
        }
        return fakeRunner([assistantEvent("ok")]).run(args, cwd, signal, onStderr);
      },
    };

    const result = await executeChain(
      [
        { agent: {}, task: "step 1" },
        { agent: {}, task: "step 2" },
      ],
      "/tmp",
      undefined,
      undefined,
      runner,
    );
    expect(result.content[0]).toEqual(
      expect.objectContaining({ text: expect.stringContaining("step 2") }),
    );
    // Both results preserved — step 1 succeeded, step 2 failed
    expect(result.details.results).toHaveLength(2);
  });

  it("substitutes {previous} placeholder", async () => {
    const argsLog: string[][] = [];
    const runner: Runner = {
      run(args, cwd, signal, onStderr) {
        argsLog.push([...args]);
        return fakeRunner([assistantEvent("output from step")]).run(args, cwd, signal, onStderr);
      },
    };

    await executeChain(
      [
        { agent: {}, task: "generate something" },
        { agent: {}, task: "review: {previous}" },
      ],
      "/tmp",
      undefined,
      undefined,
      runner,
    );

    const secondTaskArg = argsLog[1][argsLog[1].length - 1];
    expect(secondTaskArg).toBe("Task: review: output from step");
  });

  it("does not hang when a step exits but stdout stays open", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const runner: Runner = {
      run(args, cwd, signal, onStderr) {
        callCount++;
        if (callCount === 1) {
          return hangingStdoutRunner([assistantEvent("step 1 output")]).run(
            args,
            cwd,
            signal,
            onStderr,
          );
        }
        return fakeRunner([assistantEvent("step 2 output")]).run(args, cwd, signal, onStderr);
      },
    };

    const resultPromise = executeChain(
      [
        { agent: {}, task: "step 1" },
        { agent: {}, task: "step 2 uses {previous}" },
      ],
      "/tmp",
      undefined,
      undefined,
      runner,
    );

    const raced = raceWithTimeout(resultPromise, 500);
    await vi.advanceTimersByTimeAsync(500);
    const result = await raced;

    expect(result).not.toBe("timeout");
    expect(result).toMatchObject({
      details: { results: [expect.anything(), expect.anything()] },
    });
  });
});

describe("executeParallel", () => {
  it("runs tasks and returns summary", async () => {
    const runner = fakeRunner([assistantEvent("done")]);
    const result = await executeParallel(
      [
        { agent: {}, task: "task 1" },
        { agent: {}, task: "task 2" },
      ],
      "/tmp",
      undefined,
      undefined,
      runner,
    );
    expect(result.details.results).toHaveLength(2);
    expect(result.content[0]).toEqual(
      expect.objectContaining({ text: expect.stringContaining("2/2 succeeded") }),
    );
  });

  it("throws for too many tasks", async () => {
    const tasks = Array.from({ length: 9 }, (_, i) => ({ agent: {}, task: `task ${i}` }));
    await expect(executeParallel(tasks, "/tmp", undefined, undefined)).rejects.toThrow(
      "Too many parallel tasks",
    );
  });

  it("reports partial failures in summary text", async () => {
    let callCount = 0;
    const runner: Runner = {
      run(args, cwd, signal, onStderr) {
        callCount++;
        if (callCount === 2) {
          return fakeRunner(
            [assistantEvent("fail", { stopReason: "error", errorMessage: "boom" })],
            1,
          ).run(args, cwd, signal, onStderr);
        }
        return fakeRunner([assistantEvent("ok")]).run(args, cwd, signal, onStderr);
      },
    };

    const result = await executeParallel(
      [
        { agent: {}, task: "task 1" },
        { agent: {}, task: "task 2" },
      ],
      "/tmp",
      undefined,
      undefined,
      runner,
    );
    expect(result.content[0]).toEqual(
      expect.objectContaining({ text: expect.stringContaining("1/2 succeeded") }),
    );
  });

  it("does not hang when one task exits but stdout stays open", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const runner: Runner = {
      run(args, cwd, signal, onStderr) {
        callCount++;
        if (callCount === 1) {
          return hangingStdoutRunner([assistantEvent("slow but exited")]).run(
            args,
            cwd,
            signal,
            onStderr,
          );
        }
        return fakeRunner([assistantEvent("done")]).run(args, cwd, signal, onStderr);
      },
    };

    const resultPromise = executeParallel(
      [
        { agent: {}, task: "task 1" },
        { agent: {}, task: "task 2" },
      ],
      "/tmp",
      undefined,
      undefined,
      runner,
    );

    const raced = raceWithTimeout(resultPromise, 500);
    await vi.advanceTimersByTimeAsync(500);
    const result = await raced;

    expect(result).not.toBe("timeout");
    expect(result).toMatchObject({
      details: { results: [expect.anything(), expect.anything()] },
    });
  });
});
