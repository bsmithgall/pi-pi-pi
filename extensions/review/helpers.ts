/** Escape a string for use inside single quotes in a shell script. */
export function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/** Escape a string for use inside double quotes in AppleScript. */
export function appleScriptEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function homeDir(): string {
  const home = process.env.HOME;
  if (!home) throw new Error("HOME environment variable is not set");
  return home;
}

export function xdgDataDir(): string {
  return process.env.XDG_DATA_HOME ?? join(homeDir(), ".local", "share");
}

export function xdgConfigDir(): string {
  return process.env.XDG_CONFIG_HOME ?? join(homeDir(), ".config");
}

import { join } from "node:path";

/**
 * Build the DiffviewOpen command string from user arguments.
 * Only allows alphanumeric, dots, tildes, hyphens, slashes, and carets
 * to prevent shell injection via the rev argument.
 */
export function buildDiffviewCmd(args: string): string {
  const trimmed = args.trim();
  if (!trimmed) return "DiffviewOpen";
  if (trimmed === "--staged" || trimmed === "--cached") return "DiffviewOpen --cached";

  // Sanitize: git revs only contain these characters
  const sanitized = trimmed.replace(/[^a-zA-Z0-9._~\-/^]/g, "");
  if (sanitized !== trimmed) {
    throw new Error(`Invalid characters in rev argument: ${trimmed}`);
  }

  return `DiffviewOpen ${sanitized}`;
}

/**
 * Build the shell launcher script that runs nvim in the Ghostty split.
 *
 * The script:
 * 1. Records its PID so /review close can find it
 * 2. Sets up a SIGTERM trap to forward the signal to nvim
 * 3. Runs nvim in the background and waits for it
 * 4. On nvim exit (normal or signaled), cleans up and closes the pane
 *
 * All string arguments must already be shell-escaped.
 */
export function buildLauncherScript(opts: {
  pidFile: string;
  cwd: string;
  nvimPath: string;
  diffviewCmd: string;
  launcherFile: string;
}): string {
  // Two exit paths:
  // 1. Normal (:qa) — nvim exits cleanly, we close the Ghostty pane
  // 2. SIGTERM (/review close) — we forward to nvim and exit immediately.
  //    Do NOT osascript-close the pane here — focus may have shifted to pi
  //    and we'd close the wrong pane. Node handles it via process death.
  return [
    `#!/bin/sh`,
    // Inherit the full PATH from pi's environment so LSP servers
    // installed via Homebrew/mise are available to nvim.
    `export PATH='${shellEscape(process.env.PATH ?? "")}'`,
    `echo $$ > '${shellEscape(opts.pidFile)}'`,
    `cd '${opts.cwd}'`,
    // Export terminal width so the nvim plugin spec can pick the right layout
    `export DIFFVIEW_COLS=$(tput cols 2>/dev/null || echo 120)`,
    `trap 'kill -TERM "$child" 2>/dev/null; wait "$child"; exit 143' TERM`,
    `'${opts.nvimPath}' -c '${opts.diffviewCmd}' &`,
    `child=$!`,
    `wait "$child"`,
    // Normal exit: clean up and close pane
    `rm -f '${opts.launcherFile}'`,
    `osascript -e 'tell application "Ghostty" to close (focused terminal of selected tab of front window)'`,
  ].join("\n");
}
