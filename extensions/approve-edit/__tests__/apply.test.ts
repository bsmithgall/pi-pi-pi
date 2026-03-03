import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyEdit, applyWrite, buildProposedContent } from "../apply.js";

describe("buildProposedContent", () => {
  it("replaces oldText with newText", () => {
    expect(buildProposedContent("abc def ghi", "def", "DEF")).toBe("abc DEF ghi");
  });

  it("returns null when oldText not found", () => {
    expect(buildProposedContent("abc", "xyz", "123")).toBeNull();
  });

  it("replaces only the first occurrence", () => {
    expect(buildProposedContent("aa bb aa", "aa", "cc")).toBe("cc bb aa");
  });

  it("returns null for empty oldText", () => {
    expect(buildProposedContent("hello", "", "prefix ")).toBeNull();
  });
});

describe("applyEdit", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "apply-test-"));
    file = join(dir, "test.txt");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("replaces oldText with newText in file", () => {
    writeFileSync(file, "hello world", "utf-8");
    const result = applyEdit(file, "world", "vitest");
    expect(result.success).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("hello vitest");
  });

  it("replaces only the first occurrence", () => {
    writeFileSync(file, "aa bb aa", "utf-8");
    const result = applyEdit(file, "aa", "cc");
    expect(result.success).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("cc bb aa");
  });

  it("fails when oldText not found", () => {
    writeFileSync(file, "hello world", "utf-8");
    const result = applyEdit(file, "missing", "replacement");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("fails when file doesn't exist", () => {
    const result = applyEdit(join(dir, "nope.txt"), "a", "b");
    expect(result.success).toBe(false);
  });
});

describe("applyWrite", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "apply-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes content to a new file", () => {
    const file = join(dir, "new.txt");
    const result = applyWrite(file, "new content");
    expect(result.success).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("new content");
  });

  it("overwrites existing file", () => {
    const file = join(dir, "existing.txt");
    writeFileSync(file, "old", "utf-8");
    const result = applyWrite(file, "new");
    expect(result.success).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("new");
  });
});
