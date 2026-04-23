// Long-running mock LiteLLM proxy for manual UI testing.
// Usage: node scripts/mock-litellm-proxy.mjs [port]

import http from "node:http";

const port = Number(process.argv[2] ?? 4000);

const ALLOWED_MODELS = [
	"gemini-2.5-pro",
	"gemini-2.5-flash",
	"gemini-3-flash-preview",
	"openrouter/claude-sonnet-4.5",
	"openrouter/claude-haiku-4.5",
	"vertex/claude-sonnet-4",
	"azure/gpt-4o",
];

const server = http.createServer((req, res) => {
	const url = req.url ?? "";
	const method = req.method ?? "GET";
	console.log(`[mock-litellm] ${method} ${url}`);

	if (method === "GET" && url.startsWith("/v1/model/info")) {
		res.writeHead(401, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				error: {
					message: "Admin-only endpoint; virtual keys are not authorized.",
					type: "auth_error",
					code: "401",
				},
			}),
		);
		return;
	}
	if (method === "GET" && url.startsWith("/v1/models")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				object: "list",
				data: ALLOWED_MODELS.map((id) => ({
					id,
					object: "model",
					created: 1_730_000_000,
					owned_by: "litellm",
				})),
			}),
		);
		return;
	}
	res.writeHead(404, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(port, "127.0.0.1", () => {
	console.log(`[mock-litellm] listening on http://127.0.0.1:${port}`);
	console.log("[mock-litellm] allow list:");
	for (const id of ALLOWED_MODELS) {
		console.log(`  - ${id}`);
	}
});
