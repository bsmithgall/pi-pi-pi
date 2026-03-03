/**
 * Apply edit/write mutations to disk.
 */

import { readFileSync, writeFileSync } from "node:fs";

export interface ApplyResult {
  success: boolean;
  error?: string;
}

/**
 * Apply an edit (oldText → newText replacement) to a file.
 */
export function applyEdit(filePath: string, oldText: string, newText: string): ApplyResult {
  try {
    const content = readFileSync(filePath, "utf-8");
    const idx = content.indexOf(oldText);
    if (idx === -1) {
      return { success: false, error: `oldText not found in ${filePath}` };
    }
    const updated = content.slice(0, idx) + newText + content.slice(idx + oldText.length);
    writeFileSync(filePath, updated, "utf-8");
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Build the full file content that would result from applying an edit.
 * Returns null if oldText is empty or not found in the file.
 */
export function buildProposedContent(
  currentContent: string,
  oldText: string,
  newText: string,
): string | null {
  if (oldText === "") return null;
  const idx = currentContent.indexOf(oldText);
  if (idx === -1) return null;
  return currentContent.slice(0, idx) + newText + currentContent.slice(idx + oldText.length);
}

/**
 * Apply a write (full file content) to a file.
 */
export function applyWrite(filePath: string, content: string): ApplyResult {
  try {
    writeFileSync(filePath, content, "utf-8");
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}
