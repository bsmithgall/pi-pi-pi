import { describe, expect, it } from "vitest";
import { executeChain, executeParallel, executeSingle, runSingleAgent } from "../orchestration.js";
import type { Runner } from "../types.js";
import { assistantEvent, fakeRunner, toolResultEvent } from "./fixtures.js";

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
});
