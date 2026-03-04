/**
 * TUI rendering for the subagent extension — renderCall, renderResult,
 * and shared rendering building blocks.
 */

import * as os from "node:os";
import type { AgentToolResult } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme, type ThemeColor } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import {
  agentDisplayName,
  aggregateUsage,
  formatUsageStats,
  getDisplayItems,
  getFinalOutput,
  isAgentError,
} from "./helpers.js";
import type { AgentSpec, DisplayItem, SingleResult, SubagentDetails } from "./types.js";

/** Max items shown per result in collapsed multi-result views (chain/parallel). */
const COLLAPSED_STEP_ITEM_COUNT = 5;

/** Max items shown in collapsed single-result view. */
const COLLAPSED_ITEM_COUNT = 10;

/** Max steps/tasks previewed in renderCall. */
const CALL_PREVIEW_LIMIT = 3;

// The "read" tool has shipped with both "file_path" and "path" as parameter
// names across versions. We check both to handle either schema gracefully.
type ThemeFg = (color: ThemeColor, text: string) => string;

function shortenPath(p: string): string {
  const home = os.homedir();
  return typeof p === "string" && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: ThemeFg,
): string {
  switch (toolName) {
    case "bash": {
      const cmd = String(args.command ?? "...");
      const preview = cmd.length > 60 ? `${cmd.slice(0, 60)}...` : cmd;
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
    }
    case "read": {
      // Both "file_path" and "path" have been used across pi versions.
      const raw = String(args.file_path ?? args.path ?? "...");
      const fp = shortenPath(raw);
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = themeFg("accent", fp);
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 1;
        const end = limit !== undefined ? start + limit - 1 : "";
        text += themeFg("warning", `:${start}${end !== "" ? `-${end}` : ""}`);
      }
      return themeFg("muted", "read ") + text;
    }
    case "write": {
      const raw = String(args.file_path ?? args.path ?? "...");
      const content = String(args.content ?? "");
      const lines = content.split("\n").length;
      return (
        themeFg("muted", "write ") +
        themeFg("accent", shortenPath(raw)) +
        (lines > 1 ? themeFg("dim", ` (${lines} lines)`) : "")
      );
    }
    case "edit":
      return (
        themeFg("muted", "edit ") +
        themeFg("accent", shortenPath(String(args.file_path ?? args.path ?? "...")))
      );
    case "ls":
      return themeFg("muted", "ls ") + themeFg("accent", shortenPath(String(args.path ?? ".")));
    case "find": {
      const pattern = String(args.pattern ?? "*");
      const dir = String(args.path ?? ".");
      return (
        themeFg("muted", "find ") +
        themeFg("accent", pattern) +
        themeFg("dim", ` in ${shortenPath(dir)}`)
      );
    }
    case "grep": {
      const pattern = String(args.pattern ?? "");
      const dir = String(args.path ?? ".");
      return (
        themeFg("muted", "grep ") +
        themeFg("accent", `/${pattern}/`) +
        themeFg("dim", ` in ${shortenPath(dir)}`)
      );
    }
    default: {
      const s = JSON.stringify(args);
      const preview = s.length > 50 ? `${s.slice(0, 50)}...` : s;
      return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
    }
  }
}

interface Theme {
  fg: ThemeFg;
  bold: (text: string) => string;
}

function resultIcon(r: SingleResult, theme: Theme): string {
  if (r.exitCode === -1) return theme.fg("warning", "⏳");
  return isAgentError(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

function nameLabel(r: SingleResult): string {
  return r.model ? `${r.name} (${r.model})` : r.name;
}

function renderItems(
  items: DisplayItem[],
  expanded: boolean,
  theme: Theme,
  limit?: number,
): string {
  const shown = limit ? items.slice(-limit) : items;
  const skipped = limit && items.length > limit ? items.length - limit : 0;
  let text = skipped > 0 ? theme.fg("muted", `… ${skipped} earlier items\n`) : "";
  for (const item of shown) {
    if (item.type === "text") {
      const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
      text += `${theme.fg("toolOutput", preview)}\n`;
    } else {
      text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
    }
  }
  return text.trimEnd();
}

function renderResultBlockExpanded(
  r: SingleResult,
  headerPrefix: string,
  theme: Theme,
  mdTheme: ReturnType<typeof getMarkdownTheme>,
): Container {
  const container = new Container();
  const items = getDisplayItems(r.messages);
  const finalOut = getFinalOutput(r.messages);

  container.addChild(new Text(headerPrefix, 0, 0));
  container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

  for (const item of items) {
    if (item.type === "toolCall") {
      container.addChild(
        new Text(
          theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
          0,
          0,
        ),
      );
    }
  }

  if (finalOut) {
    container.addChild(new Spacer(1));
    container.addChild(new Markdown(finalOut.trim(), 0, 0, mdTheme));
  }

  const usageStr = formatUsageStats(r.usage, r.model);
  if (usageStr) container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));

  return container;
}

function renderResultBlockCollapsed(
  r: SingleResult,
  headerPrefix: string,
  theme: Theme,
  itemLimit: number,
): string {
  const items = getDisplayItems(r.messages);
  let text = headerPrefix;
  if (items.length === 0) {
    text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running…)" : "(no output)")}`;
  } else {
    text += `\n${renderItems(items, false, theme, itemLimit)}`;
  }
  return text;
}

// ── renderCall ──────────────────────────────────────────────────────────────

export function renderCall(args: Record<string, unknown>, theme: Theme): Text {
  const chain = args.chain as Array<{ agent: AgentSpec; task: string }> | undefined;
  const tasks = args.tasks as Array<{ agent: AgentSpec; task: string }> | undefined;

  if (chain && chain.length > 0) {
    let text =
      theme.fg("toolTitle", theme.bold("subagent ")) +
      theme.fg("accent", `chain (${chain.length} steps)`);
    for (let i = 0; i < Math.min(chain.length, CALL_PREVIEW_LIMIT); i++) {
      const step = chain[i];
      const clean = step.task.replace(/\{previous\}/g, "").trim();
      const preview = clean.length > 40 ? `${clean.slice(0, 40)}…` : clean;
      text +=
        "\n  " +
        theme.fg("muted", `${i + 1}.`) +
        " " +
        theme.fg("accent", agentDisplayName(step.agent)) +
        theme.fg("dim", ` ${preview}`);
    }
    if (chain.length > CALL_PREVIEW_LIMIT) {
      text += `\n  ${theme.fg("muted", `… +${chain.length - CALL_PREVIEW_LIMIT} more`)}`;
    }
    return new Text(text, 0, 0);
  }

  if (tasks && tasks.length > 0) {
    let text =
      theme.fg("toolTitle", theme.bold("subagent ")) +
      theme.fg("accent", `parallel (${tasks.length} tasks)`);
    for (const t of tasks.slice(0, CALL_PREVIEW_LIMIT)) {
      const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}…` : t.task;
      text += `\n  ${theme.fg("accent", agentDisplayName(t.agent))}${theme.fg("dim", ` ${preview}`)}`;
    }
    if (tasks.length > CALL_PREVIEW_LIMIT) {
      text += `\n  ${theme.fg("muted", `… +${tasks.length - CALL_PREVIEW_LIMIT} more`)}`;
    }
    return new Text(text, 0, 0);
  }

  const name = args.agent ? agentDisplayName(args.agent as AgentSpec) : "…";
  const task = (args.task as string) ?? "…";
  const preview = task.length > 60 ? `${task.slice(0, 60)}…` : task;
  const model = (args.agent as AgentSpec | undefined)?.model;
  let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", name);
  if (model) text += theme.fg("muted", ` (${model})`);
  text += `\n  ${theme.fg("dim", preview)}`;
  return new Text(text, 0, 0);
}

// ── renderResult ────────────────────────────────────────────────────────────

export function renderResult(
  result: AgentToolResult<SubagentDetails>,
  expanded: boolean,
  theme: Theme,
): Container | Text {
  const details = result.details;
  if (!details || details.results.length === 0) {
    const t = result.content[0];
    return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
  }

  const mdTheme = getMarkdownTheme();

  if (details.mode === "single" && details.results.length === 1) {
    return renderSingleResult(details.results[0], expanded, theme, mdTheme);
  }

  if (details.mode === "chain") {
    return renderChainResult(details, expanded, theme, mdTheme);
  }

  if (details.mode === "parallel") {
    return renderParallelResult(details, expanded, theme, mdTheme);
  }

  const t = result.content[0];
  return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
}

function singleHeader(r: SingleResult, theme: Theme): string {
  const icon = resultIcon(r, theme);
  let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.name))}`;
  if (r.model) header += theme.fg("muted", ` (${r.model})`);
  if (isAgentError(r) && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
  return header;
}

function renderSingleResult(
  r: SingleResult,
  expanded: boolean,
  theme: Theme,
  mdTheme: ReturnType<typeof getMarkdownTheme>,
): Container | Text {
  const err = isAgentError(r);
  const items = getDisplayItems(r.messages);
  const finalOut = getFinalOutput(r.messages);
  const usageStr = formatUsageStats(r.usage, r.model);

  if (expanded) {
    const container = new Container();
    container.addChild(new Text(singleHeader(r, theme), 0, 0));
    if (err && r.errorMessage)
      container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
    container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
    if (items.length === 0 && !finalOut) {
      container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
    } else {
      for (const item of items) {
        if (item.type === "toolCall")
          container.addChild(
            new Text(
              theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
              0,
              0,
            ),
          );
      }
      if (finalOut) {
        container.addChild(new Spacer(1));
        container.addChild(new Markdown(finalOut.trim(), 0, 0, mdTheme));
      }
    }
    if (usageStr) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
    }
    return container;
  }

  let text = singleHeader(r, theme);
  if (err && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
  else if (items.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
  else {
    text += `\n${renderItems(items, false, theme, COLLAPSED_ITEM_COUNT)}`;
    if (items.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
  }
  if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
  return new Text(text, 0, 0);
}

function renderMultiResultExpanded(
  modeLabel: string,
  icon: string,
  statusText: string,
  results: SingleResult[],
  headerFn: (r: SingleResult) => string,
  theme: Theme,
  mdTheme: ReturnType<typeof getMarkdownTheme>,
): Container {
  const container = new Container();
  container.addChild(
    new Text(
      `${icon} ${theme.fg("toolTitle", theme.bold(`${modeLabel} `))}${theme.fg("accent", statusText)}`,
      0,
      0,
    ),
  );
  for (const r of results) {
    container.addChild(new Spacer(1));
    const block = renderResultBlockExpanded(
      r,
      `${headerFn(r)} ${resultIcon(r, theme)}`,
      theme,
      mdTheme,
    );
    for (const child of block.children) container.addChild(child);
  }
  const total = formatUsageStats(aggregateUsage(results));
  if (total) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", `Total: ${total}`), 0, 0));
  }
  return container;
}

function renderMultiResultCollapsed(
  modeLabel: string,
  icon: string,
  statusText: string,
  results: SingleResult[],
  headerFn: (r: SingleResult) => string,
  theme: Theme,
  showTotal: boolean,
): Text {
  let text = `${icon} ${theme.fg("toolTitle", theme.bold(`${modeLabel} `))}${theme.fg("accent", statusText)}`;
  for (const r of results) {
    text += `\n\n${renderResultBlockCollapsed(
      r,
      `${headerFn(r)} ${resultIcon(r, theme)}`,
      theme,
      COLLAPSED_STEP_ITEM_COUNT,
    )}`;
  }
  if (showTotal) {
    const total = formatUsageStats(aggregateUsage(results));
    if (total) text += `\n\n${theme.fg("dim", `Total: ${total}`)}`;
  }
  text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
  return new Text(text, 0, 0);
}

function renderChainResult(
  details: SubagentDetails,
  expanded: boolean,
  theme: Theme,
  mdTheme: ReturnType<typeof getMarkdownTheme>,
): Container | Text {
  const successCount = details.results.filter((r) => r.exitCode === 0).length;
  const icon =
    successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");
  const statusText = `${successCount}/${details.results.length} steps`;
  const headerFn = (r: SingleResult) =>
    `${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", nameLabel(r))}`;

  if (expanded) {
    return renderMultiResultExpanded(
      "chain",
      icon,
      statusText,
      details.results,
      headerFn,
      theme,
      mdTheme,
    );
  }
  return renderMultiResultCollapsed(
    "chain",
    icon,
    statusText,
    details.results,
    headerFn,
    theme,
    true,
  );
}

function renderParallelResult(
  details: SubagentDetails,
  expanded: boolean,
  theme: Theme,
  mdTheme: ReturnType<typeof getMarkdownTheme>,
): Container | Text {
  const running = details.results.filter((r) => r.exitCode === -1).length;
  const successCount = details.results.filter((r) => r.exitCode === 0).length;
  const failCount = details.results.filter((r) => r.exitCode > 0).length;
  const isRunning = running > 0;
  const icon = isRunning
    ? theme.fg("warning", "⏳")
    : failCount > 0
      ? theme.fg("warning", "◐")
      : theme.fg("success", "✓");
  const status = isRunning
    ? `${successCount + failCount}/${details.results.length} done, ${running} running`
    : `${successCount}/${details.results.length} tasks`;
  const headerFn = (r: SingleResult) =>
    `${theme.fg("muted", "─── ")}${theme.fg("accent", nameLabel(r))}`;

  if (expanded && !isRunning) {
    return renderMultiResultExpanded(
      "parallel",
      icon,
      status,
      details.results,
      headerFn,
      theme,
      mdTheme,
    );
  }
  return renderMultiResultCollapsed(
    "parallel",
    icon,
    status,
    details.results,
    headerFn,
    theme,
    !isRunning,
  );
}
