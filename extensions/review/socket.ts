/**
 * pi-nvim compatible socket server.
 *
 * Opens a unix socket so that the pi-nvim neovim plugin can discover this
 * session and send prompts/selections into it. The protocol and discovery
 * paths match https://github.com/carderne/pi-nvim exactly so the stock
 * neovim plugin works without modification.
 *
 * Protocol (newline-delimited JSON):
 *   → { "type": "prompt", "message": "..." }
 *   ← { "ok": true }
 *   → { "type": "ping" }
 *   ← { "ok": true, "type": "pong" }
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const SOCKETS_DIR = "/tmp/pi-nvim-sockets";
const LATEST_LINK = "/tmp/pi-nvim-latest.sock";

let server: net.Server | null = null;
let socketPath: string | null = null;

function cwdHash(cwd: string): string {
  return crypto.createHash("md5").update(cwd).digest("hex").slice(0, 12);
}

function getSocketPath(cwd: string): string {
  return path.join(SOCKETS_DIR, `${cwdHash(cwd)}-${process.pid}.sock`);
}

function respond(conn: net.Socket, obj: Record<string, unknown>): void {
  try {
    conn.write(`${JSON.stringify(obj)}\n`);
  } catch {
    // Connection may have closed — ignore
  }
}

export function setupSocket(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd;

    try {
      fs.mkdirSync(SOCKETS_DIR, { recursive: true });
    } catch {
      // May already exist
    }

    socketPath = getSocketPath(cwd);

    // Clean up stale socket
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // May not exist
    }

    server = net.createServer((conn) => {
      let buffer = "";
      conn.on("data", (data) => {
        buffer += data.toString();
        for (
          let newlineIdx = buffer.indexOf("\n");
          newlineIdx !== -1;
          newlineIdx = buffer.indexOf("\n")
        ) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;

          try {
            const msg = JSON.parse(line);

            if (msg.type === "ping") {
              respond(conn, { ok: true, type: "pong" });
              continue;
            }

            if (msg.type === "prompt" && typeof msg.message === "string") {
              pi.sendUserMessage(msg.message);
              respond(conn, { ok: true });
              continue;
            }

            respond(conn, { ok: false, error: `Unknown command type: ${msg.type}` });
          } catch (e) {
            respond(conn, {
              ok: false,
              error: `Parse error: ${e instanceof Error ? e.message : String(e)}`,
            });
          }
        }
      });
      conn.on("error", () => {
        // Ignore connection errors
      });
    });

    server.listen(socketPath, () => {
      // Update latest symlink
      try {
        fs.unlinkSync(LATEST_LINK);
      } catch {
        // May not exist
      }
      try {
        if (socketPath) fs.symlinkSync(socketPath, LATEST_LINK);
      } catch {
        // Symlink may fail — non-critical
      }

      // Write discovery info
      try {
        fs.writeFileSync(
          `${socketPath}.info`,
          JSON.stringify({
            cwd,
            pid: process.pid,
            startedAt: new Date().toISOString(),
          }),
        );
      } catch {
        // Non-critical
      }
    });

    server.on("error", (err) => {
      ctx.ui.notify(`review socket error: ${err.message}`, "error");
    });
  });
}

export function cleanupSocket(): void {
  if (server) {
    server.close();
    server = null;
  }

  if (socketPath) {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Already gone
    }
    try {
      fs.unlinkSync(`${socketPath}.info`);
    } catch {
      // Already gone
    }
    try {
      const target = fs.readlinkSync(LATEST_LINK);
      if (target === socketPath) {
        fs.unlinkSync(LATEST_LINK);
      }
    } catch {
      // Not our symlink or already gone
    }
    socketPath = null;
  }
}
