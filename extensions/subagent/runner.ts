/**
 * Real Runner implementation — spawns `pi --mode json` and exposes its stdout
 * as an async iterable of newline-delimited strings.
 */

import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import type { Runner } from "./types.js";

/**
 * A minimal subset of ChildProcess used by the line-framing generator.
 * Extracted so tests can supply a fake without spawning a real process.
 */
export interface ChildLike {
  stdout: Readable;
  on(event: "close", cb: (code: number | null) => void): void;
  on(event: "exit", cb: (code: number | null) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
}

/**
 * Turn a child-process-like object into a newline-delimited async iterable
 * plus an `exitCode` promise.
 *
 * `exitCode` is resolved from the **`exit`** event (process exited) rather
 * than `close` (process exited AND all stdio closed). The `close` event can
 * be delayed indefinitely when a grandchild process inherits a pipe fd, which
 * would cause the consumer to hang even though the subagent has finished.
 *
 * Because stdout is fully drained by the async generator before the consumer
 * ever awaits `exitCode`, we don't lose any data by not waiting for `close`.
 */
export function linesFrom(child: ChildLike): AsyncIterable<string> & { exitCode: Promise<number> } {
  let resolveExit!: (code: number) => void;
  let exitResolved = false;
  const exitCode = new Promise<number>((res) => {
    resolveExit = (code: number) => {
      if (!exitResolved) {
        exitResolved = true;
        res(code);
      }
    };
  });

  // Resolve exitCode from whichever fires first: exit, close, or error.
  // `exit` fires when the process exits (regardless of stdio state).
  // `close` fires when stdio streams are also closed — kept as a fallback.
  child.on("exit", (code: number | null) => resolveExit(code ?? 0));
  child.on("close", (code: number | null) => resolveExit(code ?? 0));
  child.on("error", () => resolveExit(1));

  async function* generate(): AsyncGenerator<string> {
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += (chunk as Buffer).toString();
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) yield line;
    }
    if (buffer) yield buffer;
    // No need to await close/exit here — stdout is fully drained, and
    // exitCode is resolved independently. The old `await closed` would
    // hang when `close` was delayed by inherited pipe fds.
  }

  return Object.assign(generate(), { exitCode });
}

export const spawnRunner: Runner = {
  run(args, cwd, signal, onStderr) {
    const proc = spawn("pi", args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stderr.on("data", (chunk: Buffer) => onStderr(chunk.toString()));

    if (signal) {
      const kill = () => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5_000);
      };
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });
    }

    return linesFrom(proc);
  },
};
