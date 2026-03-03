/**
 * External editor flow with diff support.
 *
 * Writes the original and proposed content to temp files, then launches the
 * editor in diff mode where supported:
 *   - nvim/vim: nvim -d original proposed (vimdiff)
 *   - code: code --diff original proposed --wait
 *   - fallback: just opens the proposed file
 *
 * The user edits the proposed side; we read it back and detect modifications.
 * Must be called inside ctx.ui.custom() after tui.stop() and before tui.start().
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

export interface EditorResult {
  /** The content after editing. null if cancelled/error. */
  content: string | null;
  /** Whether the user modified the content from the original. */
  modified: boolean;
}

function getEditor(): string {
  return process.env.VISUAL || process.env.EDITOR || "vim";
}

/** Extract the base command name from an editor string (e.g. "/usr/bin/nvim" → "nvim") */
export function editorName(editor: string): string {
  // Handle cases like "nvim --flag", "/usr/local/bin/nvim", "code"
  const first = editor.split(/\s+/)[0];
  return basename(first).toLowerCase();
}

export interface DiffLaunch {
  cmd: string;
  args: string[];
}

/**
 * Build the command + args to launch the editor in diff mode.
 * Returns the proposed file path as the editable target.
 */
export function buildDiffCommand(editor: string, oldFile: string, newFile: string): DiffLaunch {
  const name = editorName(editor);

  switch (name) {
    case "nvim":
    case "vim":
    case "vi":
    case "vimdiff":
    case "nvimdiff":
      // vimdiff mode: left=original (readonly), right=proposed (editable)
      return {
        cmd: name,
        args: ["-d", oldFile, newFile, "-c", "wincmd l"],
      };

    case "code":
    case "code-insiders":
      return { cmd: name, args: ["--diff", oldFile, newFile, "--wait"] };

    default:
      // No known diff mode — just open the proposed file
      return { cmd: editor, args: [newFile] };
  }
}

/**
 * Open original and proposed content in an external editor with diff view.
 * The user edits the proposed file; we read it back.
 *
 * @param originalContent The current/old file content (shown as read-only reference)
 * @param proposedContent The proposed new content (editable by the user)
 * @param filePath The real file path (used for extension/syntax highlighting)
 */
export function openInEditor(
  proposedContent: string,
  filePath: string,
  originalContent?: string,
): EditorResult {
  const ext = extname(filePath) || ".txt";
  const base = basename(filePath, ext);
  const dir = mkdtempSync(join(tmpdir(), "pi-edit-"));
  const newFile = join(dir, `${base}.proposed${ext}`);
  const oldFile = join(dir, `${base}.original${ext}`);

  try {
    writeFileSync(newFile, proposedContent, "utf-8");

    const editor = getEditor();
    let launch: DiffLaunch;

    if (originalContent !== undefined && originalContent !== proposedContent) {
      // Write original as read-only reference
      writeFileSync(oldFile, originalContent, "utf-8");
      chmodSync(oldFile, 0o444);
      launch = buildDiffCommand(editor, oldFile, newFile);
    } else {
      // No original to diff against — just open the file
      launch = { cmd: editor, args: [newFile] };
    }

    const result = spawnSync(launch.cmd, launch.args, {
      stdio: "inherit",
      env: process.env,
    });

    if (result.status !== 0) {
      return { content: null, modified: false };
    }

    const edited = readFileSync(newFile, "utf-8");
    const modified = edited !== proposedContent;

    return { content: edited, modified };
  } catch {
    return { content: null, modified: false };
  } finally {
    try {
      unlinkSync(newFile);
    } catch {}
    try {
      unlinkSync(oldFile);
    } catch {}
    try {
      rmdirSync(dir);
    } catch {}
  }
}
