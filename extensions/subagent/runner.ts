/**
 * Real Runner implementation — spawns `pi --mode json` and exposes its stdout
 * as an async iterable of newline-delimited strings.
 */

import { spawn } from "node:child_process";
import type { Runner } from "./types.js";

export const spawnRunner: Runner = {
  run(args, cwd, signal, onStderr) {
    let resolveExit!: (code: number) => void;
    const exitCode = new Promise<number>((res) => {
      resolveExit = res;
    });

    async function* lines(): AsyncGenerator<string> {
      const proc = spawn("pi", args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Attach error listener immediately so spawn failures (e.g. pi not on
      // PATH) resolve exitCode even if "close" never fires.
      proc.on("error", () => resolveExit(1));

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

      let buffer = "";
      for await (const chunk of proc.stdout) {
        buffer += (chunk as Buffer).toString();
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const line of parts) yield line;
      }
      if (buffer) yield buffer;

      await new Promise<void>((res) =>
        proc.on("close", (code) => {
          resolveExit(code ?? 0);
          res();
        }),
      );
    }

    const iterable = lines();
    return Object.assign(iterable, { exitCode });
  },
};
