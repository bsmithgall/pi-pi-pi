/**
 * Web Search Extension
 *
 * Registers a `web_search` tool that the LLM can call to search the internet.
 * Uses Anthropic's native web search beta (anthropic-beta: web-search-2025-03-05)
 * so results come directly from Anthropic — no third-party search API key needed.
 *
 * The search is always run via claude-haiku-4-5 (the fastest/cheapest model)
 * regardless of which model is active in the session, since it's just doing
 * retrieval and summarisation — not the main reasoning task.
 *
 * The tool returns a concise summary with source URLs that the calling model
 * can use to answer the user's question.
 */

import type {
  AgentToolResult,
  ExtensionAPI,
  ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const SEARCH_PROVIDER = "anthropic";
const SEARCH_MODEL_ID = "claude-haiku-4-5";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MAX_USES = 5;
const MAX_TOKENS = 2048;

type SearchResult = { ok: true; text: string } | { ok: false; error: string };

interface SearchDetails {
  query: string;
  result?: string;
  error?: string;
  status?: string;
}

async function getAnthropicApiKey(modelRegistry: {
  find?: (provider: string, modelId: string) => unknown;
  getApiKey?: (model: unknown) => Promise<string | undefined>;
  getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
}): Promise<string | undefined> {
  if (typeof modelRegistry.getApiKeyForProvider === "function") {
    return await modelRegistry.getApiKeyForProvider(SEARCH_PROVIDER);
  }

  if (typeof modelRegistry.find === "function" && typeof modelRegistry.getApiKey === "function") {
    const model = modelRegistry.find(SEARCH_PROVIDER, SEARCH_MODEL_ID);
    if (model) {
      return await modelRegistry.getApiKey(model);
    }
  }

  return undefined;
}

async function runWebSearch(
  query: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<SearchResult> {
  const isOAuth = apiKey.includes("sk-ant-oat");

  const headers: Record<string, string> = isOAuth
    ? {
        authorization: `Bearer ${apiKey}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05,oauth-2025-04-20",
        "content-type": "application/json",
        "x-app": "cli",
        "user-agent": "claude-cli/1.0.72 (external, cli)",
      }
    : {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
        "content-type": "application/json",
      };

  const body = {
    model: SEARCH_MODEL_ID,
    max_tokens: MAX_TOKENS,
    temperature: 0,
    system:
      "You are a concise web research assistant. Search the web and return a focused summary with key findings and full source URLs. Be brief and direct.",
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: MAX_USES,
      },
    ],
    messages: [
      {
        role: "user",
        content: query,
      },
    ],
  };

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Network error: ${msg}` };
  }

  const raw = await res.text();

  if (!res.ok) {
    return { ok: false, error: `Anthropic API error (${res.status}): ${raw.slice(0, 300)}` };
  }

  let parsed: { content?: Array<{ type: string; text?: string }> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Failed to parse Anthropic response as JSON" };
  }

  const text = (parsed.content ?? [])
    .filter(
      (b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text)
    .join("\n\n")
    .trim();

  if (!text) {
    return { ok: false, error: "Anthropic returned no text content" };
  }

  return { ok: true, text };
}

export default function webSearchExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      `Search the internet for current information. Uses Anthropic's native web search ` +
      `via ${SEARCH_MODEL_ID}. Returns a concise summary with source URLs. ` +
      `Use when you need up-to-date facts, documentation, news, or anything not in your training data.`,
    promptSnippet:
      "Search the internet for current information via Anthropic web search. Returns a summary with source URLs.",
    promptGuidelines: [
      "Use web_search when you need up-to-date facts, documentation, news, or anything not in your training data.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "The search query. Be specific and concise for best results.",
      }),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const apiKey = await getAnthropicApiKey(ctx.modelRegistry);
      if (!apiKey) {
        throw new Error(`No Anthropic API key available (tried provider and model-based lookup)`);
      }

      onUpdate?.({
        content: [{ type: "text", text: `Searching: ${params.query}` }],
        details: { query: params.query, status: "searching" },
      });

      const result = await runWebSearch(params.query, apiKey, signal);

      if (!result.ok) {
        throw new Error(`Search failed: ${result.error}`);
      }

      return {
        content: [{ type: "text", text: result.text }],
        details: { query: params.query, result: result.text },
      };
    },

    renderCall(args, theme, _context) {
      const query = typeof args.query === "string" ? args.query : "";
      const preview = query.length > 60 ? `${query.slice(0, 60)}…` : query;
      return new Text(
        theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("dim", `"${preview}"`),
        0,
        0,
      );
    },

    renderResult(
      result: AgentToolResult<SearchDetails>,
      _opts: ToolRenderResultOptions,
      theme,
      context,
    ) {
      const details = result.details;

      if (context?.isPartial) {
        const query = details?.query ?? "";
        return new Text(
          theme.fg("toolTitle", "web_search ") + theme.fg("muted", `searching: "${query}"…`),
          0,
          0,
        );
      }

      if (context?.isError || details?.error) {
        return new Text(
          theme.fg("error", `✗ Search failed: ${details?.error ?? "unknown error"}`),
          0,
          0,
        );
      }

      const text = details?.result ?? "";
      if (!text) {
        return new Text(theme.fg("muted", "✓ No results"), 0, 0);
      }

      if (context?.expanded) {
        return new Text(text, 0, 0);
      }

      // Collapsed: show first two lines as a preview
      const lines = text.split("\n").filter((l) => l.trim());
      const preview = lines.slice(0, 2).join(" ").slice(0, 120);
      const hasMore = lines.length > 2 || text.length > 120;
      return new Text(
        theme.fg("success", "✓ ") +
          theme.fg("toolOutput", preview) +
          (hasMore ? theme.fg("dim", " … (Ctrl+O to expand)") : ""),
        0,
        0,
      );
    },
  });
}
