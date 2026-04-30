/**
 * Scrollable diff viewer overlay with cursor and vim-style navigation.
 *
 * Renders pre-colored diff lines (from renderDiff/highlightCode) inside a
 * box-drawn border with a gutter cursor, vim keybindings (j/k/g/G/{/}/ctrl-u/d),
 * and an action footer (approve/reject/edit). Shown as an overlay via ctx.ui.custom().
 */

import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

export type DiffAction = "approve" | "reject" | "edit";

/** Minimal subset of the TUI API used by DiffViewer. */
export interface TuiHandle {
  requestRender(force?: boolean): void;
}

/** Minimal subset of Theme used by DiffViewer. */
export interface ThemeHandle {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface DiffViewerOptions {
  filePath: string;
  toolType: "edit" | "write";
  isNewFile: boolean;
  /** Pre-rendered diff lines (already ANSI-colored by renderDiff + highlightCode) */
  renderedLines: string[];
  /** Raw (un-colored) diff lines, used for hunk boundary detection */
  rawLines: string[];
  theme: ThemeHandle;
  onDone: (action: DiffAction) => void;
}

export class DiffViewer {
  private cursor = 0;
  private scrollOffset = 0;
  private lines: string[] = [];
  /** Indices into this.lines where @@ hunk headers land */
  private hunkStarts: number[] = [];
  private cachedWidth?: number;
  private cachedOutput?: string[];
  private opts: DiffViewerOptions;
  private tui: TuiHandle;
  private hidden = false;

  constructor(opts: DiffViewerOptions, tui: TuiHandle) {
    this.opts = opts;
    this.tui = tui;
  }

  private buildLines(width: number): void {
    const { renderedLines, rawLines, theme, filePath, toolType, isNewFile } = this.opts;
    // Content area: ║ + space + content + space + ║ = width, so content = width - 4
    const contentWidth = Math.max(10, width - 4);

    this.lines = [];
    this.hunkStarts = [];

    // File info header
    const label = isNewFile ? "new file" : toolType;
    this.lines.push(theme.fg("accent", theme.bold(`${label}: ${filePath}`)));
    this.lines.push("");

    for (let i = 0; i < renderedLines.length; i++) {
      const lineIdx = this.lines.length;
      // Replace tabs with spaces to avoid terminal tab-stop expansion mismatches.
      // pi-tui's visibleWidth counts tabs as 3 columns, but terminals expand them
      // to 8 (or the next tab stop), causing lines to overflow the box border.
      const line = renderedLines[i].replaceAll("\t", "   ");
      const raw = rawLines[i] ?? "";

      if (raw.startsWith("@@")) {
        this.hunkStarts.push(lineIdx);
      }

      if (visibleWidth(line) <= contentWidth) {
        this.lines.push(line);
      } else {
        const wrapped = wrapTextWithAnsi(line, contentWidth);
        for (const wl of wrapped) {
          this.lines.push(wl);
        }
      }
    }

    if (renderedLines.length === 0) {
      this.lines.push(theme.fg("muted", "(no changes)"));
    }
  }

  private moveCursor(to: number): void {
    const max = Math.max(0, this.lines.length - 1);
    this.cursor = Math.max(0, Math.min(to, max));
    this.ensureCursorVisible();
    this.invalidate();
    this.tui.requestRender();
  }

  private ensureCursorVisible(): void {
    const viewHeight = this.getViewHeight();
    if (this.cursor < this.scrollOffset) {
      this.scrollOffset = this.cursor;
    } else if (this.cursor >= this.scrollOffset + viewHeight) {
      this.scrollOffset = this.cursor - viewHeight + 1;
    }
  }

  /** Jump to next hunk header */
  private nextHunk(): void {
    for (const idx of this.hunkStarts) {
      if (idx > this.cursor) {
        this.moveCursor(idx);
        return;
      }
    }
    // No next hunk — go to end
    this.moveCursor(this.lines.length - 1);
  }

  /** Jump to previous hunk header */
  private prevHunk(): void {
    for (let i = this.hunkStarts.length - 1; i >= 0; i--) {
      if (this.hunkStarts[i] < this.cursor) {
        this.moveCursor(this.hunkStarts[i]);
        return;
      }
    }
    // No previous hunk — go to top
    this.moveCursor(0);
  }

  handleInput(data: string): void {
    // Actions
    if (data === "y" || matchesKey(data, Key.enter)) {
      this.opts.onDone("approve");
      return;
    }
    if (data === "n" || matchesKey(data, Key.escape)) {
      this.opts.onDone("reject");
      return;
    }
    if (data === "e") {
      this.opts.onDone("edit");
      return;
    }
    if (data === "h") {
      this.hidden = !this.hidden;
      this.invalidate();
      this.tui.requestRender(true);
      return;
    }

    // Cursor movement
    if (matchesKey(data, Key.up) || data === "k") {
      this.moveCursor(this.cursor - 1);
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.moveCursor(this.cursor + 1);
    } else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
      const half = Math.floor(this.getViewHeight() / 2);
      this.moveCursor(this.cursor - half);
    } else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
      const half = Math.floor(this.getViewHeight() / 2);
      this.moveCursor(this.cursor + half);
    } else if (data === "g") {
      this.moveCursor(0);
    } else if (data === "G") {
      this.moveCursor(this.lines.length - 1);
    } else if (data === "}" || data === "]") {
      this.nextHunk();
    } else if (data === "{" || data === "[") {
      this.prevHunk();
    }
  }

  private getViewHeight(): number {
    // Subtract 4 for: top border, bottom border, footer text, footer border
    return Math.max(3, (process.stdout.rows || 24) - 4);
  }

  render(width: number): string[] {
    if (this.cachedOutput && this.cachedWidth === width) {
      return this.cachedOutput;
    }

    const { theme } = this.opts;

    if (this.hidden) {
      const label = ` diff hidden · h to show · y approve · n reject `;
      const innerWidth = Math.max(visibleWidth(label), 10);
      const boxWidth = innerWidth + 2;
      const pad = Math.max(0, Math.floor((width - boxWidth) / 2));
      const indent = " ".repeat(pad);
      const output = [
        indent + theme.fg("border", `╔${"═".repeat(innerWidth)}╗`),
        indent + theme.fg("border", "║") + theme.fg("muted", label) + theme.fg("border", "║"),
        indent + theme.fg("border", `╚${"═".repeat(innerWidth)}╝`),
      ];
      this.cachedWidth = width;
      this.cachedOutput = output;
      return output;
    }

    const viewHeight = this.getViewHeight();
    const contentWidth = Math.max(10, width - 4);

    this.buildLines(width);

    // Clamp cursor and scroll
    this.cursor = Math.min(this.cursor, Math.max(0, this.lines.length - 1));
    this.ensureCursorVisible();

    const visible = this.lines.slice(this.scrollOffset, this.scrollOffset + viewHeight);
    const output: string[] = [];

    // Top border: ╔═ ... ═╗
    const topFill = Math.max(0, width - 2);
    output.push(theme.fg("border", `╔${"═".repeat(topFill)}╗`));

    // Content rows with cursor indicator
    for (let i = 0; i < viewHeight; i++) {
      if (i < visible.length) {
        const absIndex = this.scrollOffset + i;
        const isCursor = absIndex === this.cursor;
        const gutter = isCursor ? theme.fg("accent", "▌") : " ";
        const content = truncateToWidth(visible[i], contentWidth);
        const vis = visibleWidth(content);
        const pad = Math.max(0, contentWidth - vis);
        output.push(
          theme.fg("border", "║") +
            gutter +
            content +
            " ".repeat(pad) +
            " " +
            theme.fg("border", "║"),
        );
      } else {
        output.push(
          theme.fg("border", "║") + " ".repeat(contentWidth + 2) + theme.fg("border", "║"),
        );
      }
    }

    // Footer info line
    const pos = this.lines.length > 0 ? `${this.cursor + 1}/${this.lines.length}` : "0/0";
    const footerText = ` y approve · n reject · e edit · h hide · jk · []/{} hunk · g/G · ${pos} `;
    const styledFooter = theme.fg("muted", truncateToWidth(footerText, contentWidth + 2));
    const footerVis = visibleWidth(styledFooter);
    const footerFill = Math.max(0, width - 2 - footerVis);
    output.push(
      theme.fg("border", "╚") + styledFooter + theme.fg("border", `${"═".repeat(footerFill)}╝`),
    );

    this.cachedWidth = width;
    this.cachedOutput = output;
    return output;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedOutput = undefined;
  }
}
