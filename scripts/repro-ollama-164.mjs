#!/usr/bin/env node
// Repro for https://github.com/cline/kanban/issues/164
//
// Exercises the native Cline session launch path the same way the web UI
// does: save Ollama provider settings, resolve the launch config, then hand
// off to ClineTaskSessionService.startTaskSession and wait for either the
// assistant text or the "Cline SDK start failed: ..." system error that the
// issue reports.
//
// Usage: node scripts/repro-ollama-164.mjs [--base-url=http://localhost:11434] [--model=qwen2.5:0.5b]
//
// Environment:
//   CLINE_DATA_DIR   Isolated sandbox dir for provider-settings.json (required here).
//   OLLAMA_API_KEY   Optional; NOT set by default so we repro the original error.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function parseArgs(argv) {
	const out = {};
	for (const raw of argv.slice(2)) {
		const [key, value] = raw.replace(/^--/, "").split("=");
		out[key] = value ?? "true";
	}
	return out;
}

const args = parseArgs(process.argv);
const BASE_URL = args["base-url"] ?? "http://localhost:11434"; // intentionally no /v1
const MODEL = args.model ?? "qwen2.5:0.5b";
const PROMPT = args.prompt ?? "Reply with exactly the single word pong and nothing else.";
const TIMEOUT_MS = Number(args.timeout ?? 60_000);

const dataDir = mkdtempSync(join(tmpdir(), "kanban-164-"));
process.env.CLINE_DATA_DIR = dataDir;
process.env.KANBAN_LOG_LEVEL ||= "error";

process.on("exit", () => {
	try {
		rmSync(dataDir, { recursive: true, force: true });
	} catch {}
});

const separator = "=".repeat(72);
console.log(separator);
console.log(`Kanban issue #164 reproduction`);
console.log(`  version        : ${process.env.npm_package_version ?? "(see package.json)"}`);
console.log(`  provider       : ollama`);
console.log(`  baseUrl        : ${BASE_URL}`);
console.log(`  model          : ${MODEL}`);
console.log(`  OLLAMA_API_KEY : ${process.env.OLLAMA_API_KEY ? "[set]" : "[unset]"}`);
console.log(`  CLINE_API_KEY  : ${process.env.CLINE_API_KEY ? "[set]" : "[unset]"}`);
console.log(`  CLINE_DATA_DIR : ${dataDir}`);
console.log(separator);

const { createClineProviderService } = await import("../src/cline-sdk/cline-provider-service.ts");
const { createInMemoryClineTaskSessionService } = await import(
	"../src/cline-sdk/cline-task-session-service.ts"
);

const providerService = createClineProviderService();
providerService.saveProviderSettings({
	providerId: "ollama",
	modelId: MODEL,
	baseUrl: BASE_URL,
	apiKey: null,
});

console.log("[repro] saved provider settings:", providerService.getProviderSettingsSummary());

let launchConfig;
try {
	launchConfig = await providerService.resolveLaunchConfig();
	console.log("[repro] resolved launch config:", {
		providerId: launchConfig.providerId,
		modelId: launchConfig.modelId,
		apiKey: launchConfig.apiKey
			? `[set len=${launchConfig.apiKey.length}]`
			: "[unset]",
		baseUrl: launchConfig.baseUrl,
		reasoningEffort: launchConfig.reasoningEffort ?? null,
	});
} catch (error) {
	console.log("[repro] resolveLaunchConfig THREW:", error?.message ?? error);
	process.exit(2);
}

const sessionService = createInMemoryClineTaskSessionService();

const taskId = `repro-164-${Date.now()}`;
const messages = [];
const unsub = sessionService.onMessage((_taskId, message) => {
	messages.push(message);
	if (message.role === "assistant" || message.role === "system") {
		const text = typeof message.content === "string" ? message.content : "";
		console.log(`[repro] ${message.role}: ${text.trim().slice(0, 500)}`);
	}
});

const providerListResponse = await providerService.getProviderModels("ollama");
console.log(
	`[repro] getProviderModels("ollama") returned ${providerListResponse.models.length} entries:`,
	providerListResponse.models.slice(0, 10).map((m) => m.id),
);

const terminal = {
	done: false,
	reason: "",
};

const summaryUnsub = sessionService.onSummary((summary) => {
	if (summary.taskId !== taskId) return;
	if (summary.state === "awaiting_review" && summary.reviewReason === "error") {
		terminal.done = true;
		terminal.reason = `error: ${summary.warningMessage ?? "unknown"}`;
	}
	if (summary.state === "awaiting_review" && !terminal.done) {
		terminal.done = true;
		terminal.reason = "turn complete";
	}
});

console.log(`[repro] starting Cline SDK task ${taskId} ...`);
let startError = null;
let summary = null;
try {
	summary = await sessionService.startTaskSession({
		taskId,
		cwd: process.cwd(),
		prompt: PROMPT,
		providerId: launchConfig.providerId,
		modelId: launchConfig.modelId,
		apiKey: launchConfig.apiKey,
		baseUrl: launchConfig.baseUrl,
		reasoningEffort: launchConfig.reasoningEffort,
	});
	console.log("[repro] startTaskSession returned summary state:", summary.state);
} catch (error) {
	startError = error;
	console.log("[repro] startTaskSession THREW:", error?.message ?? error);
}

// Wait for the task to either complete or surface a system error message.
const deadline = Date.now() + TIMEOUT_MS;
while (!terminal.done && Date.now() < deadline) {
	await delay(500);
}

unsub();
summaryUnsub();

const assistantMessages = messages.filter((m) => m.role === "assistant");
const systemMessages = messages.filter((m) => m.role === "system");

console.log(separator);
console.log("RESULT");
console.log(separator);
console.log(`assistant messages : ${assistantMessages.length}`);
console.log(`system messages    : ${systemMessages.length}`);
if (systemMessages.length > 0) {
	console.log("first system message:");
	console.log(systemMessages[0].content);
}
if (assistantMessages.length > 0) {
	console.log("first assistant message:");
	console.log(assistantMessages[0].content);
}
if (startError) {
	console.log("start error message:");
	console.log(startError.message);
}

try {
	await sessionService.dispose?.();
} catch {}

const success = assistantMessages.some((m) =>
	String(m.content ?? "").toLowerCase().includes("pong"),
);
const failure = systemMessages.some((m) =>
	String(m.content ?? "").startsWith("Cline SDK start failed"),
);

if (success) {
	console.log("STATUS: OK (assistant replied with 'pong')");
	process.exit(0);
}
if (failure) {
	console.log("STATUS: REPRODUCED ORIGINAL FAILURE (Cline SDK start failed)");
	process.exit(1);
}
console.log("STATUS: INCONCLUSIVE");
process.exit(3);
