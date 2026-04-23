// Integration test for the OpenAI-compatible adapter against Qwen-shaped
// request/response payloads. The adapter itself lives in
// `@ai-sdk/openai-compatible`; this suite stands up a mocked Qwen endpoint
// and drives the adapter end-to-end so we can catch regressions in how
// Kanban-configured OpenAI-compatible providers interact with Qwen's quirks
// (e.g. `reasoning_content` fields, chunked tool-call deltas, and
// model-id strings that embed provider prefixes like `qwen/qwen3-coder`).
//
// Related: https://github.com/cline/kanban/issues/332

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText } from "ai";
import { describe, expect, it } from "vitest";

type CapturedRequest = {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
};

function readHeaders(init: RequestInit | undefined): Record<string, string> {
	const headers: Record<string, string> = {};
	const raw = init?.headers;
	if (!raw) {
		return headers;
	}
	if (raw instanceof Headers) {
		raw.forEach((value, key) => {
			headers[key.toLowerCase()] = value;
		});
		return headers;
	}
	if (Array.isArray(raw)) {
		for (const [key, value] of raw) {
			headers[String(key).toLowerCase()] = String(value);
		}
		return headers;
	}
	for (const [key, value] of Object.entries(raw as Record<string, string>)) {
		headers[key.toLowerCase()] = value;
	}
	return headers;
}

function parseJsonBody(init: RequestInit | undefined): unknown {
	const body = init?.body;
	if (typeof body !== "string" || body.length === 0) {
		return null;
	}
	try {
		return JSON.parse(body);
	} catch {
		return body;
	}
}

function buildCapturingFetch(response: () => Response): {
	fetch: typeof fetch;
	captured: CapturedRequest[];
} {
	const captured: CapturedRequest[] = [];
	const customFetch: typeof fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		captured.push({
			url,
			method: (init?.method ?? "GET").toUpperCase(),
			headers: readHeaders(init),
			body: parseJsonBody(init),
		});
		return response();
	};
	return { fetch: customFetch, captured };
}

function sseResponse(chunks: readonly string[]): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
		},
	});
}

describe("OpenAI-compatible adapter against Qwen-shaped endpoints", () => {
	it("sends a chat/completions request with the raw model id, apiKey, and JSON body that Qwen expects", async () => {
		const { fetch: customFetch, captured } = buildCapturingFetch(
			() =>
				new Response(
					JSON.stringify({
						id: "chatcmpl-qwen-1",
						model: "qwen3-coder",
						created: Math.floor(Date.now() / 1000),
						choices: [
							{
								index: 0,
								message: {
									role: "assistant",
									content: "Hello from Qwen",
								},
								finish_reason: "stop",
							},
						],
						usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
		);
		const provider = createOpenAICompatible({
			name: "qwen-openai-compat",
			baseURL: "https://example.invalid/v1",
			apiKey: "test-qwen-key",
			headers: { "X-Custom-Header": "from-kanban" },
			fetch: customFetch,
		});

		const result = await generateText({
			model: provider("qwen3-coder"),
			messages: [{ role: "user", content: "Say hi" }],
			maxOutputTokens: 16,
			temperature: 0.2,
		});

		expect(result.text).toBe("Hello from Qwen");
		expect(captured).toHaveLength(1);
		const request = captured[0];
		expect(request.url).toBe("https://example.invalid/v1/chat/completions");
		expect(request.method).toBe("POST");
		expect(request.headers.authorization).toBe("Bearer test-qwen-key");
		expect(request.headers["x-custom-header"]).toBe("from-kanban");
		expect(request.headers["content-type"]).toContain("application/json");
		const body = request.body as {
			model?: string;
			messages?: { role: string; content: string }[];
			max_tokens?: number;
			temperature?: number;
		};
		// The Kanban-configured model id must reach Qwen verbatim — including
		// provider prefixes like `qwen/qwen3-coder` that some OpenAI-compatible
		// proxies accept but bare Qwen endpoints reject.
		expect(body.model).toBe("qwen3-coder");
		expect(body.messages).toEqual([{ role: "user", content: "Say hi" }]);
		expect(body.max_tokens).toBe(16);
		expect(body.temperature).toBe(0.2);
	});

	it("passes through provider-prefixed Qwen model ids (e.g. qwen/qwen3-coder) without mangling them", async () => {
		// Regression: gateways like OpenRouter expect provider-prefixed ids
		// (`qwen/qwen3-coder`) while Qwen DashScope expects bare ids
		// (`qwen3-coder`). The adapter must forward whatever Kanban saved
		// without rewriting, so both Qwen gateways and native Qwen endpoints
		// keep working.
		const { fetch: customFetch, captured } = buildCapturingFetch(
			() =>
				new Response(
					JSON.stringify({
						id: "chatcmpl-prefixed",
						model: "qwen/qwen3-coder",
						created: Math.floor(Date.now() / 1000),
						choices: [
							{
								index: 0,
								message: { role: "assistant", content: "ok" },
								finish_reason: "stop",
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		const provider = createOpenAICompatible({
			name: "qwen-openai-compat",
			baseURL: "https://openrouter.invalid/api/v1",
			apiKey: "test-qwen-key",
			fetch: customFetch,
		});

		await generateText({
			model: provider("qwen/qwen3-coder"),
			messages: [{ role: "user", content: "ping" }],
		});

		expect(captured).toHaveLength(1);
		const body = captured[0].body as { model?: string };
		expect(body.model).toBe("qwen/qwen3-coder");
	});

	it("surfaces Qwen-style { error: { message } } error payloads instead of hanging", async () => {
		// The "stuck on Thinking..." symptom from issue #332 needs the adapter
		// to emit an error quickly when the Qwen endpoint returns an OpenAI-
		// compatible error payload. Regression guard for users who paste an
		// expired or invalid Qwen key.
		const { fetch: customFetch } = buildCapturingFetch(
			() =>
				new Response(
					JSON.stringify({
						error: {
							message: "Incorrect API key provided. You can find your API key in the DashScope console.",
							type: "invalid_request_error",
							code: "invalid_api_key",
						},
					}),
					{ status: 401, headers: { "content-type": "application/json" } },
				),
		);
		const provider = createOpenAICompatible({
			name: "qwen-openai-compat",
			baseURL: "https://dashscope-intl.example/compatible-mode/v1",
			apiKey: "wrong-key",
			fetch: customFetch,
		});

		await expect(
			generateText({
				model: provider("qwen3-coder"),
				messages: [{ role: "user", content: "hi" }],
			}),
		).rejects.toThrowError(/Incorrect API key provided/i);
	});

	it("parses Qwen-style SSE stream with reasoning_content, content, and tool_calls deltas", async () => {
		// Qwen-family models stream `reasoning_content` alongside `content`
		// (and Qwen tool-calls arrive as incremental `function.arguments`
		// chunks). This asserts Kanban's OpenAI-compatible path preserves
		// both channels and emits a clean `tool-call` once arguments are
		// fully parsable JSON.
		const lines: string[] = [
			// stream start with role
			'data: {"id":"qwen-stream-1","created":1,"model":"qwen3-coder","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
			// reasoning first (Qwen convention)
			'data: {"id":"qwen-stream-1","created":1,"model":"qwen3-coder","choices":[{"index":0,"delta":{"reasoning_content":"Plan: greet."}}]}\n\n',
			// then visible content
			'data: {"id":"qwen-stream-1","created":1,"model":"qwen3-coder","choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
			'data: {"id":"qwen-stream-1","created":1,"model":"qwen3-coder","choices":[{"index":0,"delta":{"content":" there"}}]}\n\n',
			// tool call arrives as incremental JSON argument chunks
			'data: {"id":"qwen-stream-1","created":1,"model":"qwen3-coder","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_qwen_1","function":{"name":"wave","arguments":"{\\"times\\":"}}]}}]}\n\n',
			'data: {"id":"qwen-stream-1","created":1,"model":"qwen3-coder","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"2}"}}]}}]}\n\n',
			// finish + usage
			'data: {"id":"qwen-stream-1","created":1,"model":"qwen3-coder","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":7,"completion_tokens":4,"total_tokens":11}}\n\n',
			"data: [DONE]\n\n",
		];

		const { fetch: customFetch } = buildCapturingFetch(() => sseResponse(lines));
		const provider = createOpenAICompatible({
			name: "qwen-openai-compat",
			baseURL: "https://dashscope-intl.example/compatible-mode/v1",
			apiKey: "test-qwen-key",
			includeUsage: true,
			fetch: customFetch,
		});

		const chunks: string[] = [];
		const reasoning: string[] = [];
		const toolCalls: { toolName: string; input: unknown }[] = [];
		let finishReason: string | undefined;

		const result = streamText({
			model: provider("qwen3-coder"),
			messages: [{ role: "user", content: "ping" }],
		});

		for await (const part of result.fullStream) {
			if (part.type === "text-delta") {
				chunks.push(part.text);
			} else if (part.type === "reasoning-delta") {
				reasoning.push(part.text);
			} else if (part.type === "tool-call") {
				toolCalls.push({ toolName: part.toolName, input: part.input });
			} else if (part.type === "finish") {
				finishReason = part.finishReason;
			}
		}

		expect(chunks.join("")).toBe("Hi there");
		expect(reasoning.join("")).toBe("Plan: greet.");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].toolName).toBe("wave");
		// The adapter exposes the raw JSON string; Kanban's tool-call renderer
		// parses it downstream. We only assert that arguments are forwarded
		// verbatim without being dropped.
		expect(typeof toolCalls[0].input === "string" ? JSON.parse(toolCalls[0].input) : toolCalls[0].input).toEqual({
			times: 2,
		});
		expect(finishReason).toBe("tool-calls");
	});
});
