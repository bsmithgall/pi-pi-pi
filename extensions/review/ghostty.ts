/**
 * Ghostty pane management via AppleScript.
 *
 * Opens/closes/resizes Ghostty split panes for the review extension.
 */

import { execFile } from "node:child_process";
import { chmodSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { appleScriptEscape, buildLauncherScript, shellEscape } from "./helpers.js";

const execFileAsync = promisify(execFile);

/** Track the Ghostty pane ID and nvim PID so we can close it later. */
let reviewPaneId: string | null = null;
let reviewPanePid: number | null = null;
let launcherFilePath: string | null = null;

async function osascript(script: string): Promise<string> {
  const { stdout } = await execFileAsync("osascript", ["-e", script]);
  return stdout.trim();
}

/**
 * Open a Ghostty split with nvim + diffview.
 * Splits right, resizes so nvim gets ~2/3 of the width.
 */
export async function openReviewPane(diffviewCmd: string, cwd: string): Promise<void> {
  const escapedCwd = shellEscape(cwd);
  const asEscapedCwd = appleScriptEscape(cwd);

  // Get window width so we can compute the resize amount dynamically.
  // After a 50/50 split, we move the divider left by 1/6 of the window
  // width to get a ~1/3 (pi) + ~2/3 (nvim) layout.
  let resizeAmount = 250; // fallback
  try {
    const widthStr = await osascript(`
      tell application "System Events"
        tell process "Ghostty"
          set winSize to size of front window
          return item 1 of winSize
        end tell
      end tell
    `);
    const windowWidth = parseInt(widthStr, 10);
    if (!Number.isNaN(windowWidth)) {
      resizeAmount = Math.round(windowWidth / 6);
    }
  } catch {
    // Fall back to default
  }

  // Find the nvim binary path so we can set it as the surface command.
  let nvimPath = "nvim";
  try {
    const { stdout } = await execFileAsync("which", ["nvim"], {
      timeout: 5_000,
    });
    nvimPath = stdout.trim();
  } catch {
    // Fall back to bare "nvim"
  }

  // Write a launcher script (see buildLauncherScript for details)
  const pidFile = join(tmpdir(), `pi-review-${process.pid}.pid`);
  const launcherFile = join(tmpdir(), `pi-review-${process.pid}.sh`);
  launcherFilePath = launcherFile;
  try {
    unlinkSync(pidFile);
  } catch {
    /* may not exist */
  }

  const launcherScript = buildLauncherScript({
    pidFile,
    cwd: escapedCwd,
    nvimPath: shellEscape(nvimPath),
    diffviewCmd: shellEscape(diffviewCmd),
    launcherFile: shellEscape(launcherFile),
  });

  writeFileSync(launcherFile, launcherScript);
  chmodSync(launcherFile, 0o755);

  const asEscapedLauncher = appleScriptEscape(launcherFile);

  const script = `
    tell application "Ghostty"
      set cfg to new surface configuration
      set command of cfg to "${asEscapedLauncher}"
      set initial working directory of cfg to "${asEscapedCwd}"
      set currentTerm to focused terminal of selected tab of front window
      set newTerm to split currentTerm direction right with configuration cfg
      set paneId to id of newTerm
      perform action "resize_split:left,${resizeAmount}" on newTerm
      return paneId
    end tell
  `;

  reviewPaneId = await osascript(script);

  // Wait for the PID file to be written
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      if (!Number.isNaN(pid)) {
        reviewPanePid = pid;
        try {
          unlinkSync(pidFile);
        } catch {
          /* best effort */
        }
        break;
      }
    } catch {
      // Not yet written
    }
  }
}

/**
 * Close the review pane by killing the launcher shell process, then
 * closing the Ghostty pane by its tracked ID.
 */
export async function closeReviewPane(): Promise<void> {
  if (reviewPanePid) {
    try {
      process.kill(reviewPanePid, "SIGTERM");
    } catch {
      // Already dead
    }
    reviewPanePid = null;
  }

  // Close the Ghostty pane by ID, then refocus the remaining terminal
  if (reviewPaneId) {
    try {
      await osascript(`
        tell application "Ghostty"
          repeat with t in every terminal of selected tab of front window
            if id of t is "${appleScriptEscape(reviewPaneId)}" then
              close t
              exit repeat
            end if
          end repeat
          -- Refocus the remaining terminal (pi pane)
          activate
          focus (focused terminal of selected tab of front window)
        end tell
      `);
    } catch {
      // Pane may already be gone
    }
  }

  // Clean up temp files
  if (launcherFilePath) {
    try {
      unlinkSync(launcherFilePath);
    } catch {
      /* may not exist */
    }
    launcherFilePath = null;
  }

  reviewPaneId = null;
}

/** Whether a review pane is currently open. */
export function hasReviewPane(): boolean {
  return reviewPaneId !== null;
}
