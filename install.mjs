#!/usr/bin/env node
// Symlinks repo config files into ~/.pi/agent/.
// Runs automatically as an npm postinstall hook (so `pi install` triggers it),
// and can also be run manually: `node install.mjs`

import { existsSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_DIR = dirname(fileURLToPath(import.meta.url));
const PI_DIR = join(homedir(), ".pi", "agent");

// Files in the repo root that should be symlinked into ~/.pi/agent/
const FILES = ["keybindings.json"];

mkdirSync(PI_DIR, { recursive: true });

let anyLinked = false;
for (const file of FILES) {
  const src = join(REPO_DIR, file);
  const dst = join(PI_DIR, file);

  if (existsSync(dst)) {
    try {
      if (readlinkSync(dst) === src) {
        console.log(`  already linked: ${file}`);
        continue;
      }
    } catch {
      // dst exists but is not a symlink — leave it alone and warn
      console.warn(`  skipped: ${file} (${dst} already exists and is not a symlink)`);
      continue;
    }
    unlinkSync(dst);
  }

  symlinkSync(src, dst);
  console.log(`  linked: ${file}`);
  anyLinked = true;
}

if (!anyLinked) {
  console.log("All pi config files already linked.");
}
