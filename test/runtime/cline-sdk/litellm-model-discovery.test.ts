import { describe, expect, it, vi } from "vitest";
import {
	discoverLiteLlmModelIds,
	mergeLiteLlmModels,
	normalizeLiteLlmRootUrl,
	parseLiteLlmOpenAiModelsPayload,
} from "../../../src/cline-sdk/litellm-model-discovery";

// Real-shape /v1/models response captured from a LiteLLM proxy backing a
// virtual key. This is the exact payload shape Kanban must parse to restore
// issue #270's allow-listed model IDs in the picker.
const REAL_LITELLM_MODELS_RESPONSE = {
	data: [
		{ id: "gemini-2.5-pro", object: "model", created: 1730000000, owned_by: "litellm" },
		{ id: "gemini-2.5-flash", object: "model", created: 1730000000, owned_by: "litellm" },
		{ id: "gemini-3-flash-preview", object: "model", created: 1730000000, owned_by: "litellm" },
		{ id: "openrouter/claude-sonnet-4.5", object: "model", created: 1730000000, owned_by: "litellm" },
		{ id: "openrouter/claude-haiku-4.5", object: "model", created: 1730000000, owned_by: "litellm" },
		{ id: "vertex/claude-sonnet-4", object: "model", created: 1730000000, owned_by: "litellm" },
		{ id: "azure/gpt-4o", object: "model", created: 1730000000, owned_by: "litellm" },
	],
	object: "list",
};

describe("normalizeLiteLlmRootUrl", () => {
	it("returns the default local proxy URL when base is empty", () => {
		expect(normalizeLiteLlmRootUrl(null)).toBe("http://localhost:4000");
		expect(normalizeLiteLlmRootUrl("")).toBe("http://localhost:4000");
		expect(normalizeLiteLlmRootUrl("   ")).toBe("http://localhost:4000");
	});

	it("strips trailing slashes and /v1 suffix", () => {
		expect(normalizeLiteLlmRootUrl("https://proxy.example.com/v1")).toBe("https://proxy.example.com");
		expect(normalizeLiteLlmRootUrl("https://proxy.example.com/v1/")).toBe("https://proxy.example.com");
		expect(normalizeLiteLlmRootUrl("https://proxy.example.com/")).toBe("https://proxy.example.com");
		expect(normalizeLiteLlmRootUrl("https://proxy.example.com")).toBe("https://proxy.example.com");
	});
});

describe("parseLiteLlmOpenAiModelsPayload", () => {
	it("extracts every model id from a real LiteLLM /v1/models response", () => {
		const ids = parseLiteLlmOpenAiModelsPayload(REAL_LITELLM_MODELS_RESPONSE);
		expect(ids).toEqual([
			"gemini-2.5-pro",
			"gemini-2.5-flash",
			"gemini-3-flash-preview",
			"openrouter/claude-sonnet-4.5",
			"openrouter/claude-haiku-4.5",
			"vertex/claude-sonnet-4",
			"azure/gpt-4o",
		]);
	});

	it("deduplicates ids and trims whitespace", () => {
		const ids = parseLiteLlmOpenAiModelsPayload({
			data: [{ id: "  gpt-4o  " }, { id: "gpt-4o" }, { id: "" }, { id: null }, null, { id: "claude-3-5-sonnet" }],
		});
		expect(ids).toEqual(["gpt-4o", "claude-3-5-sonnet"]);
	});

	it("falls back to a legacy { models: [...] } layout", () => {
		const ids = parseLiteLlmOpenAiModelsPayload({
			models: [{ id: "llama3" }, "mixtral", { id: " " }, null],
		});
		expect(ids).toEqual(["llama3", "mixtral"]);
	});

	it("returns an empty list for malformed payloads", () => {
		expect(parseLiteLlmOpenAiModelsPayload(null)).toEqual([]);
		expect(parseLiteLlmOpenAiModelsPayload(undefined)).toEqual([]);
		expect(parseLiteLlmOpenAiModelsPayload("text")).toEqual([]);
		expect(parseLiteLlmOpenAiModelsPayload({ foo: "bar" })).toEqual([]);
	});
});

describe("mergeLiteLlmModels", () => {
	it("appends discovered ids while preserving sdk metadata", () => {
		const merged = mergeLiteLlmModels(
			[{ id: "gpt-4o", name: "GPT-4o", supportsVision: true }],
			["gpt-4o", "claude-3-5-sonnet", "  gpt-4o  "],
		);
		expect(merged).toEqual([
			{ id: "gpt-4o", name: "GPT-4o", supportsVision: true },
			{ id: "claude-3-5-sonnet", name: "claude-3-5-sonnet" },
		]);
	});

	it("skips empty ids and preserves order", () => {
		const merged = mergeLiteLlmModels([], ["a", "", "b", "a", "c"]);
		expect(merged.map((model) => model.id)).toEqual(["a", "b", "c"]);
	});
});

describe("discoverLiteLlmModelIds", () => {
	it("returns all ids from a real LiteLLM /v1/models response", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify(REAL_LITELLM_MODELS_RESPONSE), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const ids = await discoverLiteLlmModelIds({
			baseUrl: "https://proxy.example.com/v1",
			apiKey: "sk-virtual-123",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(ids).toEqual([
			"gemini-2.5-pro",
			"gemini-2.5-flash",
			"gemini-3-flash-preview",
			"openrouter/claude-sonnet-4.5",
			"openrouter/claude-haiku-4.5",
			"vertex/claude-sonnet-4",
			"azure/gpt-4o",
		]);
		const firstCall = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(firstCall[0]).toBe("https://proxy.example.com/v1/models");
		expect((firstCall[1].headers as Record<string, string>).Authorization).toBe("Bearer sk-virtual-123");
	});

	it("retries with x-litellm-api-key if Bearer auth is rejected", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("forbidden", { status: 401 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		const ids = await discoverLiteLlmModelIds({
			baseUrl: "https://proxy.example.com",
			apiKey: "sk-key",
			fetchImpl,
		});
		expect(ids).toEqual(["gpt-4o"]);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const secondInit = fetchImpl.mock.calls[1]?.[1] as RequestInit;
		expect((secondInit.headers as Record<string, string>)["x-litellm-api-key"]).toBe("sk-key");
	});

	it("returns an empty list when no api key is configured", async () => {
		const fetchImpl = vi.fn();
		const ids = await discoverLiteLlmModelIds({
			baseUrl: "https://proxy.example.com",
			apiKey: "   ",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(ids).toEqual([]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("returns an empty list when the proxy never succeeds", async () => {
		const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
		const ids = await discoverLiteLlmModelIds({
			baseUrl: "https://proxy.example.com",
			apiKey: "sk-key",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(ids).toEqual([]);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});
});
