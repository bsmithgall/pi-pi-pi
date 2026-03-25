/**
 * Dependency checking and nvim plugin installation for the review extension.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { xdgConfigDir, xdgDataDir } from "./helpers.js";

const execFileAsync = promisify(execFile);

export interface CheckResult {
  ok: boolean;
  ghostty: boolean;
  nvim: boolean;
  git: boolean;
  diffview: boolean;
  piNvim: boolean;
  pluginSpec: boolean;
}

export async function checkDependencies(_pluginSpecSrc: string): Promise<CheckResult> {
  const result: CheckResult = {
    ok: true,
    ghostty: process.env.TERM_PROGRAM === "ghostty",
    nvim: false,
    git: false,
    diffview: false,
    piNvim: false,
    pluginSpec: false,
  };

  // Check nvim (just --version with a short timeout)
  try {
    await execFileAsync("nvim", ["--version"], { timeout: 5_000 });
    result.nvim = true;
  } catch {
    // not found or timed out
  }

  // Check git
  try {
    await execFileAsync("git", ["--version"], { timeout: 5_000 });
    result.git = true;
  } catch {
    // not found or timed out
  }

  // Check nvim plugins by looking in lazy.nvim's standard data path.
  // We avoid launching nvim --headless here because AstroNvim loads all
  // plugins on startup and can hang or prompt unexpectedly.
  try {
    const lazyDir = join(xdgDataDir(), "nvim", "lazy");
    result.diffview = existsSync(join(lazyDir, "diffview.nvim", "lua", "diffview", "init.lua"));
    result.piNvim = existsSync(join(lazyDir, "pi-nvim", "lua", "pi-nvim", "init.lua"));
  } catch {
    // HOME not set — leave as false
  }

  // Check if the plugin spec file exists (or is symlinked) in the nvim config
  try {
    const pluginSpecDst = join(xdgConfigDir(), "nvim", "lua", "plugins", "pi-review.lua");
    result.pluginSpec = existsSync(pluginSpecDst);
  } catch {
    // HOME not set — leave as false
  }

  result.ok = result.ghostty && result.nvim && result.git && result.diffview && result.piNvim;

  return result;
}

export function formatCheckResult(check: CheckResult): string {
  const yes = "✓";
  const no = "✗";
  const lines = [
    `  ${check.ghostty ? yes : no} Ghostty terminal`,
    `  ${check.nvim ? yes : no} neovim`,
    `  ${check.git ? yes : no} git`,
    `  ${check.pluginSpec ? yes : no} nvim plugin spec (pi-review.lua)`,
    `  ${check.diffview ? yes : no} diffview.nvim`,
    `  ${check.piNvim ? yes : no} pi-nvim`,
  ];
  return lines.join("\n");
}

export async function installPluginSpec(pluginSpecSrc: string): Promise<boolean> {
  const dst = join(xdgConfigDir(), "nvim", "lua", "plugins", "pi-review.lua");

  try {
    mkdirSync(dirname(dst), { recursive: true });

    // If it already exists, check if it's already our symlink
    if (existsSync(dst)) {
      try {
        if (readlinkSync(dst) === pluginSpecSrc) return true;
      } catch {
        // Exists but not a symlink — remove it
      }
      unlinkSync(dst);
    }

    symlinkSync(pluginSpecSrc, dst);
    return true;
  } catch {
    return false;
  }
}

export async function syncLazyPlugins(): Promise<boolean> {
  try {
    await execFileAsync("nvim", ["--headless", "+Lazy! sync", "+qa"], {
      timeout: 60_000,
    });
    return true;
  } catch {
    return false;
  }
}
