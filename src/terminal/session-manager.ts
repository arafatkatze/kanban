// PTY-backed runtime for non-Cline task sessions and the workspace shell terminal.
// It owns process lifecycle, terminal protocol filtering, and summary updates
// for command-driven agents such as Claude Code, Codex, Gemini, and shell sessions.
import { resolveCodexSessionMetadataForCwd } from "../commands/codex-hook-events";
import type { RuntimeAgentId } from "../core/api-contract";
import type {
	RuntimeTaskHookActivity,
	RuntimeTaskImage,
	RuntimeTaskSessionReviewReason,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract";
import {
	createCodexAppServerClient,
	type CodexAppServerClient,
	type CodexRpcNotification,
	type CodexRpcServerRequest,
} from "../codex-sdk/codex-app-server-client";
import { resolveHomeAgentAppendSystemPrompt } from "../prompts/append-system-prompt";
import {
	type AgentAdapterLaunchInput,
	type AgentOutputTransitionDetector,
	type AgentOutputTransitionInspectionPredicate,
	prepareAgentLaunch,
} from "./agent-session-adapters";
import {
	hasClaudeWorkspaceTrustPrompt,
	shouldAutoConfirmClaudeWorkspaceTrust,
	stopWorkspaceTrustTimers,
	WORKSPACE_TRUST_CONFIRM_DELAY_MS,
} from "./claude-workspace-trust";
import { hasCodexWorkspaceTrustPrompt, shouldAutoConfirmCodexWorkspaceTrust } from "./codex-workspace-trust";
import { stripAnsi } from "./output-utils";
import { PtySession } from "./pty-session";
import { reduceSessionTransition, type SessionTransitionEvent } from "./session-state-machine";
import {
	createTerminalProtocolFilterState,
	disableOscColorQueryIntercept,
	filterTerminalProtocolOutput,
	type TerminalProtocolFilterState,
} from "./terminal-protocol-filter";
import type { TerminalSessionListener, TerminalSessionService } from "./terminal-session-service";
import { type TerminalRestoreSnapshot, TerminalStateMirror } from "./terminal-state-mirror";

const MAX_WORKSPACE_TRUST_BUFFER_CHARS = 16_384;
const AUTO_RESTART_WINDOW_MS = 5_000;
const MAX_AUTO_RESTARTS_PER_WINDOW = 3;
const CODEX_SNAPSHOT_PERSIST_DEBOUNCE_MS = 1_000;
const CODEX_ATTACH_RETRY_DELAY_MS = 1_000;
const CODEX_INLINE_PROMPT = "› ";
// TUI apps (Codex, OpenCode) can query OSC 10/11 before the browser terminal is attached
// and ready to answer. We intercept those startup probes during early PTY output, synthesize
// foreground/background color replies, then disable the filter once a live terminal listener
// has attached.
const OSC_FOREGROUND_QUERY_REPLY = "\u001b]10;rgb:e6e6/eded/f3f3\u001b\\";
const OSC_BACKGROUND_QUERY_REPLY = "\u001b]11;rgb:1717/1717/2121\u001b\\";

type RestartableSessionRequest =
	| { kind: "task"; request: StartTaskSessionRequest }
	| { kind: "shell"; request: StartShellSessionRequest };

interface ActivePtyState {
	kind: "pty";
	session: PtySession;
	workspaceTrustBuffer: string | null;
	cols: number;
	rows: number;
	terminalProtocolFilter: TerminalProtocolFilterState;
	onSessionCleanup: (() => Promise<void>) | null;
	deferredStartupInput: string | null;
	detectOutputTransition: AgentOutputTransitionDetector | null;
	shouldInspectOutputForTransition: AgentOutputTransitionInspectionPredicate | null;
	awaitingCodexPromptAfterEnter: boolean;
	autoConfirmedWorkspaceTrust: boolean;
	workspaceTrustConfirmTimer: NodeJS.Timeout | null;
}

type CodexQueuedInput =
	| { kind: "submit"; text: string; images?: RuntimeTaskImage[] }
	| { kind: "interrupt" };

interface CodexPendingApproval {
	requestId: number | string;
	method: string;
	prompt: string;
}

interface ActiveCodexState {
	kind: "codex";
	threadId: string | null;
	cols: number;
	rows: number;
	activeTurnId: string | null;
	connectPromise: Promise<void> | null;
	operationQueue: Promise<void>;
	inputQueue: CodexQueuedInput[];
	lineBuffer: string;
	pendingApproval: CodexPendingApproval | null;
	stopMode: "none" | "stop" | "shutdown";
}

type ActiveSessionState = ActivePtyState | ActiveCodexState;

interface SessionEntry {
	summary: RuntimeTaskSessionSummary;
	active: ActiveSessionState | null;
	terminalStateMirror: TerminalStateMirror | null;
	sessionGeneration: number;
	snapshotPersistTimer: NodeJS.Timeout | null;
	listenerIdCounter: number;
	listeners: Map<number, TerminalSessionListener>;
	restartRequest: RestartableSessionRequest | null;
	suppressAutoRestartOnExit: boolean;
	autoRestartTimestamps: number[];
	pendingAutoRestart: Promise<void> | null;
}

export interface StartTaskSessionRequest {
	taskId: string;
	agentId: AgentAdapterLaunchInput["agentId"];
	binary: string;
	args: string[];
	autonomousModeEnabled?: boolean;
	cwd: string;
	prompt: string;
	images?: RuntimeTaskImage[];
	startInPlanMode?: boolean;
	resumeFromTrash?: boolean;
	resumeSessionId?: string | null;
	cols?: number;
	rows?: number;
	env?: Record<string, string | undefined>;
	workspaceId?: string;
}

export interface StartShellSessionRequest {
	taskId: string;
	cwd: string;
	cols?: number;
	rows?: number;
	binary: string;
	args?: string[];
	env?: Record<string, string | undefined>;
}

export interface CreateTerminalSessionManagerOptions {
	createCodexClient?: (input: { binary: string; cwd: string }) => CodexAppServerClient;
}

function now(): number {
	return Date.now();
}

function createDefaultSummary(taskId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "idle",
		agentId: null,
		agentSessionId: null,
		workspacePath: null,
		lastKnownWorkspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		terminalRestoreSnapshot: null,
		terminalRestoreCols: null,
		terminalRestoreRows: null,
	};
}

function cloneSummary(summary: RuntimeTaskSessionSummary): RuntimeTaskSessionSummary {
	return {
		...summary,
	};
}

function updateSummary(entry: SessionEntry, patch: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary {
	entry.summary = {
		...entry.summary,
		...patch,
		updatedAt: now(),
	};
	return entry.summary;
}

function isPtyActive(active: ActiveSessionState | null): active is ActivePtyState {
	return active?.kind === "pty";
}

function isCodexActive(active: ActiveSessionState | null): active is ActiveCodexState {
	return active?.kind === "codex";
}

function isActiveState(state: RuntimeTaskSessionState): boolean {
	return state === "running" || state === "awaiting_review";
}

function cloneStartTaskSessionRequest(request: StartTaskSessionRequest): StartTaskSessionRequest {
	return {
		...request,
		args: [...request.args],
		images: request.images ? request.images.map((image) => ({ ...image })) : undefined,
		resumeSessionId: request.resumeSessionId ?? null,
		env: request.env ? { ...request.env } : undefined,
	};
}

function cloneStartShellSessionRequest(request: StartShellSessionRequest): StartShellSessionRequest {
	return {
		...request,
		args: request.args ? [...request.args] : undefined,
		env: request.env ? { ...request.env } : undefined,
	};
}

function formatSpawnFailure(binary: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.toLowerCase();
	if (normalized.includes("posix_spawnp failed") || normalized.includes("enoent")) {
		return `Failed to launch "${binary}". Command not found. Install a supported agent CLI and select it in Settings.`;
	}
	return `Failed to launch "${binary}": ${message}`;
}

function formatShellSpawnFailure(binary: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.toLowerCase();
	if (normalized.includes("posix_spawnp failed") || normalized.includes("enoent")) {
		return `Failed to launch "${binary}". Command not found on this system.`;
	}
	return `Failed to launch "${binary}": ${message}`;
}

function buildTerminalEnvironment(
	...sources: Array<Record<string, string | undefined> | undefined>
): Record<string, string | undefined> {
	return {
		...process.env,
		...Object.assign({}, ...sources),
		COLORTERM: "truecolor",
		TERM: "xterm-256color",
		TERM_PROGRAM: "kanban",
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readStringField(record: Record<string, unknown>, key: string): string | null {
	return readStringValue(record[key]);
}

function readBooleanField(record: Record<string, unknown>, key: string): boolean | null {
	return typeof record[key] === "boolean" ? record[key] : null;
}

function getCodexPromptText(prompt: string, startInPlanMode: boolean | undefined): string {
	const trimmedPrompt = prompt.trim();
	if (startInPlanMode) {
		return trimmedPrompt ? `/plan ${trimmedPrompt}` : "/plan";
	}
	return trimmedPrompt;
}

function buildCodexUserInputs(text: string, images: RuntimeTaskImage[] | undefined): Array<Record<string, unknown>> {
	const inputs: Array<Record<string, unknown>> = [
		{
			type: "text",
			text,
		},
	];
	for (const image of images ?? []) {
		inputs.push({
			type: "image",
			url: `data:${image.mimeType};base64,${image.data}`,
		});
	}
	return inputs;
}

function buildCodexThreadSandboxMode(autonomousModeEnabled: boolean | undefined): "danger-full-access" | "workspace-write" {
	return autonomousModeEnabled ? "danger-full-access" : "workspace-write";
}

function buildCodexTurnSandboxPolicy(
	autonomousModeEnabled: boolean | undefined,
	cwd: string,
): Record<string, unknown> {
	if (autonomousModeEnabled) {
		return {
			type: "dangerFullAccess",
		};
	}
	return {
		type: "workspaceWrite",
		writableRoots: [cwd],
		networkAccess: false,
	};
}

function buildCodexApprovalPolicy(autonomousModeEnabled: boolean | undefined): "never" | "unlessTrusted" {
	return autonomousModeEnabled ? "never" : "unlessTrusted";
}

function extractCodexThreadId(value: unknown): string | null {
	if (!isRecord(value)) {
		return null;
	}
	if (typeof value.threadId === "string") {
		return value.threadId;
	}
	const thread = isRecord(value.thread) ? value.thread : null;
	if (thread && typeof thread.id === "string") {
		return thread.id;
	}
	const item = isRecord(value.item) ? value.item : null;
	if (item && typeof item.threadId === "string") {
		return item.threadId;
	}
	const turn = isRecord(value.turn) ? value.turn : null;
	if (turn && typeof turn.threadId === "string") {
		return turn.threadId;
	}
	return null;
}

function extractCodexThread(value: unknown): Record<string, unknown> | null {
	if (!isRecord(value)) {
		return null;
	}
	return isRecord(value.thread) ? value.thread : null;
}

function extractCodexThreadCwd(value: unknown): string | null {
	if (!isRecord(value)) {
		return null;
	}
	const topLevelCwd = readStringField(value, "cwd");
	if (topLevelCwd) {
		return topLevelCwd;
	}
	const thread = extractCodexThread(value);
	return thread ? readStringField(thread, "cwd") : null;
}

function extractCodexThreadActiveTurnId(value: unknown): string | null {
	const thread = extractCodexThread(value);
	if (!thread || !Array.isArray(thread.turns)) {
		return null;
	}
	for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
		const turn = isRecord(thread.turns[index]) ? thread.turns[index] : null;
		if (!turn || readStringField(turn, "status") !== "inProgress") {
			continue;
		}
		return readStringField(turn, "id");
	}
	return null;
}

function extractCodexErrorMessage(value: unknown): string | null {
	if (!isRecord(value)) {
		return null;
	}
	const error = isRecord(value.error) ? value.error : null;
	if (error) {
		return readStringField(error, "message");
	}
	return readStringField(value, "message");
}

function extractCodexTurn(value: unknown): Record<string, unknown> | null {
	if (!isRecord(value)) {
		return null;
	}
	return isRecord(value.turn) ? value.turn : null;
}

function extractCodexTurnId(value: unknown): string | null {
	const turn = extractCodexTurn(value);
	return turn ? readStringField(turn, "id") : null;
}

function extractCodexTurnStatus(value: unknown): string | null {
	const turn = extractCodexTurn(value);
	return turn ? readStringField(turn, "status") : null;
}

function extractCodexTurnErrorMessage(value: unknown): string | null {
	const turn = extractCodexTurn(value);
	if (!turn) {
		return null;
	}
	const error = isRecord(turn.error) ? turn.error : null;
	return error ? readStringField(error, "message") : null;
}

function extractCodexItem(value: unknown): Record<string, unknown> | null {
	if (!isRecord(value)) {
		return null;
	}
	return isRecord(value.item) ? value.item : null;
}

function extractCodexItemType(value: unknown): string | null {
	const item = extractCodexItem(value);
	return item ? readStringField(item, "type") : null;
}

function extractCodexItemId(value: unknown): string | null {
	const item = extractCodexItem(value);
	return item ? readStringField(item, "id") : null;
}

function extractCodexAgentDelta(value: unknown): string | null {
	if (!isRecord(value)) {
		return null;
	}
	return readStringField(value, "delta");
}

function extractCodexCommandOutputDelta(value: unknown): string | null {
	if (!isRecord(value)) {
		return null;
	}
	return readStringField(value, "delta");
}

function buildCodexApprovalPrompt(method: string, params: Record<string, unknown>): string {
	const command = readStringField(params, "command");
	const cwd = readStringField(params, "cwd");
	const reason = readStringField(params, "reason");
	if (method === "item/commandExecution/requestApproval") {
		return [
			"",
			"[kanban] Codex needs approval to run a command.",
			command ? `$ ${command}` : null,
			cwd ? `cwd: ${cwd}` : null,
			reason ? `reason: ${reason}` : null,
			"Type y to accept, n to decline, or c to cancel.",
			"approval> ",
		]
			.filter((line): line is string => typeof line === "string")
			.join("\r\n");
	}
	return [
		"",
		"[kanban] Codex needs approval to apply file changes.",
		reason ? `reason: ${reason}` : null,
		"Type y to accept, n to decline, or c to cancel.",
		"approval> ",
	]
		.filter((line): line is string => typeof line === "string")
		.join("\r\n");
}

function normalizeCodexApprovalDecision(text: string): "accept" | "decline" | "cancel" | null {
	const normalized = text.trim().toLowerCase();
	if (normalized === "y" || normalized === "yes" || normalized === "accept") {
		return "accept";
	}
	if (normalized === "n" || normalized === "no" || normalized === "decline") {
		return "decline";
	}
	if (normalized === "c" || normalized === "cancel") {
		return "cancel";
	}
	return null;
}

function buildCodexLineEditEcho(previousLine: string, nextLine: string): string {
	if (previousLine === nextLine) {
		return "";
	}
	if (nextLine.length < previousLine.length) {
		return "\b \b";
	}
	return nextLine.slice(previousLine.length);
}

function isCodexAgent(agentId: RuntimeAgentId | null | undefined): boolean {
	return agentId === "codex";
}

function hasCodexInteractivePrompt(text: string): boolean {
	const stripped = stripAnsi(text);
	return /(?:^|[\n\r])\s*›\s*/u.test(stripped);
}

function hasCodexStartupUiRendered(text: string): boolean {
	const stripped = stripAnsi(text).toLowerCase();
	return stripped.includes("openai codex (v");
}

async function delay(milliseconds: number): Promise<void> {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

export class TerminalSessionManager implements TerminalSessionService {
	private readonly entries = new Map<string, SessionEntry>();
	private readonly summaryListeners = new Set<(summary: RuntimeTaskSessionSummary) => void>();
	private readonly codexTaskIdByThreadId = new Map<string, string>();
	private codexClient: CodexAppServerClient | null = null;
	private codexClientPromise: Promise<CodexAppServerClient> | null = null;
	private codexClientUnsubscribes: Array<() => void> = [];
	private disposed = false;

	constructor(private readonly options: CreateTerminalSessionManagerOptions = {}) {}

	private trySendDeferredCodexStartupInput(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		const active = entry?.active ?? null;
		if (!entry || !isPtyActive(active) || entry.summary.agentId !== "codex") {
			return false;
		}
		if (active.deferredStartupInput === null) {
			return false;
		}
		const trustPromptVisible =
			active.workspaceTrustBuffer !== null && hasCodexWorkspaceTrustPrompt(active.workspaceTrustBuffer);
		if (trustPromptVisible) {
			return false;
		}
		const deferredInput = active.deferredStartupInput;
		active.deferredStartupInput = null;
		active.session.write(deferredInput);
		return true;
	}

	private hasLiveOutputListener(entry: SessionEntry): boolean {
		for (const listener of entry.listeners.values()) {
			if (listener.onOutput) {
				return true;
			}
		}
		return false;
	}

	private getPersistedRestoreSnapshot(summary: RuntimeTaskSessionSummary | null): TerminalRestoreSnapshot | null {
		if (!summary?.terminalRestoreSnapshot || !summary.terminalRestoreCols || !summary.terminalRestoreRows) {
			return null;
		}
		return {
			snapshot: summary.terminalRestoreSnapshot,
			cols: summary.terminalRestoreCols,
			rows: summary.terminalRestoreRows,
		};
	}

	private registerCodexThread(taskId: string, threadId: string | null | undefined): void {
		const normalizedThreadId = threadId?.trim();
		if (!normalizedThreadId) {
			return;
		}
		this.codexTaskIdByThreadId.set(normalizedThreadId, taskId);
	}

	private unregisterCodexThread(taskId: string, threadId: string | null | undefined): void {
		const normalizedThreadId = threadId?.trim();
		if (!normalizedThreadId) {
			return;
		}
		if (this.codexTaskIdByThreadId.get(normalizedThreadId) === taskId) {
			this.codexTaskIdByThreadId.delete(normalizedThreadId);
		}
	}

	private emitOutput(taskId: string, chunk: Buffer): void {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return;
		}
		entry.terminalStateMirror?.applyOutput(chunk);
		updateSummary(entry, {
			lastOutputAt: now(),
		});
		this.scheduleRestoreSnapshotPersistence(taskId, entry.sessionGeneration);
		for (const listener of entry.listeners.values()) {
			listener.onOutput?.(chunk);
		}
	}

	private notifyTaskListeners(taskId: string, summary: RuntimeTaskSessionSummary): void {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return;
		}
		for (const listener of entry.listeners.values()) {
			listener.onState?.(cloneSummary(summary));
		}
	}

	private notifyTaskExit(taskId: string, code: number | null): void {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return;
		}
		for (const listener of entry.listeners.values()) {
			listener.onExit?.(code);
		}
	}

	private scheduleRestoreSnapshotPersistence(taskId: string, sessionGeneration: number): void {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return;
		}
		if (entry.snapshotPersistTimer) {
			clearTimeout(entry.snapshotPersistTimer);
		}
		entry.snapshotPersistTimer = setTimeout(() => {
			entry.snapshotPersistTimer = null;
			void this.persistRestoreSnapshot(taskId, sessionGeneration);
		}, CODEX_SNAPSHOT_PERSIST_DEBOUNCE_MS);
	}

	private async persistRestoreSnapshot(taskId: string, sessionGeneration: number): Promise<void> {
		const entry = this.entries.get(taskId);
		if (!entry?.terminalStateMirror || entry.sessionGeneration !== sessionGeneration) {
			return;
		}
		const snapshot = await entry.terminalStateMirror.getSnapshot().catch(() => null);
		if (!snapshot) {
			return;
		}
		const currentEntry = this.entries.get(taskId);
		if (!currentEntry || currentEntry.sessionGeneration !== sessionGeneration) {
			return;
		}
		if (
			currentEntry.summary.terminalRestoreSnapshot === snapshot.snapshot &&
			currentEntry.summary.terminalRestoreCols === snapshot.cols &&
			currentEntry.summary.terminalRestoreRows === snapshot.rows
		) {
			return;
		}
		const summary = updateSummary(currentEntry, {
			terminalRestoreSnapshot: snapshot.snapshot,
			terminalRestoreCols: snapshot.cols,
			terminalRestoreRows: snapshot.rows,
		});
		this.emitSummary(summary);
	}

	private async ensureCodexClient(binary: string, cwd: string): Promise<CodexAppServerClient> {
		if (this.disposed) {
			throw new Error("Terminal session manager is disposed.");
		}
		if (this.codexClient) {
			return this.codexClient;
		}
		if (this.codexClientPromise) {
			return await this.codexClientPromise;
		}
		this.codexClientPromise = (async () => {
			const client =
				this.options.createCodexClient?.({
					binary,
					cwd,
				}) ??
				createCodexAppServerClient({
					binary,
					cwd,
					clientInfo: {
						name: "kanban",
						title: "Kanban",
						version: "1.0.0",
					},
				});
			await client.initialize();
			this.codexClient = client;
			this.codexClientUnsubscribes = [
				client.onNotification((message) => {
					this.handleCodexNotification(message);
				}),
				client.onServerRequest((request) => {
					this.handleCodexServerRequest(request);
				}),
				client.onExit((error) => {
					this.handleCodexClientExit(error);
				}),
			];
			return client;
		})().finally(() => {
			this.codexClientPromise = null;
		});
		return await this.codexClientPromise;
	}

	private handleCodexClientExit(error: Error | null): void {
		this.codexClient = null;
		for (const unsubscribe of this.codexClientUnsubscribes) {
			unsubscribe();
		}
		this.codexClientUnsubscribes = [];
		if (this.disposed) {
			return;
		}
		for (const [taskId, entry] of this.entries.entries()) {
			if (!isCodexActive(entry.active)) {
				continue;
			}
			entry.active.connectPromise = null;
			entry.active.activeTurnId = null;
			const summary = updateSummary(entry, {
				pid: null,
				warningMessage: error?.message ?? "Codex host exited.",
			});
			this.notifyTaskListeners(taskId, summary);
			this.emitSummary(summary);
			if (isActiveState(summary.state)) {
				void this.ensureCodexAttached(taskId, entry, entry.active, {
					retryDelayMs: CODEX_ATTACH_RETRY_DELAY_MS,
				});
			}
		}
	}

	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void {
		this.summaryListeners.add(listener);
		return () => {
			this.summaryListeners.delete(listener);
		};
	}

	hydrateFromRecord(record: Record<string, RuntimeTaskSessionSummary>): void {
		for (const [taskId, summary] of Object.entries(record)) {
			this.registerCodexThread(taskId, summary.agentSessionId);
			this.entries.set(taskId, {
				summary: cloneSummary(summary),
				active: null,
				terminalStateMirror: null,
				sessionGeneration: 0,
				snapshotPersistTimer: null,
				listenerIdCounter: 1,
				listeners: new Map(),
				restartRequest: null,
				suppressAutoRestartOnExit: false,
				autoRestartTimestamps: [],
				pendingAutoRestart: null,
			});
		}
	}

	getSummary(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		return entry ? cloneSummary(entry.summary) : null;
	}

	listSummaries(): RuntimeTaskSessionSummary[] {
		return Array.from(this.entries.values()).map((entry) => cloneSummary(entry.summary));
	}

	attach(taskId: string, listener: TerminalSessionListener): (() => void) | null {
		const entry = this.ensureEntry(taskId);

		listener.onState?.(cloneSummary(entry.summary));
		if (isPtyActive(entry.active) && listener.onOutput) {
			disableOscColorQueryIntercept(entry.active.terminalProtocolFilter);
		}
		if (
			isCodexAgent(entry.summary.agentId) &&
			(isActiveState(entry.summary.state) || Boolean(entry.summary.agentSessionId?.trim()))
		) {
			const active = this.ensureCodexActiveState(taskId, entry, {
				cwd: entry.summary.lastKnownWorkspacePath ?? entry.summary.workspacePath ?? null,
			});
			if (active) {
				void this.ensureCodexAttached(taskId, entry, active);
			}
		}

		const listenerId = entry.listenerIdCounter;
		entry.listenerIdCounter += 1;
		entry.listeners.set(listenerId, listener);

		return () => {
			entry.listeners.delete(listenerId);
		};
	}

	async getRestoreSnapshot(taskId: string) {
		const entry = this.entries.get(taskId);
		if (entry?.terminalStateMirror) {
			return await entry.terminalStateMirror.getSnapshot();
		}
		return this.getPersistedRestoreSnapshot(entry?.summary ?? null);
	}

	private createTerminalStateMirror(entry: SessionEntry, cols: number, rows: number): TerminalStateMirror {
		return new TerminalStateMirror(cols, rows, {
			onInputResponse: (data) => {
				if (!isPtyActive(entry.active) || this.hasLiveOutputListener(entry)) {
					return;
				}
				entry.active.session.write(data);
			},
		});
	}

	private ensureCodexActiveState(
		taskId: string,
		entry: SessionEntry,
		options?: {
			cols?: number;
			rows?: number;
			cwd?: string | null;
		},
	): ActiveCodexState | null {
		if (isCodexActive(entry.active)) {
			if (options?.cols && options.cols > 0) {
				entry.active.cols = options.cols;
			}
			if (options?.rows && options.rows > 0) {
				entry.active.rows = options.rows;
			}
			if (options?.cwd) {
				updateSummary(entry, {
					lastKnownWorkspacePath: options.cwd,
				});
			}
			return entry.active;
		}
		if (entry.active && isPtyActive(entry.active)) {
			return null;
		}
		const restoreSnapshot = this.getPersistedRestoreSnapshot(entry.summary);
		const cols = options?.cols ?? restoreSnapshot?.cols ?? 120;
		const rows = options?.rows ?? restoreSnapshot?.rows ?? 40;
		if (!entry.terminalStateMirror) {
			entry.terminalStateMirror = this.createTerminalStateMirror(entry, cols, rows);
		}
		const active: ActiveCodexState = {
			kind: "codex",
			threadId: entry.summary.agentSessionId?.trim() || null,
			cols,
			rows,
			activeTurnId: null,
			connectPromise: null,
			operationQueue: Promise.resolve(),
			inputQueue: [],
			lineBuffer: "",
			pendingApproval: null,
			stopMode: "none",
		};
		entry.active = active;
		if (options?.cwd) {
			updateSummary(entry, {
				lastKnownWorkspacePath: options.cwd,
			});
		}
		this.registerCodexThread(taskId, active.threadId);
		return active;
	}

	private emitCodexInlinePromptIfNeeded(taskId: string, entry: SessionEntry, active: ActiveCodexState): void {
		if (active.activeTurnId || active.pendingApproval || active.lineBuffer.length > 0 || active.inputQueue.length > 0) {
			return;
		}
		if ((entry.summary.terminalRestoreSnapshot?.length ?? 0) > 0) {
			return;
		}
		this.emitOutput(taskId, Buffer.from(CODEX_INLINE_PROMPT, "utf8"));
	}

	private updateCodexWarningState(taskId: string, entry: SessionEntry, message: string): RuntimeTaskSessionSummary {
		const nextState =
			entry.summary.agentSessionId || (isCodexActive(entry.active) ? entry.active.threadId : null)
				? "awaiting_review"
				: ("failed" as const);
		const summary = updateSummary(entry, {
			state: nextState,
			reviewReason: "error",
			warningMessage: message,
			pid: null,
		});
		this.notifyTaskListeners(taskId, summary);
		this.emitSummary(summary);
		this.emitOutput(taskId, Buffer.from(`\r\n[kanban] ${message}\r\n${CODEX_INLINE_PROMPT}`, "utf8"));
		return summary;
	}

	private resolveCodexPendingApproval(
		taskId: string,
		entry: SessionEntry,
		active: ActiveCodexState,
		decision: "accept" | "decline" | "cancel",
	): void {
		const pendingApproval = active.pendingApproval;
		if (!pendingApproval) {
			return;
		}
		try {
			this.codexClient?.respond(pendingApproval.requestId, {
				decision,
			});
		} catch {
			// Best effort: host may already be gone.
		}
		active.pendingApproval = null;
		const summary = updateSummary(entry, {
			state: decision === "accept" ? "running" : "awaiting_review",
			reviewReason: decision === "accept" ? null : "attention",
			warningMessage: null,
		});
		this.notifyTaskListeners(taskId, summary);
		this.emitSummary(summary);
	}

	private enqueueCodexOperation(active: ActiveCodexState, operation: () => Promise<void>): Promise<void> {
		active.operationQueue = active.operationQueue
			.catch(() => undefined)
			.then(async () => {
				await operation();
			});
		return active.operationQueue;
	}

	private async ensureCodexAttached(
		taskId: string,
		entry: SessionEntry,
		active: ActiveCodexState,
		options?: {
			retryDelayMs?: number;
		},
	): Promise<void> {
		if (active.connectPromise) {
			return await active.connectPromise;
		}
		active.connectPromise = (async () => {
			if (this.disposed) {
				return;
			}
			if (options?.retryDelayMs) {
				await delay(options.retryDelayMs);
			}
			const restartRequest = entry.restartRequest?.kind === "task" ? entry.restartRequest.request : null;
			const binary = restartRequest?.binary ?? "codex";
			const cwd = restartRequest?.cwd ?? entry.summary.lastKnownWorkspacePath ?? entry.summary.workspacePath ?? null;
			if (!cwd) {
				throw new Error("Codex session is missing a workspace path.");
			}
			const developerInstructions = resolveHomeAgentAppendSystemPrompt(taskId) ?? undefined;
			const client = await this.ensureCodexClient(binary, cwd);
			const autonomousModeEnabled = restartRequest?.autonomousModeEnabled ?? true;
			const requestedThreadId =
				active.threadId ?? entry.summary.agentSessionId?.trim() ?? restartRequest?.resumeSessionId?.trim();
			let attachResponse: Record<string, unknown> | null = null;
			let resolvedThreadId = requestedThreadId ?? null;
			let resumedExistingThread = false;
			if (resolvedThreadId) {
				try {
					attachResponse = await client.request<Record<string, unknown>>("thread/resume", {
						threadId: resolvedThreadId,
						cwd,
						approvalPolicy: buildCodexApprovalPolicy(autonomousModeEnabled),
						sandbox: buildCodexThreadSandboxMode(autonomousModeEnabled),
						developerInstructions,
						persistExtendedHistory: true,
					});
					resolvedThreadId = extractCodexThreadId(attachResponse) ?? resolvedThreadId;
					resumedExistingThread = true;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					this.emitOutput(
						taskId,
						Buffer.from(
							`\r\n[kanban] Could not reattach Codex session ${resolvedThreadId}; starting a fresh session.\r\n`,
							"utf8",
						),
					);
					this.emitOutput(taskId, Buffer.from(`[kanban] ${message}\r\n`, "utf8"));
					this.unregisterCodexThread(taskId, resolvedThreadId);
					resolvedThreadId = null;
					active.activeTurnId = null;
					active.pendingApproval = null;
				}
			}
			if (!resolvedThreadId) {
				attachResponse = await client.request<Record<string, unknown>>("thread/start", {
					cwd,
					approvalPolicy: buildCodexApprovalPolicy(autonomousModeEnabled),
					sandbox: buildCodexThreadSandboxMode(autonomousModeEnabled),
					developerInstructions,
					persistExtendedHistory: true,
				});
				resolvedThreadId = extractCodexThreadId(attachResponse);
			}
			if (!resolvedThreadId) {
				throw new Error("Codex did not return a thread id.");
			}
			if (entry.active !== active || this.disposed) {
				return;
			}
			this.unregisterCodexThread(taskId, active.threadId);
			active.threadId = resolvedThreadId;
			this.registerCodexThread(taskId, resolvedThreadId);
			active.activeTurnId = attachResponse ? extractCodexThreadActiveTurnId(attachResponse) : active.activeTurnId;
			const resolvedCwd = extractCodexThreadCwd(attachResponse) ?? cwd;
			const state =
				active.activeTurnId || (!resumedExistingThread && active.inputQueue.length > 0)
					? "running"
					: entry.summary.state;
			const summary = updateSummary(entry, {
				agentId: "codex",
				agentSessionId: resolvedThreadId,
				workspacePath: resolvedCwd,
				lastKnownWorkspacePath: resolvedCwd,
				pid: client.pid,
				state,
				warningMessage: null,
			});
			this.notifyTaskListeners(taskId, summary);
			this.emitSummary(summary);
			await this.flushCodexInputQueue(taskId, entry, active);
			if (entry.active === active) {
				this.emitCodexInlinePromptIfNeeded(taskId, entry, active);
			}
		})()
			.catch((error) => {
				if (entry.active !== active) {
					return;
				}
				const message = error instanceof Error ? error.message : String(error);
				this.updateCodexWarningState(taskId, entry, message);
			})
			.finally(() => {
				if (entry.active === active) {
					active.connectPromise = null;
					if (active.threadId && active.inputQueue.length > 0 && !this.disposed) {
						void this.flushCodexInputQueue(taskId, entry, active);
					}
				}
			});
		return await active.connectPromise;
	}

	private async flushCodexInputQueue(taskId: string, entry: SessionEntry, active: ActiveCodexState): Promise<void> {
		if (active.connectPromise || !active.threadId) {
			return;
		}
		const client = this.codexClient;
		if (!client) {
			return;
		}
		try {
			await this.enqueueCodexOperation(active, async () => {
				while (entry.active === active && active.inputQueue.length > 0 && !this.disposed) {
					const next = active.inputQueue.shift();
					if (!next) {
						return;
					}
					if (next.kind === "interrupt") {
						if (active.activeTurnId) {
							await client.request("turn/interrupt", {
								threadId: active.threadId,
								turnId: active.activeTurnId,
							});
						}
						continue;
					}
					if (active.pendingApproval) {
						const decision = normalizeCodexApprovalDecision(next.text);
						if (!decision) {
							this.emitOutput(
								taskId,
								Buffer.from("\r\n[kanban] Type y, n, or c.\r\napproval> ", "utf8"),
							);
							continue;
						}
						this.resolveCodexPendingApproval(taskId, entry, active, decision);
						continue;
					}
					if (active.activeTurnId) {
						await client.request("turn/steer", {
							threadId: active.threadId,
							expectedTurnId: active.activeTurnId,
							input: buildCodexUserInputs(next.text, next.images),
						});
						continue;
					}
					const taskRequest = entry.restartRequest?.kind === "task" ? entry.restartRequest.request : null;
					const currentCwd = entry.summary.lastKnownWorkspacePath ?? entry.summary.workspacePath ?? "";
					const response = await client.request<Record<string, unknown>>("turn/start", {
						threadId: active.threadId,
						input: buildCodexUserInputs(next.text, next.images),
						cwd: currentCwd || null,
						approvalPolicy: buildCodexApprovalPolicy(taskRequest?.autonomousModeEnabled ?? true),
						sandboxPolicy: buildCodexTurnSandboxPolicy(taskRequest?.autonomousModeEnabled ?? true, currentCwd),
					});
					active.activeTurnId = extractCodexTurnId(response);
					const summary = updateSummary(entry, {
						state: "running",
						reviewReason: null,
						warningMessage: null,
						pid: client.pid,
					});
					this.notifyTaskListeners(taskId, summary);
					this.emitSummary(summary);
				}
			});
		} catch (error) {
			if (entry.active !== active || this.disposed) {
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			this.updateCodexWarningState(taskId, entry, message);
		}
	}

	private handleCodexServerRequest(request: CodexRpcServerRequest): void {
		if (this.disposed) {
			try {
				this.codexClient?.respond(request.id, {
					decision: "cancel",
				});
			} catch {
				// Ignore shutdown races.
			}
			return;
		}
		if (
			request.method !== "item/commandExecution/requestApproval" &&
			request.method !== "item/fileChange/requestApproval"
		) {
			return;
		}
		const threadId = extractCodexThreadId(request.params);
		if (!threadId) {
			return;
		}
		const taskId = this.codexTaskIdByThreadId.get(threadId);
		if (!taskId) {
			return;
		}
		const entry = this.entries.get(taskId);
		if (!entry || !isCodexActive(entry.active) || !isRecord(request.params)) {
			return;
		}
		entry.active.pendingApproval = {
			requestId: request.id,
			method: request.method,
			prompt: buildCodexApprovalPrompt(request.method, request.params),
		};
		const summary = updateSummary(entry, {
			state: "awaiting_review",
			reviewReason: "attention",
		});
		this.notifyTaskListeners(taskId, summary);
		this.emitSummary(summary);
		this.emitOutput(taskId, Buffer.from(entry.active.pendingApproval.prompt, "utf8"));
	}

	private handleCodexNotification(message: CodexRpcNotification): void {
		if (this.disposed) {
			return;
		}
		if (message.method === "error") {
			const errorMessage = extractCodexErrorMessage(message.params);
			if (!errorMessage) {
				return;
			}
			for (const [taskId, entry] of this.entries.entries()) {
				if (!isCodexActive(entry.active) || !isActiveState(entry.summary.state)) {
					continue;
				}
				this.updateCodexWarningState(taskId, entry, errorMessage);
			}
			return;
		}
		if (message.method === "serverRequest/resolved") {
			const threadId = extractCodexThreadId(message.params);
			if (!threadId) {
				return;
			}
			const taskId = this.codexTaskIdByThreadId.get(threadId);
			const entry = taskId ? this.entries.get(taskId) : null;
			if (!entry || !isCodexActive(entry.active)) {
				return;
			}
			entry.active.pendingApproval = null;
			if (taskId && !entry.active.activeTurnId) {
				this.emitCodexInlinePromptIfNeeded(taskId, entry, entry.active);
			}
			return;
		}
		const threadId = extractCodexThreadId(message.params);
		if (!threadId) {
			return;
		}
		const taskId = this.codexTaskIdByThreadId.get(threadId);
		if (!taskId) {
			return;
		}
		const entry = this.entries.get(taskId);
		if (!entry || !isCodexActive(entry.active)) {
			return;
		}
		const active = entry.active;
		switch (message.method) {
			case "thread/started": {
				const resolvedCwd = extractCodexThreadCwd(message.params) ?? entry.summary.lastKnownWorkspacePath ?? null;
				const summary = updateSummary(entry, {
					agentSessionId: threadId,
					workspacePath: resolvedCwd,
					lastKnownWorkspacePath: resolvedCwd,
					pid: this.codexClient?.pid ?? null,
				});
				this.notifyTaskListeners(taskId, summary);
				this.emitSummary(summary);
				break;
			}
			case "turn/started": {
				active.activeTurnId = extractCodexTurnId(message.params);
				const summary = updateSummary(entry, {
					state: "running",
					reviewReason: null,
					warningMessage: null,
					pid: this.codexClient?.pid ?? null,
				});
				this.notifyTaskListeners(taskId, summary);
				this.emitSummary(summary);
				break;
			}
			case "turn/completed": {
				const status = extractCodexTurnStatus(message.params);
				const errorMessage = extractCodexTurnErrorMessage(message.params);
				active.activeTurnId = null;
				const stopMode = active.stopMode;
				active.stopMode = "none";
				active.pendingApproval = null;
				let nextState: RuntimeTaskSessionSummary["state"] = "awaiting_review";
				let reviewReason: RuntimeTaskSessionReviewReason = "attention";
				if (stopMode === "stop") {
					nextState = "idle";
					reviewReason = null;
				} else if (stopMode === "shutdown" || status === "interrupted") {
					nextState = "interrupted";
					reviewReason = "interrupted";
				} else if (status === "failed") {
					nextState = "awaiting_review";
					reviewReason = "error";
				}
				const summary = updateSummary(entry, {
					state: nextState,
					reviewReason,
					warningMessage: errorMessage ?? null,
				});
				this.notifyTaskListeners(taskId, summary);
				this.emitSummary(summary);
				if (errorMessage) {
					this.emitOutput(taskId, Buffer.from(`\r\n[kanban] ${errorMessage}\r\n`, "utf8"));
				}
				if (nextState === "awaiting_review" || nextState === "interrupted" || nextState === "idle") {
					this.emitOutput(taskId, Buffer.from(`\r\n${CODEX_INLINE_PROMPT}`, "utf8"));
				}
				this.notifyTaskExit(taskId, status === "completed" ? 0 : status === "failed" ? 1 : null);
				break;
			}
			case "item/started": {
				const itemType = extractCodexItemType(message.params);
				if (itemType === "commandExecution") {
					const item = extractCodexItem(message.params);
					const command = item ? readStringField(item, "command") : null;
					if (command) {
						this.emitOutput(taskId, Buffer.from(`\r\n$ ${command}\r\n`, "utf8"));
					}
				}
				break;
			}
			case "item/agentMessage/delta": {
				const delta = extractCodexAgentDelta(message.params);
				if (delta) {
					this.emitOutput(taskId, Buffer.from(delta, "utf8"));
				}
				break;
			}
			case "item/commandExecution/outputDelta":
			case "item/fileChange/outputDelta": {
				const delta = extractCodexCommandOutputDelta(message.params);
				if (delta) {
					this.emitOutput(taskId, Buffer.from(delta, "utf8"));
				}
				break;
			}
			default:
				break;
		}
	}

	async startTaskSession(request: StartTaskSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const entry = this.ensureEntry(request.taskId);
		entry.restartRequest = {
			kind: "task",
			request: cloneStartTaskSessionRequest(request),
		};
		if (entry.active && isActiveState(entry.summary.state)) {
			return cloneSummary(entry.summary);
		}

		if (isPtyActive(entry.active)) {
			stopWorkspaceTrustTimers(entry.active);
			entry.active.session.stop();
			entry.active = null;
		}
		const cols = Number.isFinite(request.cols) && (request.cols ?? 0) > 0 ? Math.floor(request.cols ?? 0) : 120;
		const rows = Number.isFinite(request.rows) && (request.rows ?? 0) > 0 ? Math.floor(request.rows ?? 0) : 40;
		entry.sessionGeneration += 1;
		if (entry.snapshotPersistTimer) {
			clearTimeout(entry.snapshotPersistTimer);
			entry.snapshotPersistTimer = null;
		}

		if (request.agentId === "codex") {
			const previousSnapshot = this.getPersistedRestoreSnapshot(entry.summary);
			entry.terminalStateMirror?.dispose();
			entry.terminalStateMirror = this.createTerminalStateMirror(entry, cols, rows);
			const active = this.ensureCodexActiveState(request.taskId, entry, {
				cols,
				rows,
				cwd: request.cwd,
			});
			if (!active) {
				throw new Error("Could not start Codex session.");
			}
			active.activeTurnId = null;
			active.pendingApproval = null;
			active.stopMode = "none";
			active.lineBuffer = "";
			active.inputQueue.length = 0;
			const resumedSessionId =
				request.resumeSessionId?.trim() ||
				entry.summary.agentSessionId?.trim() ||
				(request.resumeFromTrash
					? (
							await resolveCodexSessionMetadataForCwd(
								entry.summary.lastKnownWorkspacePath ?? entry.summary.workspacePath ?? request.cwd,
							).catch(() => null)
					  )?.sessionId ?? null
					: null);
			this.unregisterCodexThread(request.taskId, active.threadId);
			active.threadId = resumedSessionId;
			this.registerCodexThread(request.taskId, resumedSessionId);
			const summary = updateSummary(entry, {
				state: request.resumeFromTrash ? "awaiting_review" : "running",
				agentId: "codex",
				agentSessionId: resumedSessionId,
				workspacePath: request.cwd,
				lastKnownWorkspacePath: request.cwd,
				pid: this.codexClient?.pid ?? null,
				startedAt: now(),
				lastOutputAt: entry.summary.lastOutputAt,
				reviewReason: request.resumeFromTrash ? "attention" : null,
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
				warningMessage: null,
				latestTurnCheckpoint: null,
				previousTurnCheckpoint: null,
				terminalRestoreSnapshot: previousSnapshot?.snapshot ?? entry.summary.terminalRestoreSnapshot ?? null,
				terminalRestoreCols: previousSnapshot?.cols ?? entry.summary.terminalRestoreCols ?? cols,
				terminalRestoreRows: previousSnapshot?.rows ?? entry.summary.terminalRestoreRows ?? rows,
			});
			this.emitSummary(summary);
			void this.ensureCodexAttached(request.taskId, entry, active);
			const initialPrompt = getCodexPromptText(request.prompt, request.startInPlanMode);
			if (initialPrompt) {
				active.inputQueue.push({
					kind: "submit",
					text: initialPrompt,
					images: request.images,
				});
				void this.flushCodexInputQueue(request.taskId, entry, active);
			}
			return cloneSummary(summary);
		}

		entry.terminalStateMirror?.dispose();
		entry.terminalStateMirror = null;
		const terminalStateMirror = this.createTerminalStateMirror(entry, cols, rows);

		const launch = await prepareAgentLaunch({
			taskId: request.taskId,
			agentId: request.agentId,
			binary: request.binary,
			args: request.args,
			autonomousModeEnabled: request.autonomousModeEnabled,
			cwd: request.cwd,
			prompt: request.prompt,
			images: request.images,
			startInPlanMode: request.startInPlanMode,
			resumeFromTrash: request.resumeFromTrash,
			env: request.env,
			workspaceId: request.workspaceId,
		});

		const env = buildTerminalEnvironment(request.env, launch.env);

		// Adapters can wrap the configured agent binary when they need extra runtime wiring
		// (for example, Codex uses a wrapper script to watch session logs for hook transitions).
		const commandBinary = launch.binary ?? request.binary;
		const commandArgs = [...launch.args];
		const hasCodexLaunchSignature = [commandBinary, ...commandArgs].some((part) =>
			part.toLowerCase().includes("codex"),
		);
		let session: PtySession;
		try {
			session = PtySession.spawn({
				binary: commandBinary,
				args: commandArgs,
				cwd: request.cwd,
				env,
				cols,
				rows,
				onData: (chunk) => {
					const currentActive = entry.active;
					if (!isPtyActive(currentActive)) {
						return;
					}

					const filteredChunk = filterTerminalProtocolOutput(currentActive.terminalProtocolFilter, chunk, {
						onOsc10ForegroundQuery: () => currentActive.session.write(OSC_FOREGROUND_QUERY_REPLY),
						onOsc11BackgroundQuery: () => currentActive.session.write(OSC_BACKGROUND_QUERY_REPLY),
					});
					if (filteredChunk.byteLength === 0) {
						return;
					}
					entry.terminalStateMirror?.applyOutput(filteredChunk);

					const needsDecodedOutput =
						currentActive.workspaceTrustBuffer !== null ||
						(currentActive.detectOutputTransition !== null &&
							(currentActive.shouldInspectOutputForTransition?.(entry.summary) ?? true));
					const data = needsDecodedOutput ? filteredChunk.toString("utf8") : "";

					if (currentActive.workspaceTrustBuffer !== null) {
						currentActive.workspaceTrustBuffer += data;
						if (currentActive.workspaceTrustBuffer.length > MAX_WORKSPACE_TRUST_BUFFER_CHARS) {
							currentActive.workspaceTrustBuffer = currentActive.workspaceTrustBuffer.slice(
								-MAX_WORKSPACE_TRUST_BUFFER_CHARS,
							);
						}
						if (!currentActive.autoConfirmedWorkspaceTrust && currentActive.workspaceTrustConfirmTimer === null) {
							const hasClaudePrompt = hasClaudeWorkspaceTrustPrompt(currentActive.workspaceTrustBuffer);
							const hasCodexPrompt = hasCodexWorkspaceTrustPrompt(currentActive.workspaceTrustBuffer);
							if (hasClaudePrompt || hasCodexPrompt) {
								currentActive.autoConfirmedWorkspaceTrust = true;
								const trustConfirmDelayMs = WORKSPACE_TRUST_CONFIRM_DELAY_MS;
								currentActive.workspaceTrustConfirmTimer = setTimeout(() => {
										const activeEntry = this.entries.get(request.taskId)?.active ?? null;
									if (!isPtyActive(activeEntry) || !activeEntry.autoConfirmedWorkspaceTrust) {
										return;
									}
									activeEntry.session.write("\r");
									// Trust text can remain in the rolling buffer after we auto-confirm.
									// Clear it so later startup/prompt checks do not match stale trust output.
									if (activeEntry.workspaceTrustBuffer !== null) {
										activeEntry.workspaceTrustBuffer = "";
									}
									activeEntry.workspaceTrustConfirmTimer = null;
								}, trustConfirmDelayMs);
							}
						}
					}
					updateSummary(entry, { lastOutputAt: now() });

					// Codex plan-mode startup input is deferred until we know the TUI rendered.
					// Trigger on either the interactive prompt marker or the startup header text.
					if (
						entry.summary.agentId === "codex" &&
						currentActive.deferredStartupInput !== null &&
						data.length > 0 &&
						(hasCodexInteractivePrompt(data) ||
							hasCodexStartupUiRendered(data) ||
							(currentActive.workspaceTrustBuffer !== null &&
								(hasCodexInteractivePrompt(currentActive.workspaceTrustBuffer) ||
									hasCodexStartupUiRendered(currentActive.workspaceTrustBuffer))))
					) {
						this.trySendDeferredCodexStartupInput(request.taskId);
					}

					const adapterEvent = currentActive.detectOutputTransition?.(data, entry.summary) ?? null;
					if (adapterEvent) {
						const requiresEnterForCodex =
							adapterEvent.type === "agent.prompt-ready" &&
							entry.summary.agentId === "codex" &&
							!currentActive.awaitingCodexPromptAfterEnter;
						if (!requiresEnterForCodex) {
							const summary = this.applySessionEvent(entry, adapterEvent);
							if (adapterEvent.type === "agent.prompt-ready" && entry.summary.agentId === "codex") {
								currentActive.awaitingCodexPromptAfterEnter = false;
							}
							for (const taskListener of entry.listeners.values()) {
								taskListener.onState?.(cloneSummary(summary));
							}
							this.emitSummary(summary);
						}
					}

					for (const taskListener of entry.listeners.values()) {
						taskListener.onOutput?.(filteredChunk);
					}
				},
				onExit: (event) => {
					const currentEntry = this.entries.get(request.taskId);
					if (!currentEntry) {
						return;
					}
					const currentActive = currentEntry.active;
					if (!isPtyActive(currentActive)) {
						return;
					}
					stopWorkspaceTrustTimers(currentActive);

					const summary = this.applySessionEvent(currentEntry, {
						type: "process.exit",
						exitCode: event.exitCode,
						interrupted: currentActive.session.wasInterrupted(),
					});
					const shouldAutoRestart = this.shouldAutoRestart(currentEntry);

					for (const taskListener of currentEntry.listeners.values()) {
						taskListener.onState?.(cloneSummary(summary));
						taskListener.onExit?.(event.exitCode);
					}
					currentEntry.active = null;
					this.emitSummary(summary);
					if (shouldAutoRestart) {
						this.scheduleAutoRestart(currentEntry);
					}

					const cleanupFn = currentActive.onSessionCleanup;
					currentActive.onSessionCleanup = null;
					if (cleanupFn) {
						cleanupFn().catch(() => {
							// Best effort: cleanup failure is non-critical.
						});
					}
				},
			});
		} catch (error) {
			if (launch.cleanup) {
				void launch.cleanup().catch(() => {
					// Best effort: cleanup failure is non-critical.
				});
			}
			terminalStateMirror.dispose();
			const summary = updateSummary(entry, {
				state: "failed",
				agentId: request.agentId,
				workspacePath: request.cwd,
				pid: null,
				startedAt: null,
				lastOutputAt: null,
				reviewReason: "error",
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
				latestTurnCheckpoint: null,
				previousTurnCheckpoint: null,
			});
			this.emitSummary(summary);
			throw new Error(formatSpawnFailure(commandBinary, error));
		}

		const active: ActivePtyState = {
			kind: "pty",
			session,
			workspaceTrustBuffer:
				shouldAutoConfirmClaudeWorkspaceTrust(request.agentId, request.cwd) ||
				shouldAutoConfirmCodexWorkspaceTrust(request.agentId, request.cwd) ||
				hasCodexLaunchSignature
					? ""
					: null,
			cols,
			rows,
			terminalProtocolFilter: createTerminalProtocolFilterState({
				interceptOscColorQueries: true,
				suppressDeviceAttributeQueries: request.agentId === "droid",
			}),
			onSessionCleanup: launch.cleanup ?? null,
			deferredStartupInput: launch.deferredStartupInput ?? null,
			detectOutputTransition: launch.detectOutputTransition ?? null,
			shouldInspectOutputForTransition: launch.shouldInspectOutputForTransition ?? null,
			awaitingCodexPromptAfterEnter: false,
			autoConfirmedWorkspaceTrust: false,
			workspaceTrustConfirmTimer: null,
		};
		entry.active = active;
		entry.terminalStateMirror = terminalStateMirror;

		const startedAt = now();
		updateSummary(entry, {
			state: request.resumeFromTrash ? "awaiting_review" : "running",
			agentId: request.agentId,
			agentSessionId: null,
			workspacePath: request.cwd,
			lastKnownWorkspacePath: request.cwd,
			pid: session.pid,
			startedAt,
			lastOutputAt: null,
			reviewReason: request.resumeFromTrash ? "attention" : null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			warningMessage: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
			terminalRestoreSnapshot: null,
			terminalRestoreCols: null,
			terminalRestoreRows: null,
		});
		this.emitSummary(entry.summary);

		return cloneSummary(entry.summary);
	}

	async startShellSession(request: StartShellSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const entry = this.ensureEntry(request.taskId);
		entry.restartRequest = {
			kind: "shell",
			request: cloneStartShellSessionRequest(request),
		};
		if (entry.active && entry.summary.state === "running") {
			return cloneSummary(entry.summary);
		}

		if (isPtyActive(entry.active)) {
			stopWorkspaceTrustTimers(entry.active);
			entry.active.session.stop();
			entry.active = null;
		}
		entry.terminalStateMirror?.dispose();
		entry.terminalStateMirror = null;
		entry.sessionGeneration += 1;
		if (entry.snapshotPersistTimer) {
			clearTimeout(entry.snapshotPersistTimer);
			entry.snapshotPersistTimer = null;
		}

		const cols = Number.isFinite(request.cols) && (request.cols ?? 0) > 0 ? Math.floor(request.cols ?? 0) : 120;
		const rows = Number.isFinite(request.rows) && (request.rows ?? 0) > 0 ? Math.floor(request.rows ?? 0) : 40;
		const terminalStateMirror = this.createTerminalStateMirror(entry, cols, rows);
		const env = buildTerminalEnvironment(request.env);

		let session: PtySession;
		try {
			session = PtySession.spawn({
				binary: request.binary,
				args: request.args ?? [],
				cwd: request.cwd,
				env,
				cols,
				rows,
				onData: (chunk) => {
					const currentActive = entry.active;
					if (!isPtyActive(currentActive)) {
						return;
					}

					const filteredChunk = filterTerminalProtocolOutput(currentActive.terminalProtocolFilter, chunk, {
						onOsc10ForegroundQuery: () => currentActive.session.write(OSC_FOREGROUND_QUERY_REPLY),
						onOsc11BackgroundQuery: () => currentActive.session.write(OSC_BACKGROUND_QUERY_REPLY),
					});
					if (filteredChunk.byteLength === 0) {
						return;
					}
					entry.terminalStateMirror?.applyOutput(filteredChunk);

					if (currentActive.workspaceTrustBuffer !== null) {
						currentActive.workspaceTrustBuffer += filteredChunk.toString("utf8");
						if (currentActive.workspaceTrustBuffer.length > MAX_WORKSPACE_TRUST_BUFFER_CHARS) {
							currentActive.workspaceTrustBuffer = currentActive.workspaceTrustBuffer.slice(
								-MAX_WORKSPACE_TRUST_BUFFER_CHARS,
							);
						}
					}
					updateSummary(entry, { lastOutputAt: now() });

					for (const taskListener of entry.listeners.values()) {
						taskListener.onOutput?.(filteredChunk);
					}
				},
				onExit: (event) => {
					const currentEntry = this.entries.get(request.taskId);
					if (!currentEntry) {
						return;
					}
					const currentActive = currentEntry.active;
					if (!isPtyActive(currentActive)) {
						return;
					}
					stopWorkspaceTrustTimers(currentActive);

					const summary = updateSummary(currentEntry, {
						state: currentActive.session.wasInterrupted() ? "interrupted" : "idle",
						reviewReason: currentActive.session.wasInterrupted() ? "interrupted" : null,
						exitCode: event.exitCode,
						pid: null,
					});

					for (const taskListener of currentEntry.listeners.values()) {
						taskListener.onState?.(cloneSummary(summary));
						taskListener.onExit?.(event.exitCode);
					}
					currentEntry.active = null;
					this.emitSummary(summary);
				},
			});
		} catch (error) {
			terminalStateMirror.dispose();
			const summary = updateSummary(entry, {
				state: "failed",
				agentId: null,
				workspacePath: request.cwd,
				pid: null,
				startedAt: null,
				lastOutputAt: null,
				reviewReason: "error",
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
				latestTurnCheckpoint: null,
				previousTurnCheckpoint: null,
			});
			this.emitSummary(summary);
			throw new Error(formatShellSpawnFailure(request.binary, error));
		}

		const active: ActivePtyState = {
			kind: "pty",
			session,
			workspaceTrustBuffer: null,
			cols,
			rows,
			terminalProtocolFilter: createTerminalProtocolFilterState({
				interceptOscColorQueries: true,
			}),
			onSessionCleanup: null,
			deferredStartupInput: null,
			detectOutputTransition: null,
			shouldInspectOutputForTransition: null,
			awaitingCodexPromptAfterEnter: false,
			autoConfirmedWorkspaceTrust: false,
			workspaceTrustConfirmTimer: null,
		};
		entry.active = active;
		entry.terminalStateMirror = terminalStateMirror;

		updateSummary(entry, {
			state: "running",
			agentId: null,
			agentSessionId: null,
			workspacePath: request.cwd,
			lastKnownWorkspacePath: request.cwd,
			pid: session.pid,
			startedAt: now(),
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			warningMessage: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
			terminalRestoreSnapshot: null,
			terminalRestoreCols: null,
			terminalRestoreRows: null,
		});
		this.emitSummary(entry.summary);

		return cloneSummary(entry.summary);
	}

	recoverStaleSession(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		if (isCodexAgent(entry.summary.agentId)) {
			return cloneSummary(entry.summary);
		}
		if (entry.active || !isActiveState(entry.summary.state)) {
			return cloneSummary(entry.summary);
		}

		// Preserve agentId so the server can route to the correct agent type
		// (Cline SDK vs terminal PTY) when a task is restored from trash.
		const summary = updateSummary(entry, {
			state: "idle",
			workspacePath: null,
			lastKnownWorkspacePath: entry.summary.lastKnownWorkspacePath ?? entry.summary.workspacePath ?? null,
			pid: null,
			startedAt: null,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		});

		for (const listener of entry.listeners.values()) {
			listener.onState?.(cloneSummary(summary));
		}
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	writeInput(taskId: string, data: Buffer): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		if (isCodexAgent(entry.summary.agentId)) {
			const active =
				this.ensureCodexActiveState(taskId, entry, {
					cwd: entry.summary.lastKnownWorkspacePath ?? entry.summary.workspacePath ?? null,
				}) ?? null;
			if (!active) {
				return null;
			}
			void this.ensureCodexAttached(taskId, entry, active);
			const text = data.toString("utf8");
			for (const char of text) {
				if (char === "\u0003") {
					active.inputQueue.push({ kind: "interrupt" });
					this.emitOutput(taskId, Buffer.from("^C\r\n", "utf8"));
					void this.flushCodexInputQueue(taskId, entry, active);
					continue;
				}
				if (char === "\r" || char === "\n") {
					const submitted = active.lineBuffer;
					active.lineBuffer = "";
					this.emitOutput(taskId, Buffer.from("\r\n", "utf8"));
					active.inputQueue.push({
						kind: "submit",
						text: submitted,
					});
					void this.flushCodexInputQueue(taskId, entry, active);
					continue;
				}
				if (char === "\u007f" || char === "\b") {
					const previousLine = active.lineBuffer;
					active.lineBuffer = active.lineBuffer.slice(0, -1);
					const echo = buildCodexLineEditEcho(previousLine, active.lineBuffer);
					if (echo) {
						this.emitOutput(taskId, Buffer.from(echo, "utf8"));
					}
					continue;
				}
				const previousLine = active.lineBuffer;
				active.lineBuffer += char;
				const echo = buildCodexLineEditEcho(previousLine, active.lineBuffer);
				if (echo) {
					this.emitOutput(taskId, Buffer.from(echo, "utf8"));
				}
			}
			return cloneSummary(entry.summary);
		}
		if (!isPtyActive(entry.active)) {
			return null;
		}
		if (
			entry.summary.agentId === "codex" &&
			entry.summary.state === "awaiting_review" &&
			(entry.summary.reviewReason === "hook" ||
				entry.summary.reviewReason === "attention" ||
				entry.summary.reviewReason === "error") &&
			(data.includes(13) || data.includes(10))
		) {
			entry.active.awaitingCodexPromptAfterEnter = true;
		}
		entry.active.session.write(data);
		return cloneSummary(entry.summary);
	}

	resize(taskId: string, cols: number, rows: number, pixelWidth?: number, pixelHeight?: number): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		const safeCols = Math.max(1, Math.floor(cols));
		const safeRows = Math.max(1, Math.floor(rows));
		const safePixelWidth = Number.isFinite(pixelWidth ?? Number.NaN) ? Math.floor(pixelWidth as number) : undefined;
		const safePixelHeight = Number.isFinite(pixelHeight ?? Number.NaN)
			? Math.floor(pixelHeight as number)
			: undefined;
		const normalizedPixelWidth = safePixelWidth !== undefined && safePixelWidth > 0 ? safePixelWidth : undefined;
		const normalizedPixelHeight = safePixelHeight !== undefined && safePixelHeight > 0 ? safePixelHeight : undefined;
		if (isPtyActive(entry.active)) {
			entry.active.session.resize(safeCols, safeRows, normalizedPixelWidth, normalizedPixelHeight);
		}
		entry.terminalStateMirror?.resize(safeCols, safeRows);
		entry.active.cols = safeCols;
		entry.active.rows = safeRows;
		if (isCodexActive(entry.active)) {
			this.scheduleRestoreSnapshotPersistence(taskId, entry.sessionGeneration);
		}
		return true;
	}

	pauseOutput(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active || !isPtyActive(entry.active)) {
			return false;
		}
		entry.active.session.pause();
		return true;
	}

	resumeOutput(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active || !isPtyActive(entry.active)) {
			return false;
		}
		entry.active.session.resume();
		return true;
	}

	transitionToReview(taskId: string, reason: RuntimeTaskSessionReviewReason): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		if (reason !== "hook") {
			return cloneSummary(entry.summary);
		}
		const before = entry.summary;
		const summary = this.applySessionEvent(entry, { type: "hook.to_review" });
		if (summary !== before && entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
			this.emitSummary(summary);
		}
		return cloneSummary(summary);
	}

	applyHookActivity(taskId: string, activity: Partial<RuntimeTaskHookActivity>): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}

		const hasActivityUpdate =
			typeof activity.activityText === "string" ||
			typeof activity.toolName === "string" ||
			typeof activity.toolInputSummary === "string" ||
			typeof activity.finalMessage === "string" ||
			typeof activity.hookEventName === "string" ||
			typeof activity.notificationType === "string" ||
			typeof activity.source === "string";
		if (!hasActivityUpdate) {
			return cloneSummary(entry.summary);
		}

		const previous = entry.summary.latestHookActivity;
		const next: RuntimeTaskHookActivity = {
			activityText:
				typeof activity.activityText === "string" ? activity.activityText : (previous?.activityText ?? null),
			toolName: typeof activity.toolName === "string" ? activity.toolName : (previous?.toolName ?? null),
			toolInputSummary:
				typeof activity.toolInputSummary === "string"
					? activity.toolInputSummary
					: (previous?.toolInputSummary ?? null),
			finalMessage:
				typeof activity.finalMessage === "string" ? activity.finalMessage : (previous?.finalMessage ?? null),
			hookEventName:
				typeof activity.hookEventName === "string" ? activity.hookEventName : (previous?.hookEventName ?? null),
			notificationType:
				typeof activity.notificationType === "string"
					? activity.notificationType
					: (previous?.notificationType ?? null),
			source: typeof activity.source === "string" ? activity.source : (previous?.source ?? null),
		};

		const didChange =
			next.activityText !== (previous?.activityText ?? null) ||
			next.toolName !== (previous?.toolName ?? null) ||
			next.toolInputSummary !== (previous?.toolInputSummary ?? null) ||
			next.finalMessage !== (previous?.finalMessage ?? null) ||
			next.hookEventName !== (previous?.hookEventName ?? null) ||
			next.notificationType !== (previous?.notificationType ?? null) ||
			next.source !== (previous?.source ?? null);
		if (!didChange) {
			return cloneSummary(entry.summary);
		}

		const summary = updateSummary(entry, {
			lastHookAt: now(),
			latestHookActivity: next,
		});
		if (entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
		}
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	transitionToRunning(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		const before = entry.summary;
		const summary = this.applySessionEvent(entry, { type: "hook.to_in_progress" });
		if (summary !== before && entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
			this.emitSummary(summary);
		}
		return cloneSummary(summary);
	}

	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}

		const latestCheckpoint = entry.summary.latestTurnCheckpoint ?? null;
		if (latestCheckpoint?.ref === checkpoint.ref && latestCheckpoint.commit === checkpoint.commit) {
			return cloneSummary(entry.summary);
		}

		const summary = updateSummary(entry, {
			previousTurnCheckpoint: latestCheckpoint,
			latestTurnCheckpoint: checkpoint,
		});
		if (entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
		}
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	stopTaskSession(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return entry ? cloneSummary(entry.summary) : null;
		}
		entry.suppressAutoRestartOnExit = true;
		if (isCodexActive(entry.active)) {
			if (entry.active.pendingApproval) {
				this.resolveCodexPendingApproval(taskId, entry, entry.active, "cancel");
			}
			entry.active.stopMode = "stop";
			entry.active.inputQueue.length = 0;
			entry.active.lineBuffer = "";
			if (entry.active.activeTurnId) {
				entry.active.inputQueue.push({ kind: "interrupt" });
				void this.flushCodexInputQueue(taskId, entry, entry.active);
			} else {
				const summary = updateSummary(entry, {
					state: "idle",
					reviewReason: null,
					pid: this.codexClient?.pid ?? null,
					warningMessage: null,
				});
				this.notifyTaskListeners(taskId, summary);
				this.emitSummary(summary);
				this.emitCodexInlinePromptIfNeeded(taskId, entry, entry.active);
			}
			return cloneSummary(entry.summary);
		}
		const cleanupFn = entry.active.onSessionCleanup;
		entry.active.onSessionCleanup = null;
		stopWorkspaceTrustTimers(entry.active);
		entry.active.session.stop();
		if (cleanupFn) {
			cleanupFn().catch(() => {
				// Best effort: cleanup failure is non-critical.
			});
		}
		return cloneSummary(entry.summary);
	}

	markInterruptedAndStopAll(): RuntimeTaskSessionSummary[] {
		const activeEntries = Array.from(this.entries.values()).filter((entry) => entry.active != null);
		for (const entry of activeEntries) {
			if (!entry.active) {
				continue;
			}
			if (isCodexActive(entry.active)) {
				if (entry.active.pendingApproval) {
					this.resolveCodexPendingApproval(entry.summary.taskId, entry, entry.active, "cancel");
				}
				entry.active.stopMode = "shutdown";
				entry.active.inputQueue.length = 0;
				if (entry.active.activeTurnId) {
					entry.active.inputQueue.push({ kind: "interrupt" });
					void this.flushCodexInputQueue(entry.summary.taskId, entry, entry.active);
				} else {
					const summary = updateSummary(entry, {
						state: "interrupted",
						reviewReason: "interrupted",
						pid: null,
					});
					this.notifyTaskListeners(entry.summary.taskId, summary);
					this.emitSummary(summary);
				}
				continue;
			}
			stopWorkspaceTrustTimers(entry.active);
			entry.active.session.stop({ interrupted: true });
		}
		return activeEntries.map((entry) => cloneSummary(entry.summary));
	}

	private applySessionEvent(entry: SessionEntry, event: SessionTransitionEvent): RuntimeTaskSessionSummary {
		const transition = reduceSessionTransition(entry.summary, event);
		if (!transition.changed) {
			return entry.summary;
		}
		if (transition.clearAttentionBuffer && isPtyActive(entry.active)) {
			if (entry.active.workspaceTrustBuffer !== null) {
				entry.active.workspaceTrustBuffer = "";
			}
		}
		if (isPtyActive(entry.active) && transition.changed && transition.patch.state === "awaiting_review") {
			entry.active.awaitingCodexPromptAfterEnter = false;
		}
		return updateSummary(entry, transition.patch);
	}

	private ensureEntry(taskId: string): SessionEntry {
		const existing = this.entries.get(taskId);
		if (existing) {
			return existing;
		}
		const created: SessionEntry = {
			summary: createDefaultSummary(taskId),
			active: null,
			terminalStateMirror: null,
			sessionGeneration: 0,
			snapshotPersistTimer: null,
			listenerIdCounter: 1,
			listeners: new Map(),
			restartRequest: null,
			suppressAutoRestartOnExit: false,
			autoRestartTimestamps: [],
			pendingAutoRestart: null,
		};
		this.entries.set(taskId, created);
		return created;
	}

	private shouldAutoRestart(entry: SessionEntry): boolean {
		const wasSuppressed = entry.suppressAutoRestartOnExit;
		entry.suppressAutoRestartOnExit = false;
		if (wasSuppressed) {
			return false;
		}
		if (entry.listeners.size === 0 || entry.restartRequest?.kind !== "task") {
			return false;
		}
		const currentTime = now();
		entry.autoRestartTimestamps = entry.autoRestartTimestamps.filter(
			(timestamp) => currentTime - timestamp < AUTO_RESTART_WINDOW_MS,
		);
		if (entry.autoRestartTimestamps.length >= MAX_AUTO_RESTARTS_PER_WINDOW) {
			return false;
		}
		entry.autoRestartTimestamps.push(currentTime);
		return true;
	}

	private scheduleAutoRestart(entry: SessionEntry): void {
		if (entry.pendingAutoRestart) {
			return;
		}
		const restartRequest = entry.restartRequest;
		if (!restartRequest || restartRequest.kind !== "task") {
			return;
		}
		let pendingAutoRestart: Promise<void> | null = null;
		pendingAutoRestart = (async () => {
			try {
				await this.startTaskSession(cloneStartTaskSessionRequest(restartRequest.request));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const summary = updateSummary(entry, {
					warningMessage: message,
				});
				const output = Buffer.from(`\r\n[kanban] ${message}\r\n`, "utf8");
				for (const listener of entry.listeners.values()) {
					listener.onOutput?.(output);
					listener.onState?.(cloneSummary(summary));
				}
				this.emitSummary(summary);
			} finally {
				if (entry.pendingAutoRestart === pendingAutoRestart) {
					entry.pendingAutoRestart = null;
				}
			}
		})();
		entry.pendingAutoRestart = pendingAutoRestart;
	}

	private emitSummary(summary: RuntimeTaskSessionSummary): void {
		const snapshot = cloneSummary(summary);
		for (const listener of this.summaryListeners) {
			listener(snapshot);
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		const interrupted = this.markInterruptedAndStopAll();
		for (const summary of interrupted) {
			this.emitSummary(summary);
		}
		for (const [taskId, entry] of this.entries.entries()) {
			if (entry.snapshotPersistTimer) {
				clearTimeout(entry.snapshotPersistTimer);
				entry.snapshotPersistTimer = null;
			}
			if (isPtyActive(entry.active)) {
				stopWorkspaceTrustTimers(entry.active);
				const cleanupFn = entry.active.onSessionCleanup;
				entry.active.onSessionCleanup = null;
				entry.active.session.stop({ interrupted: true });
				if (cleanupFn) {
					void cleanupFn().catch(() => {
						// Best effort: cleanup failure is non-critical.
					});
				}
			}
			if (isCodexActive(entry.active)) {
				this.unregisterCodexThread(taskId, entry.active.threadId);
			}
			entry.active = null;
			entry.terminalStateMirror?.dispose();
			entry.terminalStateMirror = null;
			entry.listeners.clear();
		}
		for (const unsubscribe of this.codexClientUnsubscribes) {
			unsubscribe();
		}
		this.codexClientUnsubscribes = [];
		const client = this.codexClient;
		this.codexClient = null;
		this.codexClientPromise = null;
		this.codexTaskIdByThreadId.clear();
		if (client) {
			await client.close().catch(() => {
				// Best effort: host cleanup failure is non-critical during teardown.
			});
		}
	}
}
