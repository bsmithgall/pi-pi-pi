/**
 * Real Runner implementation — spawns `pi --mode json` and streams stdout
 * as newline-delimited strings.
 */

import { spawn } from "node:child_process";
import type { Runner } from "./types.js";

export const spawnRunner: Runner = {
  run(args, cwd, signal, onStderr) {
    const proc = spawn("pi", args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stderr.on("data", (chunk: Buffer) => onStderr(chunk.toString()));

    if (signal) {
      const kill = () => proc.kill("SIGTERM");
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });
    }

    const exitCode = new Promise<number>((resolve) => {
      proc.on("exit", (code) => resolve(code ?? 0));
      proc.on("error", () => resolve(1));
    });

    async function* lines(): AsyncGenerator<string> {
      let buffer = "";
      for await (const chunk of proc.stdout) {
        buffer += (chunk as Buffer).toString();
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const line of parts) yield line;
      }
      if (buffer) yield buffer;
    }

    return Object.assign(lines(), {
      exitCode,
      terminate() {
        proc.kill("SIGTERM");
      },
    });
  },
};
