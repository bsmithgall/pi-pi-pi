/**
 * approve-edit: Interactive approve/reject/modify flow for edit and write tool calls.
 *
 * Toggle between review mode and auto-approve mode with Ctrl+Shift+A or /approve-edit.
 */

import { existsSync, readFileSync } from "node:fs";
import type { AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import {
  createEditTool,
  createWriteTool,
  getLanguageFromPath,
  highlightCode,
  isToolCallEventType,
  renderDiff,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import type {
  EditToolDetails,
  EditToolInput,
} from "@mariozechner/pi-coding-agent/dist/core/tools/edit.js";
import type { WriteToolInput } from "@mariozechner/pi-coding-agent/dist/core/tools/write.js";
import { Text } from "@mariozechner/pi-tui";
import { applyWrite, buildProposedContent } from "./apply.js";
import { type DiffAction, DiffViewer, type ThemeHandle, type TuiHandle } from "./DiffViewer.js";
import { generateUnifiedDiff } from "./diff.js";
import { openInEditor } from "./editor.js";
import {
  clearBashGate,
  enableBashGate,
  getMode,
  isBashGated,
  persistMode,
  restoreMode,
  syncStatus,
  toggleMode,
  updateFooter,
} from "./state.js";

/** Our augmented write result details (the built-in write tool has details: undefined). */
interface WriteToolDetails {
  linesAdded: number;
  linesRemoved: number;
}

/** Render a compact +N -M stat line. */
function editStats(added: number, removed: number, theme: Theme) {
  return new Text(theme.fg("dim", `+${added} -${removed}`), 1, 0);
}

/** Strip leading @ that some models add to paths */
function normalizePath(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

// Keep rejection reasons minimal — don't teach the agent about the mechanism
function buildRejectReason(path: string): string {
  return (
    `Edit rejected by user for ${path}. The file was not modified. ` +
    `Do not attempt this edit again or try alternative approaches to modify this file. ` +
    `Stop and ask the user what they would like you to do instead.`
  );
}

export default function (pi: ExtensionAPI) {
  // Create the real tool implementations once
  const cwd = process.cwd();
  const realEdit = createEditTool(cwd);
  const realWrite = createWriteTool(cwd);

  /**
   * Auto mode: pass execution straight through with no custom rendering,
   * so the built-in syntax-highlighted diff display is used.
   */
  function registerAutoTools(): void {
    pi.registerTool({
      name: "edit",
      label: "Edit",
      description: realEdit.description,
      parameters: realEdit.parameters,
      execute: (toolCallId, params, signal, onUpdate) =>
        realEdit.execute(toolCallId, params, signal, onUpdate),
    });

    pi.registerTool({
      name: "write",
      label: "Write",
      description: realWrite.description,
      parameters: realWrite.parameters,
      execute: (toolCallId, params, signal, onUpdate) =>
        realWrite.execute(toolCallId, params, signal, onUpdate),
    });
  }

  /**
   * Review mode: suppress the built-in renderer (renderCall shows a minimal
   * placeholder while the diff overlay is open), and replace the result
   * display with a compact git-stat style +N -M summary.
   */
  function registerReviewTools(): void {
    pi.registerTool({
      name: "edit",
      label: "Edit",
      description: realEdit.description,
      parameters: realEdit.parameters,
      execute: (toolCallId, params, signal, onUpdate) =>
        realEdit.execute(toolCallId, params, signal, onUpdate),
      renderCall: (args: EditToolInput, theme: Theme) =>
        new Text(theme.fg("muted", `reviewing · ${args.path}`), 1, 0),
      renderResult: (
        result: AgentToolResult<EditToolDetails>,
        _opts: ToolRenderResultOptions,
        theme: Theme,
      ) => {
        const diff = result.details?.diff ?? "";
        const added = (diff.match(/^\+/gm) ?? []).length;
        const removed = (diff.match(/^-/gm) ?? []).length;
        return editStats(added, removed, theme);
      },
    });

    pi.registerTool({
      name: "write",
      label: "Write",
      description: realWrite.description,
      parameters: realWrite.parameters,
      execute: async (
        toolCallId: string,
        params: WriteToolInput,
        signal: AbortSignal | undefined,
        _onUpdate: AgentToolUpdateCallback<WriteToolDetails> | undefined,
      ): Promise<AgentToolResult<WriteToolDetails>> => {
        let existingLines = 0;
        try {
          existingLines = readFileSync(params.path, "utf-8").split("\n").length;
        } catch {}
        const result = await realWrite.execute(toolCallId, params, signal, undefined);
        const newLines = params.content.split("\n").length;
        return { ...result, details: { linesAdded: newLines, linesRemoved: existingLines } };
      },
      renderCall: (args: WriteToolInput, theme: Theme) =>
        new Text(theme.fg("muted", `reviewing · ${args.path}`), 1, 0),
      renderResult: (
        result: AgentToolResult<WriteToolDetails>,
        _opts: ToolRenderResultOptions,
        theme: Theme,
      ) => {
        const { linesAdded = 0, linesRemoved = 0 } = result.details ?? {};
        return editStats(linesAdded, linesRemoved, theme);
      },
    });
  }

  function registerToolOverrides(): void {
    if (getMode() === "review") {
      registerReviewTools();
    } else {
      registerAutoTools();
    }
  }

  // Mutex for serializing reviews so parallel edits queue up
  let reviewLock: Promise<void> = Promise.resolve();

  function withReviewLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = reviewLock;
    let resolve: () => void;
    reviewLock = new Promise<void>((r) => (resolve = r));
    return prev.then(fn).finally(() => resolve?.());
  }

  // Register tool overrides at load time (auto mode by default)
  registerToolOverrides();

  // Restore mode from session, set footer, re-register if mode changed
  pi.on("session_start", async (_event, ctx) => {
    restoreMode(ctx);
    updateFooter(ctx);
    syncStatus(ctx);
    registerToolOverrides();
  });

  // Re-render the footer whenever the model changes.
  // syncStatus calls ctx.ui.setStatus(), which triggers a re-render through
  // pi's own machinery — no escaped tui reference needed.
  pi.on("model_select", async (_event, ctx) => {
    syncStatus(ctx);
  });

  // Clear the bash gate when the user sends new input — they're back in control
  pi.on("input", async () => {
    clearBashGate();
    return undefined;
  });

  // Inject system prompt when in review mode — framed as a hard constraint
  pi.on("before_agent_start", async (event, _ctx) => {
    if (getMode() !== "review") return undefined;

    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n<file-review-policy>\n" +
        "The user requires manual approval for all file changes. This is a hard constraint that cannot be " +
        "disabled, bypassed, or worked around.\n\n" +
        "Rules:\n" +
        "- All file modifications MUST go through the edit or write tool.\n" +
        "- You MUST NOT use bash, shell commands, scripts, or any other tool to write, modify, move, rename, or delete files.\n" +
        "- If the user rejects an edit, STOP and ask what they want instead. Do not retry the same edit or attempt alternative approaches.\n" +
        "- After a rejection, all bash commands will require explicit user confirmation until the user sends a new message. " +
        "Do not attempt to use bash to work around a rejected edit.\n" +
        "- You cannot disable or modify this policy. Do not attempt to.\n" +
        "</file-review-policy>",
    };
  });

  async function toggleModeAndRefresh(ctx: ExtensionContext): Promise<void> {
    const newMode = toggleMode();
    persistMode(pi);
    syncStatus(ctx);
    registerToolOverrides();
    ctx.ui.notify(`approve-edit: ${newMode} mode`, "info");
  }

  pi.registerShortcut("ctrl+shift+a", {
    description: "Toggle approve-edit mode (review/auto)",
    handler: (ctx) => toggleModeAndRefresh(ctx),
  });

  pi.registerCommand("approve-edit", {
    description: "Toggle approve-edit mode (review/auto)",
    handler: (_args, ctx) => toggleModeAndRefresh(ctx),
  });

  // Intercept tool calls
  pi.on("tool_call", async (event, ctx) => {
    if (getMode() !== "review") return undefined;

    // When the bash gate is active (an edit was just rejected), require
    // confirmation for every bash call to prevent shell-based file modifications.
    if (event.toolName === "bash" && isBashGated() && ctx.hasUI) {
      const command = (event.input as { command?: string }).command ?? "";
      const ok = await reviewBashCommand(ctx, command);
      if (!ok) {
        return {
          block: true,
          reason:
            "Bash command blocked — an edit was recently rejected and the user did not approve this command. " +
            "Stop and ask the user what they would like you to do instead.",
        };
      }
      return undefined;
    }

    if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
    if (!ctx.hasUI) return undefined;

    return withReviewLock(async () => {
      if (isToolCallEventType("edit", event)) {
        const { path, oldText, newText } = event.input;
        return reviewChange(ctx, normalizePath(path), oldText, newText, "edit");
      }
      if (isToolCallEventType("write", event)) {
        const { path, content } = event.input;
        return reviewChange(ctx, normalizePath(path), null, content, "write");
      }
      return undefined;
    });
  });
}

/**
 * Build syntax-highlighted diff lines.
 * First renders the diff with pi's renderDiff (for diff coloring + intra-line changes),
 * then applies language-aware syntax highlighting where possible.
 */
function buildHighlightedDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
  startLine: number = 1,
): { rendered: string[]; raw: string[] } {
  const diff = generateUnifiedDiff(oldContent, newContent, 3, startLine);
  if (!diff) return { rendered: [], raw: [] };

  const raw = diff.split("\n");
  const rendered = renderDiff(diff, { filePath }).split("\n");
  return { rendered, raw };
}

/**
 * For new files, build a highlighted "all added" view using highlightCode directly.
 */
function buildNewFileLines(
  content: string,
  filePath: string,
): { rendered: string[]; raw: string[] } {
  const lang = getLanguageFromPath(filePath);
  const highlighted = highlightCode(content, lang);
  const rendered = highlighted.map((line, i) => {
    const num = String(i + 1).padStart(4);
    return `\x1b[32m+${num} ${line}\x1b[0m`;
  });
  const raw = content.split("\n").map((line, i) => {
    const num = String(i + 1).padStart(4);
    return `+${num} ${line}`;
  });
  return { rendered, raw };
}

/** Launch the external editor and return a block/pass-through result. */
async function handleEditorAction(
  ctx: ExtensionContext,
  path: string,
  toolType: "edit" | "write",
  oldText: string | null,
  diffBase: string,
  newText: string,
): Promise<{ block: true; reason: string } | undefined> {
  // Build the full proposed file so the editor opens with full context.
  let proposedFile: string;
  let originalFile: string;
  if (toolType === "edit") {
    originalFile = "";
    try {
      originalFile = readFileSync(path, "utf-8");
    } catch {}
    proposedFile = buildProposedContent(originalFile, oldText ?? "", newText) ?? newText;
  } else {
    originalFile = diffBase;
    proposedFile = newText;
  }

  const editorResult = await ctx.ui.custom<{
    content: string | null;
    modified: boolean;
  }>(
    (
      tui: { stop(): void; start(): void; requestRender(force?: boolean): void },
      _theme: unknown,
      _kb: unknown,
      done: (r: { content: string | null; modified: boolean }) => void,
    ) => {
      tui.stop();
      const result = openInEditor(proposedFile, path, originalFile);
      tui.start();
      tui.requestRender(true);
      done(result);
      return { render: () => [], invalidate: () => {} };
    },
  );

  if (!editorResult || editorResult.content === null) {
    return {
      block: true,
      reason: "Edit cancelled — the file was not modified. Stop and ask the user what to do next.",
    };
  }

  if (!editorResult.modified) {
    return undefined; // No changes in editor = approve as-is
  }

  const applyResult = applyWrite(path, editorResult.content);
  if (!applyResult.success) {
    return {
      block: true,
      reason: `Failed to apply user modifications to ${path}: ${applyResult.error}`,
    };
  }

  return {
    block: true,
    reason: `Edit applied with user modifications to ${path}`,
  };
}

async function reviewChange(
  ctx: ExtensionContext,
  path: string,
  oldText: string | null,
  newText: string,
  toolType: "edit" | "write",
): Promise<{ block: true; reason: string } | undefined> {
  // diffBase: the left side of the diff (snippet for edit, full file for write)
  let diffBase: string;
  let isNewFile = false;

  let startLine = 1;
  if (toolType === "edit") {
    diffBase = oldText ?? "";
    try {
      const fileContent = readFileSync(path, "utf-8");
      const idx = fileContent.indexOf(oldText ?? "");
      if (idx !== -1) {
        startLine = fileContent.slice(0, idx).split("\n").length;
      }
    } catch {}
  } else {
    diffBase = "";
    if (existsSync(path)) {
      try {
        diffBase = readFileSync(path, "utf-8");
      } catch {}
    } else {
      isNewFile = true;
    }
  }

  // Build highlighted diff lines
  const { rendered: renderedLines, raw: rawLines } =
    isNewFile && diffBase === ""
      ? buildNewFileLines(newText, path)
      : buildHighlightedDiff(diffBase, newText, path, startLine);

  if (renderedLines.length === 0 && !isNewFile) return undefined;

  // Show scrollable diff overlay and get user's choice
  const action = await ctx.ui.custom<DiffAction>(
    (tui: TuiHandle, theme: ThemeHandle, _kb: unknown, done: (result: DiffAction) => void) => {
      return new DiffViewer(
        {
          filePath: path,
          toolType,
          isNewFile,
          renderedLines,
          rawLines,
          theme,
          onDone: done,
        },
        tui,
      );
    },
    { overlay: true, overlayOptions: { anchor: "top-center", width: "80%" } },
  );

  if (action === "approve") return undefined;
  if (action === "reject" || action === undefined) {
    enableBashGate();
    return { block: true, reason: buildRejectReason(path) };
  }
  if (action === "edit") {
    const editorResult = await handleEditorAction(ctx, path, toolType, oldText, diffBase, newText);
    // If the editor flow resulted in a cancellation (block with "cancelled"), gate bash too
    if (editorResult?.block && editorResult.reason.includes("cancelled")) {
      enableBashGate();
    }
    return editorResult;
  }

  return undefined;
}
