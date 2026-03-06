/**
 * File Tools Extension
 *
 * Adds `grep`, `find`, and `ls` to the active tool set at session start.
 *
 * By default pi only activates [read, bash, edit, write], and its system prompt
 * tells the model to "use bash for file operations like ls, rg, find". With these
 * tools active, the system prompt switches its guideline to "prefer grep/find/ls
 * tools over bash for file exploration (faster, respects .gitignore)" — which is
 * what we actually want.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function fileToolsExtension(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    pi.setActiveTools([...new Set([...active, "grep", "find", "ls"])]);
  });
}
