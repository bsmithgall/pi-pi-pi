/**
 * Model Filter Extension
 *
 * Replaces the default Ctrl+{ / Ctrl+} model cycle with a filtered cycle that
 * only steps through the latest generation of each Anthropic model family
 * (Haiku → Sonnet → Opus). "Latest" is determined dynamically at startup by
 * inspecting available models, so no hardcoded IDs need updating when pi adds
 * newer versions.
 *
 * The keybindings.json in this repo already remaps cycleModelForward /
 * cycleModelBackward to Ctrl+} / Ctrl+{. This extension intercepts those same
 * keys via registerShortcut (which takes priority over keybinding actions) and
 * replaces the built-in cycle behaviour with the filtered one.
 *
 * Note: the full /model picker is unaffected — this only changes cycling.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// Families to include, in cycle order.
const FAMILIES = ["haiku", "sonnet", "opus"] as const;

/**
 * Extract a comparable version string from a model ID so we can pick the
 * highest version within a family.
 *
 * Examples:
 *   claude-haiku-4-5   -> "0004.0005"
 *   claude-sonnet-4-6  -> "0004.0006"
 *   claude-opus-4-1    -> "0004.0001"
 */
function versionKey(id: string): string {
  const tail = id.replace(/^claude-(?:haiku|sonnet|opus)-/, "");
  // Accept only short numeric segments (≤4 digits) — this skips date stamps
  // like "20251001" which are 8 digits.
  const parts = tail.split("-").filter((p) => /^\d+$/.test(p) && p.length <= 4);
  return parts.map((p) => p.padStart(4, "0")).join(".");
}

function isDateStampVariant(id: string, family: string): boolean {
  const tail = id.replace(`claude-${family}-`, "");
  return tail.split("-").some((p) => p.length === 8 && /^\d+$/.test(p));
}

function buildCycleList(available: Model<Api>[]): Model<Api>[] {
  const result: Model<Api>[] = [];

  for (const family of FAMILIES) {
    const candidates = available.filter(
      (m) =>
        m.provider === "anthropic" &&
        m.id.startsWith(`claude-${family}-`) &&
        !isDateStampVariant(m.id, family),
    );

    if (candidates.length === 0) continue;

    // Sort descending by version, pick the highest
    candidates.sort((a, b) => versionKey(b.id).localeCompare(versionKey(a.id)));
    result.push(candidates[0]);
  }

  return result;
}

export default function modelFilterExtension(pi: ExtensionAPI): void {
  // Register shortcuts on the same keys that keybindings.json assigns to
  // cycleModelForward / cycleModelBackward. registerShortcut handlers fire
  // before keybinding actions, so these intercept the cycle completely.
  pi.registerShortcut("ctrl+}", {
    description: "Cycle to next model (filtered: Haiku → Sonnet → Opus)",
    handler: (ctx) => cycleModel(ctx, +1),
  });

  pi.registerShortcut("ctrl+{", {
    description: "Cycle to previous model (filtered: Opus → Sonnet → Haiku)",
    handler: (ctx) => cycleModel(ctx, -1),
  });

  async function cycleModel(ctx: ExtensionContext, direction: 1 | -1): Promise<void> {
    const cycleList = buildCycleList(ctx.modelRegistry.getAvailable());

    if (cycleList.length === 0) {
      ctx.ui.notify("No Anthropic models available to cycle", "warning");
      return;
    }

    const currentId = ctx.model?.id;
    const currentIndex = cycleList.findIndex((m) => m.id === currentId);

    // If current model isn't in our list, start from the first/last
    const nextIndex =
      currentIndex === -1
        ? direction === 1
          ? 0
          : cycleList.length - 1
        : (currentIndex + direction + cycleList.length) % cycleList.length;

    const next = cycleList[nextIndex];
    const success = await pi.setModel(next);
    if (!success) {
      ctx.ui.notify(`No API key available for ${next.id}`, "error");
    }
  }
}
