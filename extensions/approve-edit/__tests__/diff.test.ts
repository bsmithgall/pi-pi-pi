import { describe, expect, it } from "vitest";
import { generateUnifiedDiff } from "../diff.js";

describe("generateUnifiedDiff", () => {
  it("returns empty string for identical content", () => {
    expect(generateUnifiedDiff("a\nb\nc", "a\nb\nc")).toBe("");
  });

  it("detects a single line change", () => {
    const diff = generateUnifiedDiff("a\nb\nc", "a\nB\nc");
    expect(diff).toContain("@@");
    expect(diff).toContain("-");
    expect(diff).toContain("+");
    // Old line b removed, new line B added
    const lines = diff.split("\n");
    expect(lines.some((l) => l.match(/^-\s*\d+\s+b$/))).toBe(true);
    expect(lines.some((l) => l.match(/^\+\s*\d+\s+B$/))).toBe(true);
  });

  it("detects insertions", () => {
    const diff = generateUnifiedDiff("a\nc", "a\nb\nc");
    expect(diff).toContain("@@");
    expect(diff).toContain("+");
    const lines = diff.split("\n");
    expect(lines.some((l) => l.match(/^\+\s*\d+\s+b$/))).toBe(true);
  });

  it("detects deletions", () => {
    const diff = generateUnifiedDiff("a\nb\nc", "a\nc");
    expect(diff).toContain("@@");
    const lines = diff.split("\n");
    expect(lines.some((l) => l.match(/^-\s*\d+\s+b$/))).toBe(true);
  });

  it("includes context lines around changes", () => {
    const old = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10";
    const neu = "1\n2\n3\n4\nFIVE\n6\n7\n8\n9\n10";
    const diff = generateUnifiedDiff(old, neu);
    // With default context=3, a change at line 5 should produce
    // 3 context lines before (2,3,4) and 3 after (6,7,8) = 6 context lines
    const contextCount = diff.split("\n").filter((l) => l.match(/^ +\d+ /)).length;
    expect(contextCount).toBe(6);
  });

  it("produces separate hunks for distant changes", () => {
    const lines = Array.from({ length: 20 }, (_, i) => String(i + 1));
    const modified = [...lines];
    modified[1] = "CHANGED"; // line 2
    modified[18] = "CHANGED"; // line 19
    const diff = generateUnifiedDiff(lines.join("\n"), modified.join("\n"));
    const hunkHeaders = diff.split("\n").filter((l) => l.startsWith("@@"));
    expect(hunkHeaders.length).toBe(2);
  });

  it("handles empty old content (new file)", () => {
    const diff = generateUnifiedDiff("", "hello\nworld");
    expect(diff).toContain("@@");
    const lines = diff.split("\n");
    expect(lines.filter((l) => l.startsWith("+")).length).toBe(2);
  });

  it("handles empty new content (file deleted)", () => {
    const diff = generateUnifiedDiff("hello\nworld", "");
    expect(diff).toContain("@@");
    const lines = diff.split("\n");
    expect(lines.filter((l) => l.startsWith("-")).length).toBe(2);
  });

  it("respects custom context lines parameter", () => {
    // 20 lines, change at line 11 (index 10, value "10" → "TEN")
    const old = Array.from({ length: 20 }, (_, i) => String(i)).join("\n");
    const neu = old.replace("10", "TEN");
    const diff1 = generateUnifiedDiff(old, neu, 1);
    const diff3 = generateUnifiedDiff(old, neu, 3);
    const ctx1 = diff1.split("\n").filter((l) => l.match(/^ +\d+ /)).length;
    const ctx3 = diff3.split("\n").filter((l) => l.match(/^ +\d+ /)).length;
    // contextLines=1 → 1 before + 1 after = 2 context lines
    expect(ctx1).toBe(2);
    expect(ctx3).toBe(6);
  });
});
