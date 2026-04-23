// Standalone "before-fix" reproduction of issue #270 against the unmodified
// `@clinebot/core` SDK. It spins up a mock LiteLLM proxy that emulates a
// virtual-key deployment (`/v1/model/info` -> 401, `/v1/models` -> allow list)
// and calls the SDK-level model discovery (`getLocalProviderModels`) directly,
// without the Kanban boundary patch. Expected output: only the default
// `gpt-5.4` model is returned and the LiteLLM allow list is missing.

import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "kanban-litellm-before-"));
process.env.CLINE_DATA_DIR = tempDir;
process.env.XDG_DATA_HOME = tempDir;
process.env.HOME = tempDir;

const ALLOWED_MODELS = [
	"gemini-2.5-pro",
	"gemini-2.5-flash",
	"gemini-3-flash-preview",
	"openrouter/claude-sonnet-4.5",
	"openrouter/claude-haiku-4.5",
	"vertex/claude-sonnet-4",
	"azure/gpt-4o",
];

const modelInfoRequests = [];
const modelsRequests = [];

function startMockLiteLlm() {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			const url = req.url ?? "";
			if (url.startsWith("/v1/model/info")) {
				modelInfoRequests.push({ url, headers: req.headers });
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
			if (url.startsWith("/v1/models")) {
				modelsRequests.push({ url, headers: req.headers });
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
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` });
		});
	});
}

async function main() {
	const { server, baseUrl } = await startMockLiteLlm();
	console.log(`[mock-litellm] listening on ${baseUrl}`);

	const { getLocalProviderModels } = await import("@clinebot/core");

	const response = await getLocalProviderModels("litellm", {
		apiKey: "sk-virtual-kanban-test",
		baseUrl,
	});

	console.log(`\n[result] getLocalProviderModels returned ${response.models.length} models:`);
	for (const model of response.models) {
		console.log(`  - id=${model.id} name=${model.name}`);
	}

	const discoveredIds = response.models.map((model) => model.id);
	const missing = ALLOWED_MODELS.filter((id) => !discoveredIds.includes(id));
	console.log(`\n[stats] /v1/model/info requests: ${modelInfoRequests.length}`);
	console.log(`[stats] /v1/models requests:     ${modelsRequests.length}`);

	if (missing.length === 0) {
		console.log("\nUNEXPECTED: all LiteLLM IDs already present without the fix.");
		process.exitCode = 1;
	} else {
		console.log(`\nREPRODUCED ISSUE #270: missing ${missing.length} of ${ALLOWED_MODELS.length} allow-listed ids.`);
		console.log(`Missing: ${missing.join(", ")}`);
	}

	server.close();
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
