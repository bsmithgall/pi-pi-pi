/**
 * Generate a unified diff string in the format pi's renderDiff() expects:
 *   +lineNum content   (added)
 *   -lineNum content   (removed)
 *    lineNum content   (context)
 *
 * With @@ hunk headers.
 */

export function generateUnifiedDiff(
  oldContent: string,
  newContent: string,
  contextLines: number = 3,
  startLine: number = 1,
): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  const edits = computeEdits(oldLines, newLines);
  const hunks = groupEdits(edits, oldLines, newLines, contextLines, startLine);

  if (hunks.length === 0) return "";

  const output: string[] = [];
  for (const hunk of hunks) {
    output.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    for (const line of hunk.lines) {
      output.push(line);
    }
  }
  return output.join("\n");
}

interface Edit {
  type: "keep" | "insert" | "delete";
  oldIndex?: number;
  newIndex?: number;
}

/**
 * Myers diff algorithm (Eugene W. Myers, "An O(ND) Difference Algorithm", 1986).
 *
 * Walks a shortest-edit-path through the edit graph where:
 *   d = edit distance (number of inserts + deletes so far)
 *   k = diagonal index (x - y); moving right = delete, moving down = insert
 *   v = map of diagonal k → furthest x reached at this edit distance
 *   trace = snapshots of v at each d, used to reconstruct the path
 */
function computeEdits(oldLines: string[], newLines: string[]): Edit[] {
  const n = oldLines.length;
  const m = newLines.length;
  const max = n + m;

  if (max === 0) return [];

  // v[k] = furthest x position reached on diagonal k
  const v = new Map<number, number>();
  v.set(1, 0);
  const trace: Map<number, number>[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));

    for (let k = -d; k <= d; k += 2) {
      // Pick the better adjacent diagonal: down (insert) or right (delete)
      let x: number;
      if (k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))) {
        x = v.get(k + 1) ?? 0; // came from diagonal k+1 → insert
      } else {
        x = (v.get(k - 1) ?? 0) + 1; // came from diagonal k-1 → delete
      }
      let y = x - k;

      // Follow the diagonal (matching lines) as far as possible
      while (x < n && y < m && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }

      v.set(k, x);

      if (x >= n && y >= m) {
        return backtrack(trace, d, n, m, oldLines, newLines);
      }
    }
  }

  return [];
}

/** Walk the trace snapshots backwards to reconstruct the edit sequence. */
function backtrack(
  trace: Map<number, number>[],
  d: number,
  n: number,
  m: number,
  _oldLines: string[],
  _newLines: string[],
): Edit[] {
  const edits: Edit[] = [];
  let cx = n,
    cy = m;

  for (let bd = d; bd > 0; bd--) {
    const bv = trace[bd];
    const bk = cx - cy;

    let prevK: number;
    if (bk === -bd || (bk !== bd && (bv.get(bk - 1) ?? 0) < (bv.get(bk + 1) ?? 0))) {
      prevK = bk + 1;
    } else {
      prevK = bk - 1;
    }

    const prevX = bv.get(prevK) ?? 0;
    const prevY = prevX - prevK;

    while (cx > prevX && cy > prevY) {
      cx--;
      cy--;
      edits.unshift({ type: "keep", oldIndex: cx, newIndex: cy });
    }

    if (cx === prevX) {
      cy--;
      edits.unshift({ type: "insert", newIndex: cy });
    } else {
      cx--;
      edits.unshift({ type: "delete", oldIndex: cx });
    }
  }

  while (cx > 0 && cy > 0) {
    cx--;
    cy--;
    edits.unshift({ type: "keep", oldIndex: cx, newIndex: cy });
  }

  return edits;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

function groupEdits(
  edits: Edit[],
  oldLines: string[],
  newLines: string[],
  contextLines: number,
  startLine: number = 1,
): Hunk[] {
  const changes: number[] = [];
  for (let i = 0; i < edits.length; i++) {
    if (edits[i].type !== "keep") changes.push(i);
  }

  if (changes.length === 0) return [];

  // Group changes within 2*contextLines of each other
  const groups: { start: number; end: number }[] = [];
  let gStart = changes[0],
    gEnd = changes[0];

  for (let i = 1; i < changes.length; i++) {
    if (changes[i] - gEnd <= contextLines * 2) {
      gEnd = changes[i];
    } else {
      groups.push({ start: gStart, end: gEnd });
      gStart = changes[i];
      gEnd = changes[i];
    }
  }
  groups.push({ start: gStart, end: gEnd });

  // Build hunks with context, using line numbers in renderDiff format
  const hunks: Hunk[] = [];
  for (const group of groups) {
    const start = Math.max(0, group.start - contextLines);
    const end = Math.min(edits.length - 1, group.end + contextLines);

    let oldCount = 0,
      newCount = 0;
    const lines: string[] = [];

    let oldStart = startLine,
      newStart = startLine;
    for (let i = 0; i < start; i++) {
      if (edits[i].type !== "insert") oldStart++;
      if (edits[i].type !== "delete") newStart++;
    }

    let oldLine = oldStart;
    let newLine = newStart;

    for (let i = start; i <= end; i++) {
      const edit = edits[i];
      if (edit.type === "keep") {
        // Format: " lineNum content"
        const num = String(oldLine).padStart(4);
        lines.push(` ${num} ${oldLines[edit.oldIndex ?? 0]}`);
        oldLine++;
        newLine++;
        oldCount++;
        newCount++;
      } else if (edit.type === "delete") {
        const num = String(oldLine).padStart(4);
        lines.push(`-${num} ${oldLines[edit.oldIndex ?? 0]}`);
        oldLine++;
        oldCount++;
      } else if (edit.type === "insert") {
        const num = String(newLine).padStart(4);
        lines.push(`+${num} ${newLines[edit.newIndex ?? 0]}`);
        newLine++;
        newCount++;
      }
    }

    hunks.push({ oldStart, oldCount, newStart, newCount, lines });
  }

  return hunks;
}
