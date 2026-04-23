// Standalone end-to-end verification of the LiteLLM model picker fix (issue #270).
//
// This boots a small mock proxy that emulates a LiteLLM virtual-key deployment:
//   - GET /v1/model/info returns 401 (the symptom from issue #270).
//   - GET /v1/models returns the OpenAI-compatible allow list.
//
// It then configures the `litellm` provider in a temp state directory, calls
// the same boundary function used by Kanban's UI (`listSdkProviderModels`),
// and prints the discovered model IDs. The fix routes through the new
// `/v1/models` fallback so the full allow list is returned.

import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "kanban-litellm-verify-"));
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

	const { saveSdkProviderSettings, listSdkProviderModels } = await import(
		"../src/cline-sdk/sdk-provider-boundary.ts"
	);

	saveSdkProviderSettings({
		settings: {
			provider: "litellm",
			apiKey: "sk-virtual-kanban-test",
			baseUrl,
		},
		tokenSource: "manual",
		setLastUsed: true,
	});

	const models = await listSdkProviderModels("litellm");
	console.log(`\n[result] listSdkProviderModels returned ${models.length} models:`);
	for (const model of models) {
		console.log(`  - id=${model.id} name=${model.name}`);
	}

	const discoveredIds = models.map((model) => model.id);
	const missing = ALLOWED_MODELS.filter((id) => !discoveredIds.includes(id));

	console.log(`\n[stats] /v1/model/info requests: ${modelInfoRequests.length}`);
	console.log(`[stats] /v1/models requests:     ${modelsRequests.length}`);
	if (missing.length === 0) {
		console.log("\nPASS: all LiteLLM allow-listed model IDs surfaced in the picker.");
	} else {
		console.log(`\nFAIL: missing ${missing.length} model IDs: ${missing.join(", ")}`);
		process.exitCode = 1;
	}

	server.close();
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
