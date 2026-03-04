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
  on(event: "error", cb: (err: Error) => void): void;
}

/**
 * Turn a child-process-like object into a newline-delimited async iterable
 * plus an `exitCode` promise. The `close` and `error` listeners are attached
 * eagerly so the event is never missed — even if it fires before stdout is
 * fully drained (a race that's common under parallel load).
 */
export function linesFrom(child: ChildLike): AsyncIterable<string> & { exitCode: Promise<number> } {
  let resolveExit!: (code: number) => void;
  const exitCode = new Promise<number>((res) => {
    resolveExit = res;
  });

  const closed = new Promise<void>((res) => {
    child.on("close", (code: number | null) => {
      resolveExit(code ?? 0);
      res();
    });
    child.on("error", () => {
      resolveExit(1);
      res();
    });
  });

  async function* generate(): AsyncGenerator<string> {
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += (chunk as Buffer).toString();
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) yield line;
    }
    if (buffer) yield buffer;
    await closed;
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
