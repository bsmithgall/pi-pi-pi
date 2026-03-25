import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Tests for the socket protocol and message parsing.
 *
 * We can't easily test setupSocket() directly since it requires a real
 * ExtensionAPI, but we can test the message handling logic by reimplementing
 * the core parsing and testing it against a real unix socket server.
 */

const SOCKETS_DIR = "/tmp/pi-nvim-sockets-test";

/** Same hash function as socket.ts */
function cwdHash(cwd: string): string {
  return crypto.createHash("md5").update(cwd).digest("hex").slice(0, 12);
}

/** Send a message to a unix socket and get the response. */
function sendMessage(socketPath: string, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => {
      client.write(message);
    });
    let data = "";
    client.on("data", (chunk) => {
      data += chunk.toString();
      if (data.includes("\n")) {
        client.end();
        resolve(data.trim());
      }
    });
    client.on("error", reject);
    // Timeout after 2s
    setTimeout(() => {
      client.destroy();
      reject(new Error("Timeout"));
    }, 2000);
  });
}

describe("socket protocol", () => {
  let server: net.Server;
  let socketPath: string;
  let receivedMessages: string[];

  beforeEach(async () => {
    receivedMessages = [];
    fs.mkdirSync(SOCKETS_DIR, { recursive: true });
    socketPath = path.join(SOCKETS_DIR, `test-${process.pid}-${Date.now()}.sock`);

    // Simplified version of the socket server from socket.ts
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
              conn.write(`${JSON.stringify({ ok: true, type: "pong" })}\n`);
              continue;
            }

            if (msg.type === "prompt" && typeof msg.message === "string") {
              receivedMessages.push(msg.message);
              conn.write(`${JSON.stringify({ ok: true })}\n`);
              continue;
            }

            conn.write(
              `${JSON.stringify({
                ok: false,
                error: `Unknown command type: ${msg.type}`,
              })}\n`,
            );
          } catch (e) {
            conn.write(
              `${JSON.stringify({ ok: false, error: `Parse error: ${e instanceof Error ? e.message : String(e)}` })}\n`,
            );
          }
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* already gone */
    }
  });

  it("responds to ping with pong", async () => {
    const response = await sendMessage(socketPath, '{"type":"ping"}\n');
    expect(JSON.parse(response)).toEqual({ ok: true, type: "pong" });
  });

  it("accepts prompt messages", async () => {
    const response = await sendMessage(socketPath, '{"type":"prompt","message":"hello world"}\n');
    expect(JSON.parse(response)).toEqual({ ok: true });
    expect(receivedMessages).toEqual(["hello world"]);
  });

  it("rejects unknown message types", async () => {
    const response = await sendMessage(socketPath, '{"type":"unknown"}\n');
    const parsed = JSON.parse(response);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Unknown command type");
  });

  it("handles invalid JSON", async () => {
    const response = await sendMessage(socketPath, "not json\n");
    const parsed = JSON.parse(response);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Parse error");
  });

  it("handles multiple messages in one chunk", async () => {
    // This tests the continue vs return fix — both messages should be processed
    const response = await new Promise<string[]>((resolve, reject) => {
      const client = net.createConnection(socketPath, () => {
        // Send two messages in a single write
        client.write('{"type":"ping"}\n{"type":"prompt","message":"second"}\n');
      });
      const responses: string[] = [];
      let data = "";
      client.on("data", (chunk) => {
        data += chunk.toString();
        // Collect all complete lines
        let nl = data.indexOf("\n");
        while (nl !== -1) {
          responses.push(data.slice(0, nl).trim());
          data = data.slice(nl + 1);
          nl = data.indexOf("\n");
        }
        if (responses.length >= 2) {
          client.end();
          resolve(responses);
        }
      });
      client.on("error", reject);
      setTimeout(() => {
        client.destroy();
        // Resolve with what we have — if only 1 response, the test fails
        resolve(responses);
      }, 2000);
    });

    expect(response).toHaveLength(2);
    expect(JSON.parse(response[0])).toEqual({ ok: true, type: "pong" });
    expect(JSON.parse(response[1])).toEqual({ ok: true });
    expect(receivedMessages).toEqual(["second"]);
  });

  it("handles messages split across chunks", async () => {
    const response = await new Promise<string>((resolve, reject) => {
      const client = net.createConnection(socketPath, () => {
        // Send a message in two chunks
        client.write('{"type":');
        setTimeout(() => {
          client.write('"ping"}\n');
        }, 50);
      });
      let data = "";
      client.on("data", (chunk) => {
        data += chunk.toString();
        if (data.includes("\n")) {
          client.end();
          resolve(data.trim());
        }
      });
      client.on("error", reject);
      setTimeout(() => {
        client.destroy();
        reject(new Error("Timeout"));
      }, 2000);
    });

    expect(JSON.parse(response)).toEqual({ ok: true, type: "pong" });
  });

  it("handles prompt with unicode content", async () => {
    const msg = "看看这段代码 🔍 — héllo wörld";
    const response = await sendMessage(
      socketPath,
      `${JSON.stringify({ type: "prompt", message: msg })}\n`,
    );
    expect(JSON.parse(response)).toEqual({ ok: true });
    expect(receivedMessages).toEqual([msg]);
  });
});

describe("cwdHash", () => {
  it("produces consistent hashes", () => {
    const hash1 = cwdHash("/Users/test/project");
    const hash2 = cwdHash("/Users/test/project");
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different paths", () => {
    const hash1 = cwdHash("/Users/test/project-a");
    const hash2 = cwdHash("/Users/test/project-b");
    expect(hash1).not.toBe(hash2);
  });

  it("produces 12-character hex strings", () => {
    const hash = cwdHash("/any/path");
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });
});
