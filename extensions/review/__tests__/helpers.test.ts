import { spawn } from "node:child_process";
import { chmodSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDiffviewCmd, buildLauncherScript } from "../helpers.js";

// ── buildDiffviewCmd ────────────────────────────────────────────────

describe("buildDiffviewCmd", () => {
  it("returns bare DiffviewOpen for empty input", () => {
    expect(buildDiffviewCmd("")).toBe("DiffviewOpen");
    expect(buildDiffviewCmd("   ")).toBe("DiffviewOpen");
  });

  it("handles --staged flag", () => {
    expect(buildDiffviewCmd("--staged")).toBe("DiffviewOpen --cached");
  });

  it("handles --cached flag", () => {
    expect(buildDiffviewCmd("--cached")).toBe("DiffviewOpen --cached");
  });

  it("passes through valid git revs", () => {
    expect(buildDiffviewCmd("HEAD~3")).toBe("DiffviewOpen HEAD~3");
    expect(buildDiffviewCmd("main")).toBe("DiffviewOpen main");
    expect(buildDiffviewCmd("main...feature/foo")).toBe("DiffviewOpen main...feature/foo");
    expect(buildDiffviewCmd("abc123^")).toBe("DiffviewOpen abc123^");
    expect(buildDiffviewCmd("v1.2.3")).toBe("DiffviewOpen v1.2.3");
    expect(buildDiffviewCmd("HEAD~3..HEAD")).toBe("DiffviewOpen HEAD~3..HEAD");
  });

  it("rejects shell injection attempts", () => {
    expect(() => buildDiffviewCmd("'; rm -rf / #")).toThrow("Invalid characters in rev argument");
    expect(() => buildDiffviewCmd("$(whoami)")).toThrow("Invalid characters in rev argument");
    expect(() => buildDiffviewCmd("HEAD; echo pwned")).toThrow(
      "Invalid characters in rev argument",
    );
    expect(() => buildDiffviewCmd('foo" && rm -rf /')).toThrow(
      "Invalid characters in rev argument",
    );
    expect(() => buildDiffviewCmd("HEAD`whoami`")).toThrow("Invalid characters in rev argument");
  });

  it("trims whitespace from input", () => {
    expect(buildDiffviewCmd("  HEAD~3  ")).toBe("DiffviewOpen HEAD~3");
  });
});

// ── buildLauncherScript ─────────────────────────────────────────────

describe("buildLauncherScript", () => {
  it("generates a script containing a SIGTERM trap", () => {
    const script = buildLauncherScript({
      pidFile: "/tmp/test.pid",
      cwd: "/tmp",
      nvimPath: "/usr/bin/nvim",
      diffviewCmd: "DiffviewOpen",
      launcherFile: "/tmp/test.sh",
    });

    expect(script).toContain("trap");
    expect(script).toContain("TERM");
    expect(script).toContain('kill -TERM "$child"');
  });

  it("runs the command in background with wait (required for trap to work)", () => {
    const script = buildLauncherScript({
      pidFile: "/tmp/test.pid",
      cwd: "/tmp",
      nvimPath: "/usr/bin/nvim",
      diffviewCmd: "DiffviewOpen",
      launcherFile: "/tmp/test.sh",
    });

    expect(script).toContain("&");
    expect(script).toContain("child=$!");
    expect(script).toContain('wait "$child"');
  });

  it("closes the pane on normal exit but not on SIGTERM", () => {
    const script = buildLauncherScript({
      pidFile: "/tmp/test.pid",
      cwd: "/tmp",
      nvimPath: "/usr/bin/nvim",
      diffviewCmd: "DiffviewOpen",
      launcherFile: "/tmp/launcher.sh",
    });

    // Normal exit path includes pane close
    expect(script).toContain("rm -f");
    expect(script).toContain("osascript");
    expect(script).toContain("close");

    // SIGTERM trap does NOT contain osascript (would close wrong pane)
    const trapLine = script.split("\n").find((l) => l.startsWith("trap"));
    expect(trapLine).toBeDefined();
    expect(trapLine).not.toContain("osascript");
  });

  it("uses pre-escaped values for cwd, nvimPath, diffviewCmd", () => {
    const script = buildLauncherScript({
      pidFile: "/tmp/test.pid",
      cwd: "/Users/o'\\''brien/project", // pre-escaped
      nvimPath: "/usr/bin/nvim",
      diffviewCmd: "DiffviewOpen",
      launcherFile: "/tmp/test.sh",
    });

    expect(script).toContain("cd '/Users/o'\\''brien/project'");
  });
});

// ── Signal propagation (integration) ────────────────────────────────

/** Check if a process is alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait for a PID file to contain a valid PID, with timeout. */
async function waitForPidFile(path: string, timeoutMs = 3000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const content = readFileSync(path, "utf-8").trim();
      const pid = parseInt(content, 10);
      if (!Number.isNaN(pid) && pid > 0) return pid;
    } catch {
      // Not yet written
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`PID file ${path} not written within ${timeoutMs}ms`);
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("launcher script signal propagation (integration)", () => {
  it("SIGTERM to shell kills the child process via trap", async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const pidFile = join(tmpdir(), `test-launcher-${suffix}.pid`);
    const launcherFile = join(tmpdir(), `test-launcher-${suffix}.sh`);

    const script = buildLauncherScript({
      pidFile,
      cwd: tmpdir(),
      nvimPath: "/bin/sleep",
      diffviewCmd: "10",
      launcherFile,
    });

    // buildLauncherScript produces: '/bin/sleep' -c '10' &
    // sleep ignores -c so we replace with a plain sleep call.
    const fixedScript = script.replace(/'.+?sleep' -c '10' &/, "sleep 10 &");

    writeFileSync(launcherFile, fixedScript);
    chmodSync(launcherFile, 0o755);

    try {
      const _proc = spawn("/bin/sh", [launcherFile], {
        stdio: "ignore",
        detached: false,
      });

      const shellPid = await waitForPidFile(pidFile);
      await wait(200);

      const { execFileSync } = await import("node:child_process");
      let childPid: number;
      try {
        const pgrepOut = execFileSync("pgrep", ["-P", String(shellPid), "sleep"], {
          encoding: "utf-8",
        }).trim();
        childPid = parseInt(pgrepOut, 10);
      } catch {
        throw new Error("Could not find child sleep process");
      }

      expect(isAlive(shellPid)).toBe(true);
      expect(isAlive(childPid)).toBe(true);

      // Send SIGTERM to the shell (simulates /review close)
      process.kill(shellPid, "SIGTERM");
      await wait(200);

      // Both should be dead — the trap forwards SIGTERM to the child
      expect(isAlive(shellPid)).toBe(false);
      expect(isAlive(childPid)).toBe(false);
    } finally {
      try {
        unlinkSync(launcherFile);
      } catch {}
      try {
        unlinkSync(pidFile);
      } catch {}
    }
  });
});
