import { describe, expect, it } from "vitest";
import { DiffViewer, type ThemeHandle, type TuiHandle } from "../DiffViewer.js";

function makeTheme(): ThemeHandle {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as ThemeHandle & { bold(text: string): string };
}

function makeTui(): TuiHandle {
  return { requestRender: () => {} };
}

describe("DiffViewer", () => {
  describe("tab handling", () => {
    it("replaces tabs with spaces in rendered lines to prevent terminal overflow", () => {
      const renderedLines = ['+   4 \t"testing"'];
      const rawLines = ['+   4 \t"testing"'];

      const viewer = new DiffViewer(
        {
          filePath: "test.go",
          toolType: "write",
          isNewFile: true,
          renderedLines,
          rawLines,
          theme: makeTheme(),
          onDone: () => {},
        },
        makeTui(),
      );

      // Render at a specific width
      const output = viewer.render(80);

      // No rendered line should contain a literal tab character
      for (const line of output) {
        expect(line).not.toContain("\t");
      }
    });

    it("renders lines within the box width even with tabbed content", () => {
      // Simulate a Go source file with tabs (common in Go code)
      const renderedLines = [
        "+   1 package main",
        "+   2 ",
        "+   3 import (",
        '+   4 \t"testing"',
        "+   5 )",
        "+   6 ",
        "+   7 func TestFoo(t *testing.T) {",
        "+   8 \tif true {",
        '+   9 \t\tt.Log("hello")',
        "+  10 \t}",
        "+  11 }",
      ];
      const rawLines = [...renderedLines];

      const viewer = new DiffViewer(
        {
          filePath: "main_test.go",
          toolType: "write",
          isNewFile: true,
          renderedLines,
          rawLines,
          theme: makeTheme(),
          onDone: () => {},
        },
        makeTui(),
      );

      const width = 80;
      const output = viewer.render(width);

      // No line should contain a tab
      for (const line of output) {
        expect(line).not.toContain("\t");
      }
    });
  });
});
