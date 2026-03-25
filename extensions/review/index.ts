/**
 * Review Extension
 *
 * Opens diffview.nvim in a Ghostty split pane alongside pi, connected via
 * a pi-nvim compatible unix socket so you can send code selections and
 * questions from the diff view directly into the running pi conversation.
 *
 * Usage:
 *   /review              — open diffview for unstaged changes
 *   /review HEAD~3       — open diffview comparing against HEAD~3
 *   /review --staged     — open diffview for staged changes
 *   /review close        — close the diffview pane
 *   /review setup        — check dependencies and install what's missing
 *
 * Requirements:
 *   - Ghostty terminal (for AppleScript split control)
 *   - neovim with diffview.nvim and pi-nvim plugins
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { closeReviewPane, hasReviewPane, openReviewPane } from "./ghostty.js";
import { buildDiffviewCmd } from "./helpers.js";
import {
  checkDependencies,
  formatCheckResult,
  installPluginSpec,
  syncLazyPlugins,
} from "./setup.js";
import { cleanupSocket, setupSocket } from "./socket.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the bundled lua plugin spec, resolved relative to this file. */
const PLUGIN_SPEC_SRC = join(__dirname, "pi-review.lua");

export default function reviewExtension(pi: ExtensionAPI) {
  setupSocket(pi);

  pi.registerCommand("review", {
    description: "Open diffview.nvim in a Ghostty split for reviewing changes",
    handler: async (args, ctx) => {
      const trimmedArgs = (args ?? "").trim();

      // ── /review setup ──
      if (trimmedArgs === "setup") {
        ctx.ui.notify("Checking dependencies...", "info");
        let check = await checkDependencies(PLUGIN_SPEC_SRC);

        if (check.ok) {
          ctx.ui.notify(`All dependencies satisfied:\n${formatCheckResult(check)}`, "info");
          return;
        }

        ctx.ui.notify(`Dependencies:\n${formatCheckResult(check)}`, "warning");

        // Install plugin spec if missing
        if (check.nvim && !check.pluginSpec) {
          const install = await ctx.ui.confirm(
            "Install nvim plugin spec?",
            "Symlink pi-review.lua into ~/.config/nvim/lua/plugins/",
          );
          if (install) {
            if (await installPluginSpec(PLUGIN_SPEC_SRC)) {
              ctx.ui.notify("Symlinked pi-review.lua", "info");
              check.pluginSpec = true;
            } else {
              ctx.ui.notify("Failed to install plugin spec", "error");
              return;
            }
          }
        }

        // Sync lazy.nvim if plugins are missing
        if (check.pluginSpec && (!check.diffview || !check.piNvim)) {
          const sync = await ctx.ui.confirm(
            "Install nvim plugins?",
            "Run `nvim --headless '+Lazy! sync' +qa` to install diffview.nvim and pi-nvim",
          );
          if (sync) {
            ctx.ui.notify("Installing plugins (this may take a moment)...", "info");
            if (await syncLazyPlugins()) {
              ctx.ui.notify("Plugins installed", "info");
            } else {
              ctx.ui.notify(
                "Plugin installation failed — try running manually:\n  nvim --headless '+Lazy! sync' +qa",
                "error",
              );
              return;
            }
          }
        }

        // Re-check
        check = await checkDependencies(PLUGIN_SPEC_SRC);
        if (check.ok) {
          ctx.ui.notify(`Setup complete:\n${formatCheckResult(check)}`, "info");
        } else {
          ctx.ui.notify(`Some dependencies still missing:\n${formatCheckResult(check)}`, "warning");
        }
        return;
      }

      // ── /review close ──
      if (trimmedArgs === "close") {
        await closeReviewPane();
        ctx.ui.notify("Review pane closed", "info");
        return;
      }

      // ── /review [rev] ──
      const check = await checkDependencies(PLUGIN_SPEC_SRC);
      if (!check.ok) {
        const missing: string[] = [];
        if (!check.ghostty) missing.push("Ghostty terminal");
        if (!check.nvim) missing.push("neovim");
        if (!check.git) missing.push("git");
        if (!check.diffview) missing.push("diffview.nvim (run /review setup)");
        if (!check.piNvim) missing.push("pi-nvim (run /review setup)");
        ctx.ui.notify(`Missing: ${missing.join(", ")}`, "error");
        return;
      }

      // Close existing pane if open
      if (hasReviewPane()) {
        await closeReviewPane();
      }

      let diffviewCmd: string;
      try {
        diffviewCmd = buildDiffviewCmd(trimmedArgs);
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
        return;
      }

      try {
        await openReviewPane(diffviewCmd, ctx.cwd);
        ctx.ui.notify("Diffview opened — use <leader>p in nvim to send to pi", "info");
      } catch (err) {
        ctx.ui.notify(
          `Failed to open review pane: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });

  pi.on("session_shutdown", async () => {
    await closeReviewPane();
    cleanupSocket();
  });
}
