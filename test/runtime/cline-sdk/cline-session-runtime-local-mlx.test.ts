// End-to-end smoke test for cline/kanban#301:
//
// Stand up an in-process OpenAI-compatible HTTP server that behaves like
// mlx_lm.server (no API key required), register it as a custom provider via
// the Cline SDK, and drive a full session through Kanban's
// `InMemoryClineSessionRuntime`. Verifies that Kanban successfully forwards
// the chat completion to the local server and receives a streamed response
// (regression: prior behavior was `Missing API key for provider "<id>"`).
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createInMemoryClineSessionRuntime } from "../../../src/cline-sdk/cline-session-runtime";
import { addSdkCustomProvider, deleteSdkCustomProvider } from "../../../src/cline-sdk/sdk-provider-boundary";

interface MockServerRequest {
	method: string;
	url: string;
	authorization: string | null;
}

interface MockServer {
	port: number;
	close(): Promise<void>;
	requests: MockServerRequest[];
}

async function startMockMlxServer(): Promise<MockServer> {
	const requests: MockServerRequest[] = [];
	const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		const method = req.method ?? "GET";
		const url = req.url ?? "/";
		requests.push({ method, url, authorization: (req.headers.authorization ?? null) as string | null });

		if (method === "GET" && url === "/v1/models") {
			res.statusCode = 200;
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({
					object: "list",
					data: [{ id: "mlx-community/Qwen2.5-Coder-14B-Instruct-4bit", object: "model", owned_by: "mlx" }],
				}),
			);
			return;
		}

		if (method === "POST" && url === "/v1/chat/completions") {
			const chunks: Buffer[] = [];
			for await (const chunk of req) {
				chunks.push(chunk as Buffer);
			}
			const body = Buffer.concat(chunks).toString("utf8");
			let stream = false;
			try {
				const parsed = JSON.parse(body) as { stream?: boolean };
				stream = Boolean(parsed.stream);
			} catch {
				// fallthrough
			}

			if (stream) {
				res.statusCode = 200;
				res.setHeader("content-type", "text/event-stream");
				res.setHeader("cache-control", "no-cache");
				const id = `chatcmpl-${Date.now()}`;
				const created = Math.floor(Date.now() / 1000);
				const base = {
					id,
					object: "chat.completion.chunk",
					created,
					model: "mlx-community/Qwen2.5-Coder-14B-Instruct-4bit",
				};
				res.write(
					`data: ${JSON.stringify({
						...base,
						choices: [{ index: 0, delta: { role: "assistant" } }],
					})}\n\n`,
				);
				res.write(
					`data: ${JSON.stringify({
						...base,
						choices: [{ index: 0, delta: { content: "Hello from mock MLX!" } }],
					})}\n\n`,
				);
				res.write(
					`data: ${JSON.stringify({
						...base,
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
					})}\n\n`,
				);
				res.write("data: [DONE]\n\n");
				res.end();
				return;
			}

			res.statusCode = 200;
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({
					id: `chatcmpl-${Date.now()}`,
					object: "chat.completion",
					created: Math.floor(Date.now() / 1000),
					model: "mlx-community/Qwen2.5-Coder-14B-Instruct-4bit",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "Hello from mock MLX!" },
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
				}),
			);
			return;
		}

		res.statusCode = 404;
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ error: { message: `Not Found: ${method} ${url}`, type: "not_found_error" } }));
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("mock MLX server did not bind to a TCP port");
	}

	return {
		port: address.port,
		requests,
		async close() {
			await new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
		},
	};
}

describe("Local MLX provider session smoke test", () => {
	const PROVIDER_ID = "mlx-local-smoke";
	const MODEL_ID = "mlx-community/Qwen2.5-Coder-14B-Instruct-4bit";
	let tempDataDir: string;
	let originalClineDataDir: string | undefined;
	let originalHome: string | undefined;
	let originalXdgConfigHome: string | undefined;

	beforeAll(() => {
		tempDataDir = mkdtempSync(join(tmpdir(), "kanban-mlx-smoke-"));
		originalClineDataDir = process.env.CLINE_DATA_DIR;
		originalHome = process.env.HOME;
		originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
		process.env.CLINE_DATA_DIR = tempDataDir;
		process.env.HOME = tempDataDir;
		process.env.XDG_CONFIG_HOME = tempDataDir;
	});

	afterAll(() => {
		rmSync(tempDataDir, { recursive: true, force: true });
		if (originalClineDataDir === undefined) {
			delete process.env.CLINE_DATA_DIR;
		} else {
			process.env.CLINE_DATA_DIR = originalClineDataDir;
		}
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		if (originalXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
		}
	});

	afterEach(async () => {
		await deleteSdkCustomProvider(PROVIDER_ID).catch(() => undefined);
	});

	it("drives a real openai-compatible HTTP turn against a local MLX-style server", async () => {
		const mock = await startMockMlxServer();
		try {
			const baseUrl = `http://127.0.0.1:${mock.port}/v1`;
			await addSdkCustomProvider({
				providerId: PROVIDER_ID,
				name: "Mock MLX",
				baseUrl,
				apiKey: null,
				models: [MODEL_ID],
				defaultModelId: MODEL_ID,
				capabilities: ["streaming", "tools"],
			});

			const runtime = createInMemoryClineSessionRuntime();
			try {
				const result = await runtime.startTaskSession({
					taskId: "mlx-smoke-task",
					cwd: tempDataDir,
					prompt: "Say hi in five words.",
					providerId: PROVIDER_ID,
					modelId: MODEL_ID,
					apiKey: null,
					baseUrl,
					systemPrompt: "You are a concise assistant.",
				});

				expect(result.sessionId).toBeTypeOf("string");
				const chatRequests = mock.requests.filter((req) => req.url === "/v1/chat/completions");
				expect(chatRequests.length).toBeGreaterThan(0);
				for (const req of chatRequests) {
					expect(req.authorization ?? "").toMatch(/^Bearer\s+\S+/);
				}

				const agentResult = (result.result ?? {}) as { text?: string; finishReason?: string };
				expect(agentResult.text ?? "").toContain("Hello from mock MLX!");
				expect(agentResult.finishReason).toBe("completed");
			} finally {
				await runtime.dispose().catch(() => undefined);
			}
		} finally {
			await mock.close();
		}
	}, 30_000);
});
