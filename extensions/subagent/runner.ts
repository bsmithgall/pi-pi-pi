/**
 * Real Runner implementation — spawns `pi --mode json` and streams stdout
 * as newline-delimited strings.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { Runner } from "./types.js";

/**
 * Resolve the command + args needed to invoke `pi` as a subprocess.
 *
 * When the current process was launched via a script (e.g.
 * `node /path/to/pi`), we re-use that exact invocation so the child
 * works even when `pi` isn't on PATH (common when running from a
 * directory with its own package.json / node_modules).
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  // Fallback: if the binary itself *is* pi (standalone / pkg build),
  // invoke it directly.
  const execName = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

export const spawnRunner: Runner = {
  run(args, cwd, signal, onStderr) {
    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
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
