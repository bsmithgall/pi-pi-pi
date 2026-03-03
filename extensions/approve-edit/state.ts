/**
 * Mode state management for approve-edit.
 *
 * Holds the current mode (review/auto) in a module-level variable, provides
 * toggle/persist/restore helpers, and updates the footer status indicator.
 * Mode persists across /reload and session restore via pi.appendEntry().
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export type ApproveEditMode = "review" | "auto";

/** Minimal shape of an assistant message's usage block, as returned by the session manager. */
interface AssistantMessageUsage {
  usage?: {
    input?: number;
    output?: number;
    cost?: { total?: number };
  };
}

/** Minimal shape of a custom session entry written by pi.appendEntry(). */
interface CustomSessionEntry {
  customType?: string;
  data?: { mode?: ApproveEditMode };
}

let currentMode: ApproveEditMode = "auto";
let currentTui: { requestRender(force?: boolean): void } | null = null;

/** Trigger a footer re-render — call this when model changes. */
export function triggerFooterRender(): void {
  currentTui?.requestRender(true);
}

export function getMode(): ApproveEditMode {
  return currentMode;
}

export function setMode(mode: ApproveEditMode): void {
  currentMode = mode;
}

export function toggleMode(): ApproveEditMode {
  currentMode = currentMode === "auto" ? "review" : "auto";
  return currentMode;
}

export function updateFooter(ctx: ExtensionContext): void {
  ctx.ui.setFooter((tui, theme, footerData) => {
    currentTui = tui;
    const unsub = footerData.onBranchChange(() => tui.requestRender());

    return {
      dispose: () => {
        currentTui = null;
        unsub();
      },
      invalidate() {},
      render(width: number): string[] {
        // Mode indicator
        const modeStr =
          currentMode === "review" ? theme.fg("accent", "● review") : theme.fg("dim", "○ auto");

        // Git branch
        const branch = footerData.getGitBranch();
        const branchStr = branch ? theme.fg("dim", ` (${branch})`) : "";

        // Other extension statuses (exclude ourselves)
        const statuses = footerData.getExtensionStatuses();
        const otherStatuses: string[] = [];
        for (const [key, text] of statuses.entries()) {
          if (key !== "approve-edit") otherStatuses.push(text);
        }
        const statusSuffix = otherStatuses.length > 0 ? ` ${otherStatuses.join(" ")}` : "";

        // Token stats
        let input = 0,
          output = 0,
          cost = 0;
        for (const e of ctx.sessionManager.getBranch()) {
          if (e.type === "message" && e.message.role === "assistant") {
            const m = e.message as AssistantMessageUsage;
            if (m.usage) {
              input += m.usage.input ?? 0;
              output += m.usage.output ?? 0;
              cost += m.usage.cost?.total ?? 0;
            }
          }
        }
        const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
        const stats = theme.fg("dim", `↑${fmt(input)} ↓${fmt(output)} $${cost.toFixed(3)}`);
        const model = theme.fg("dim", ctx.model?.id ?? "no-model");

        // Context usage percentage
        const usage = ctx.getContextUsage();
        const ctxStr =
          usage?.percent != null
            ? theme.fg(usage.percent > 80 ? "warning" : "dim", ` ${Math.round(usage.percent)}%`)
            : "";

        // Build two lines: pwd + mode | stats + context% + model + branch
        const pwd = theme.fg("dim", truncateToWidth(ctx.cwd, width));
        const left = `${stats + ctxStr}  ${model}${branchStr}`;
        const right = modeStr + statusSuffix;
        const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
        const infoLine = truncateToWidth(left + pad + right, width);

        return [pwd, infoLine];
      },
    };
  });
}

export function persistMode(pi: ExtensionAPI): void {
  pi.appendEntry("approve-edit-state", { mode: currentMode });
}

export function restoreMode(ctx: ExtensionContext): void {
  // Scan entries backwards (most recent first) for the last mode toggle.
  // Uses getEntries() per the pi docs pattern for appendEntry restoration.
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry.type === "custom" &&
      (entry as CustomSessionEntry).customType === "approve-edit-state"
    ) {
      const data = (entry as CustomSessionEntry).data;
      if (data?.mode === "review" || data?.mode === "auto") {
        currentMode = data.mode;
        return;
      }
    }
  }
}
