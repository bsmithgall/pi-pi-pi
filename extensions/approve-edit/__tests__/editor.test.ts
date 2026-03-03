import { describe, expect, it } from "vitest";
import { buildDiffCommand, editorName } from "../editor.js";

describe("editorName", () => {
  it("extracts basename from absolute path", () => {
    expect(editorName("/usr/local/bin/nvim")).toBe("nvim");
  });

  it("handles plain command name", () => {
    expect(editorName("vim")).toBe("vim");
  });

  it("strips flags from editor string", () => {
    expect(editorName("nvim --noplugin")).toBe("nvim");
  });

  it("lowercases the result", () => {
    expect(editorName("Code")).toBe("code");
  });
});

describe("buildDiffCommand", () => {
  const old = "/tmp/old.ts";
  const neu = "/tmp/new.ts";

  it("uses -d flag for nvim", () => {
    const cmd = buildDiffCommand("nvim", old, neu);
    expect(cmd.cmd).toBe("nvim");
    expect(cmd.args).toContain("-d");
    expect(cmd.args).toContain(old);
    expect(cmd.args).toContain(neu);
  });

  it("uses -d flag for vim", () => {
    const cmd = buildDiffCommand("vim", old, neu);
    expect(cmd.cmd).toBe("vim");
    expect(cmd.args).toContain("-d");
  });

  it("uses -d flag for vimdiff", () => {
    const cmd = buildDiffCommand("vimdiff", old, neu);
    expect(cmd.cmd).toBe("vimdiff");
    expect(cmd.args).toContain("-d");
  });

  it("uses --diff for VS Code", () => {
    const cmd = buildDiffCommand("code", old, neu);
    expect(cmd.cmd).toBe("code");
    expect(cmd.args).toContain("--diff");
    expect(cmd.args).toContain("--wait");
  });

  it("uses --diff for code-insiders", () => {
    const cmd = buildDiffCommand("code-insiders", old, neu);
    expect(cmd.args).toContain("--diff");
  });

  it("falls back to just opening the new file for unknown editors", () => {
    const cmd = buildDiffCommand("nano", old, neu);
    expect(cmd.cmd).toBe("nano");
    expect(cmd.args).toEqual([neu]);
  });

  it("handles absolute editor paths for nvim", () => {
    const cmd = buildDiffCommand("/usr/local/bin/nvim", old, neu);
    expect(cmd.cmd).toBe("nvim");
    expect(cmd.args).toContain("-d");
  });

  it("handles absolute editor paths for code", () => {
    const cmd = buildDiffCommand("/usr/local/bin/code", old, neu);
    expect(cmd.cmd).toBe("code");
    expect(cmd.args).toContain("--diff");
  });
});
