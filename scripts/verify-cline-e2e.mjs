#!/usr/bin/env node
// End-to-end acceptance for the primary native Cline session launch path.
//
// Configures the `cline` provider with a real CLINE_API_KEY (from the
// `clineApiKey` secret injected into this environment), starts a Cline SDK
// session with a cheap model, and asserts the assistant replies with the
// expected token.
//
// This is the companion AFTER-success for the Ollama fix: if the native Cline
// launch flow works here, the launch-config shape the Ollama fix ships is
// sound.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const apiKey = process.env.clineApiKey || process.env.CLINE_API_KEY;
if (!apiKey) {
	console.error(
		"verify-cline-e2e: no CLINE_API_KEY / clineApiKey in env — cannot run end-to-end acceptance.",
	);
	process.exit(2);
}
process.env.CLINE_API_KEY = apiKey;

const PROMPT =
	process.env.VERIFY_PROMPT ??
	'Reply with exactly the single word "pong" in lowercase and nothing else.';
const MODEL = process.env.VERIFY_MODEL ?? "anthropic/claude-sonnet-4.6";
const PROVIDER_ID = process.env.VERIFY_PROVIDER ?? "cline";
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS ?? 120_000);

const dataDir = mkdtempSync(join(tmpdir(), "kanban-verify-cline-"));
process.env.CLINE_DATA_DIR = dataDir;
process.on("exit", () => {
	try {
		rmSync(dataDir, { recursive: true, force: true });
	} catch {}
});

const separator = "=".repeat(72);
console.log(separator);
console.log("Kanban native Cline end-to-end verification");
console.log(`  provider       : ${PROVIDER_ID}`);
console.log(`  model          : ${MODEL}`);
console.log(`  CLINE_API_KEY  : [set len=${apiKey.length}]`);
console.log(`  CLINE_DATA_DIR : ${dataDir}`);
console.log(separator);

const { createClineProviderService } = await import(
	"../src/cline-sdk/cline-provider-service.ts"
);
const { createInMemoryClineTaskSessionService } = await import(
	"../src/cline-sdk/cline-task-session-service.ts"
);

const providerService = createClineProviderService();
providerService.saveProviderSettings({
	providerId: PROVIDER_ID,
	modelId: MODEL,
	apiKey,
	baseUrl: null,
	reasoningEffort: null,
});
console.log("[verify] saved provider settings:", providerService.getProviderSettingsSummary());

const launch = await providerService.resolveLaunchConfig();
console.log("[verify] resolved launch config:", {
	providerId: launch.providerId,
	modelId: launch.modelId,
	apiKey: launch.apiKey ? `[set len=${launch.apiKey.length}]` : "[unset]",
	baseUrl: launch.baseUrl,
	reasoningEffort: launch.reasoningEffort ?? null,
});

const sessionService = createInMemoryClineTaskSessionService();
const taskId = `verify-cline-${Date.now()}`;
const messages = [];
const unsubMessage = sessionService.onMessage((_taskId, message) => {
	messages.push(message);
	if (message.role === "assistant" || message.role === "system") {
		const text = typeof message.content === "string" ? message.content : "";
		console.log(`[verify] ${message.role}: ${text.trim().slice(0, 500)}`);
	}
});

let terminalReason = "";
const unsubSummary = sessionService.onSummary((summary) => {
	if (summary.taskId !== taskId) return;
	if (summary.state === "awaiting_review" || summary.state === "completed") {
		terminalReason = summary.reviewReason ?? summary.state;
	}
});

let startError = null;
try {
	await sessionService.startTaskSession({
		taskId,
		cwd: process.cwd(),
		prompt: PROMPT,
		providerId: launch.providerId,
		modelId: launch.modelId,
		apiKey: launch.apiKey,
		baseUrl: launch.baseUrl,
		reasoningEffort: launch.reasoningEffort,
	});
} catch (error) {
	startError = error;
	console.log("[verify] startTaskSession THREW:", error?.message ?? error);
}

const deadline = Date.now() + TIMEOUT_MS;
while (!terminalReason && Date.now() < deadline) {
	await delay(500);
}

unsubMessage();
unsubSummary();
try {
	await sessionService.dispose?.();
} catch {}

const assistantMessages = messages.filter((m) => m.role === "assistant");
const systemMessages = messages.filter((m) => m.role === "system");

console.log(separator);
console.log("RESULT");
console.log(separator);
console.log(`terminal reason    : ${terminalReason || "[timeout]"}`);
console.log(`assistant messages : ${assistantMessages.length}`);
console.log(`system messages    : ${systemMessages.length}`);
for (const m of assistantMessages) {
	console.log("--- assistant ---");
	console.log(m.content);
}
for (const m of systemMessages) {
	console.log("--- system ---");
	console.log(m.content);
}
if (startError) {
	console.log("start error:");
	console.log(startError.message);
}

const success = assistantMessages.some((m) =>
	String(m.content ?? "").toLowerCase().includes("pong"),
);
console.log(success ? "STATUS: OK" : "STATUS: FAILED");
process.exit(success ? 0 : 1);
