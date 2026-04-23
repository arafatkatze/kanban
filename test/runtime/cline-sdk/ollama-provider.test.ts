// Focused coverage for the Ollama adapter behavior that fixes
// https://github.com/cline/kanban/issues/164.
//
// Spins up a mock Ollama HTTP server exposing:
//   GET  /api/tags              — native model listing
//   GET  /v1/models             — OpenAI-compat model listing
//   POST /v1/chat/completions   — OpenAI-compat chat completion
//   * any other path            — `404 page not found` body (mirrors Ollama)
//
// Then exercises:
//   * `normalizeOllamaBaseUrl` across the full input matrix.
//   * `createClineProviderService().resolveLaunchConfig()` — placeholder
//     API key and `/v1`-appended baseUrl.
//   * `listSdkProviderModels("ollama")` — merges `/api/tags` entries into
//     the SDK catalog without duplicating ids; swallows fetch failures.
//   * End-to-end chat against the resolved launch config — the same
//     {baseUrl, apiKey, model} the SDK session would use successfully
//     replies to a prompt on the mock server.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
	createClineProviderService,
	normalizeOllamaBaseUrl,
	OLLAMA_PLACEHOLDER_API_KEY,
} from "../../../src/cline-sdk/cline-provider-service";
import { fetchOllamaInstalledModels, listSdkProviderModels } from "../../../src/cline-sdk/sdk-provider-boundary";

interface MockOllamaState {
	tagsCalls: number;
	lastChatRequest: {
		headers: IncomingMessage["headers"];
		body: unknown;
	} | null;
	installedModels: Array<{ name: string; model: string }>;
}

interface MockOllamaServer {
	server: Server;
	state: MockOllamaState;
	url: string;
	close(): Promise<void>;
}

async function startMockOllama(
	options: { models?: Array<{ name: string; model: string }> } = {},
): Promise<MockOllamaServer> {
	const state: MockOllamaState = {
		tagsCalls: 0,
		lastChatRequest: null,
		installedModels: options.models ?? [
			{ name: "qwen2.5:0.5b", model: "qwen2.5:0.5b" },
			{ name: "llama3.2:1b", model: "llama3.2:1b" },
		],
	};

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.method === "GET" && req.url === "/api/tags") {
			state.tagsCalls += 1;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ models: state.installedModels }));
			return;
		}
		if (req.method === "GET" && req.url === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					object: "list",
					data: state.installedModels.map((m) => ({
						id: m.model,
						object: "model",
						created: 0,
						owned_by: "library",
					})),
				}),
			);
			return;
		}
		if (req.method === "POST" && req.url === "/v1/chat/completions") {
			let raw = "";
			req.on("data", (chunk) => {
				raw += chunk.toString();
			});
			req.on("end", () => {
				let body: unknown = null;
				try {
					body = JSON.parse(raw);
				} catch {
					body = raw;
				}
				state.lastChatRequest = { headers: req.headers, body };
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						id: "chatcmpl-test",
						object: "chat.completion",
						created: 0,
						model: "qwen2.5:0.5b",
						choices: [
							{
								index: 0,
								message: { role: "assistant", content: "pong" },
								finish_reason: "stop",
							},
						],
						usage: {
							prompt_tokens: 1,
							completion_tokens: 1,
							total_tokens: 2,
						},
					}),
				);
			});
			return;
		}
		// Exact mimic of Ollama's gorilla/mux default body.
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("404 page not found");
	});

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const addr = server.address() as AddressInfo;
	const url = `http://127.0.0.1:${addr.port}`;

	return {
		server,
		state,
		url,
		close: async () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}

describe("normalizeOllamaBaseUrl", () => {
	it.each<[string | null | undefined, string]>([
		[undefined, "http://localhost:11434/v1"],
		[null, "http://localhost:11434/v1"],
		["", "http://localhost:11434/v1"],
		["   ", "http://localhost:11434/v1"],
		["http://localhost:11434", "http://localhost:11434/v1"],
		["http://localhost:11434/", "http://localhost:11434/v1"],
		["http://localhost:11434///", "http://localhost:11434/v1"],
		["http://localhost:11434/v1", "http://localhost:11434/v1"],
		["http://localhost:11434/v1/", "http://localhost:11434/v1"],
		["http://localhost:11434/api", "http://localhost:11434/v1"],
		["http://localhost:11434/api/chat", "http://localhost:11434/v1"],
		["http://localhost:11434/api/", "http://localhost:11434/v1"],
		["https://ollama.corp.example.com", "https://ollama.corp.example.com/v1"],
		["https://ollama.corp.example.com/v1", "https://ollama.corp.example.com/v1"],
	])("normalizes %p → %p", (input, expected) => {
		expect(normalizeOllamaBaseUrl(input)).toBe(expected);
	});
});

describe("Ollama provider fix for issue #164", () => {
	let mock: MockOllamaServer;
	let dataDir: string;

	beforeAll(() => {
		// Isolate provider-settings.json so the test doesn't stomp on a real
		// user's Cline config. Must be set BEFORE the module under test
		// instantiates its singleton ProviderSettingsManager — which already
		// happened above via the top-level import. ProviderSettingsManager
		// reads the env var on each operation (through resolveClineDataDir),
		// so setting it here still works.
		dataDir = mkdtempSync(join(tmpdir(), "kanban-164-test-"));
		process.env.CLINE_DATA_DIR = dataDir;
	});

	afterAll(() => {
		delete process.env.CLINE_DATA_DIR;
		try {
			rmSync(dataDir, { recursive: true, force: true });
		} catch {}
	});

	let savedOllamaApiKey: string | undefined;

	beforeEach(async () => {
		mock = await startMockOllama();
		// Each test starts with OLLAMA_API_KEY unset so the placeholder/env
		// resolution is deterministic regardless of the parent shell.
		savedOllamaApiKey = process.env.OLLAMA_API_KEY;
		delete process.env.OLLAMA_API_KEY;
	});

	afterEach(async () => {
		if (savedOllamaApiKey === undefined) {
			delete process.env.OLLAMA_API_KEY;
		} else {
			process.env.OLLAMA_API_KEY = savedOllamaApiKey;
		}
		await mock.close();
	});

	describe("fetchOllamaInstalledModels", () => {
		it("returns installed models from /api/tags", async () => {
			const models = await fetchOllamaInstalledModels(mock.url);
			expect(models).toEqual([
				{ id: "qwen2.5:0.5b", name: "qwen2.5:0.5b" },
				{ id: "llama3.2:1b", name: "llama3.2:1b" },
			]);
			expect(mock.state.tagsCalls).toBe(1);
		});

		it("derives /api/tags from a /v1 base URL", async () => {
			const models = await fetchOllamaInstalledModels(`${mock.url}/v1`);
			expect(models.map((m) => m.id)).toContain("qwen2.5:0.5b");
			expect(mock.state.tagsCalls).toBe(1);
		});

		it("derives /api/tags from a native /api/... base URL", async () => {
			const models = await fetchOllamaInstalledModels(`${mock.url}/api/chat`);
			expect(models.map((m) => m.id)).toContain("qwen2.5:0.5b");
		});

		it("throws on non-OK HTTP status", async () => {
			await expect(fetchOllamaInstalledModels(`${mock.url}/does-not-exist`)).rejects.toThrow(/HTTP 404/);
		});
	});

	describe("resolveLaunchConfig for the built-in Ollama provider", () => {
		it("supplies a placeholder API key and appends /v1 when missing", async () => {
			const service = createClineProviderService();
			service.saveProviderSettings({
				providerId: "ollama",
				modelId: "qwen2.5:0.5b",
				baseUrl: mock.url, // no /v1
				apiKey: null,
			});
			const launch = await service.resolveLaunchConfig();
			expect(launch.providerId).toBe("ollama");
			expect(launch.modelId).toBe("qwen2.5:0.5b");
			expect(launch.baseUrl).toBe(`${mock.url}/v1`);
			expect(launch.apiKey).toBe(OLLAMA_PLACEHOLDER_API_KEY);
		});

		it("prefers the user's saved API key over the placeholder", async () => {
			const service = createClineProviderService();
			service.saveProviderSettings({
				providerId: "ollama",
				modelId: "qwen2.5:0.5b",
				baseUrl: mock.url,
				apiKey: "custom-key",
			});
			const launch = await service.resolveLaunchConfig();
			expect(launch.apiKey).toBe("custom-key");
			expect(launch.baseUrl).toBe(`${mock.url}/v1`);
		});

		it("prefers OLLAMA_API_KEY env var when no saved API key is set", async () => {
			const service = createClineProviderService();
			service.saveProviderSettings({
				providerId: "ollama",
				modelId: "qwen2.5:0.5b",
				baseUrl: mock.url,
				apiKey: null,
			});
			process.env.OLLAMA_API_KEY = "env-key";
			const launch = await service.resolveLaunchConfig();
			expect(launch.apiKey).toBe("env-key");
		});

		it("does not rewrite /v1 when already present", async () => {
			const service = createClineProviderService();
			service.saveProviderSettings({
				providerId: "ollama",
				modelId: "qwen2.5:0.5b",
				baseUrl: `${mock.url}/v1`,
				apiKey: null,
			});
			const launch = await service.resolveLaunchConfig();
			expect(launch.baseUrl).toBe(`${mock.url}/v1`);
		});
	});

	describe("listSdkProviderModels for ollama merges /api/tags entries", () => {
		it("includes locally-pulled models alongside the SDK catalog", async () => {
			const service = createClineProviderService();
			service.saveProviderSettings({
				providerId: "ollama",
				modelId: "qwen2.5:0.5b",
				baseUrl: mock.url,
				apiKey: null,
			});
			const models = await listSdkProviderModels("ollama");
			const ids = models.map((m) => m.id);
			expect(ids).toContain("qwen2.5:0.5b");
			expect(ids).toContain("llama3.2:1b");
			expect(mock.state.tagsCalls).toBeGreaterThanOrEqual(1);
			// No duplicates.
			expect(new Set(ids).size).toBe(ids.length);
		});

		it("still returns the SDK catalog when /api/tags is unreachable", async () => {
			const service = createClineProviderService();
			service.saveProviderSettings({
				providerId: "ollama",
				modelId: "qwen2.5:0.5b",
				// Point at a closed port — connect will fail fast.
				baseUrl: "http://127.0.0.1:1",
				apiKey: null,
			});
			const models = await listSdkProviderModels("ollama");
			// The SDK catalog for "ollama" ships cloud-hosted entries, so the
			// returned list is non-empty even when the local server is down.
			expect(models.length).toBeGreaterThan(0);
		});

		it("does not call /api/tags for non-ollama providers", async () => {
			const service = createClineProviderService();
			service.saveProviderSettings({
				providerId: "ollama",
				modelId: "qwen2.5:0.5b",
				baseUrl: mock.url,
				apiKey: null,
			});
			const before = mock.state.tagsCalls;
			await listSdkProviderModels("anthropic");
			expect(mock.state.tagsCalls).toBe(before);
		});
	});

	describe("resolved launch config yields a working chat call", () => {
		it("can complete /v1/chat/completions end-to-end against the mock server", async () => {
			const service = createClineProviderService();
			service.saveProviderSettings({
				providerId: "ollama",
				modelId: "qwen2.5:0.5b",
				baseUrl: mock.url,
				apiKey: null,
			});
			const launch = await service.resolveLaunchConfig();
			const response = await fetch(`${launch.baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${launch.apiKey}`,
				},
				body: JSON.stringify({
					model: launch.modelId,
					messages: [{ role: "user", content: "say pong" }],
					stream: false,
				}),
			});
			expect(response.ok).toBe(true);
			const payload = (await response.json()) as {
				choices?: Array<{ message?: { content?: string } }>;
			};
			expect(payload.choices?.[0]?.message?.content).toBe("pong");
			const chatRequest = mock.state.lastChatRequest;
			expect(chatRequest).not.toBeNull();
			expect(chatRequest?.headers.authorization).toBe(`Bearer ${OLLAMA_PLACEHOLDER_API_KEY}`);
			expect(chatRequest?.body).toMatchObject({ model: "qwen2.5:0.5b" });
		});
	});
});
