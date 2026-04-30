import { describe, expect, it, vi } from "vitest";
import { getAnthropicApiKey } from "../web-search.js";

describe("getAnthropicApiKey", () => {
  it("prefers provider-based lookup when available", async () => {
    const getApiKeyForProvider = vi.fn().mockResolvedValue("provider-key");
    const find = vi.fn();
    const getApiKey = vi.fn();

    await expect(getAnthropicApiKey({ getApiKeyForProvider, find, getApiKey })).resolves.toBe(
      "provider-key",
    );

    expect(getApiKeyForProvider).toHaveBeenCalledWith("anthropic");
    expect(find).not.toHaveBeenCalled();
    expect(getApiKey).not.toHaveBeenCalled();
  });

  it("falls back to model-based lookup when provider lookup is unavailable", async () => {
    const model = { provider: "anthropic", id: "claude-haiku-4-5" };
    const find = vi.fn().mockReturnValue(model);
    const getApiKey = vi.fn().mockResolvedValue("model-key");

    await expect(getAnthropicApiKey({ find, getApiKey })).resolves.toBe("model-key");

    expect(find).toHaveBeenCalledWith("anthropic", "claude-haiku-4-5");
    expect(getApiKey).toHaveBeenCalledWith(model);
  });

  it("returns undefined when neither lookup path can resolve a key", async () => {
    const getApiKeyForProvider = vi.fn().mockResolvedValue(undefined);

    await expect(getAnthropicApiKey({ getApiKeyForProvider })).resolves.toBeUndefined();
  });

  it("returns undefined when model-based lookup cannot find the model", async () => {
    const find = vi.fn().mockReturnValue(undefined);
    const getApiKey = vi.fn();

    await expect(getAnthropicApiKey({ find, getApiKey })).resolves.toBeUndefined();

    expect(find).toHaveBeenCalledWith("anthropic", "claude-haiku-4-5");
    expect(getApiKey).not.toHaveBeenCalled();
  });
});
