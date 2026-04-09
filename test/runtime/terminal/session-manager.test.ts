import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type {
	CodexAppServerClient,
	CodexRpcNotification,
	CodexRpcServerRequest,
} from "../../../src/codex-sdk/codex-app-server-client";
import { buildShellCommandLine } from "../../../src/core/shell";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

function createDeferredPromise<T>() {
	let resolvePromise: ((value: T | PromiseLike<T>) => void) | null = null;
	let rejectPromise: ((reason?: unknown) => void) | null = null;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return {
		promise,
		resolve: (value: T) => resolvePromise?.(value),
		reject: (reason?: unknown) => rejectPromise?.(reason),
	};
}

async function waitForAssertion(assertion: () => void, timeoutMs = 1_000): Promise<void> {
	const startedAt = Date.now();
	let lastError: unknown = null;
	while (Date.now() - startedAt < timeoutMs) {
		try {
			assertion();
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	if (lastError) {
		throw lastError;
	}
	assertion();
}

class FakeCodexClient implements CodexAppServerClient {
	readonly pid = 4242;
	readonly requests: Array<{ method: string; params?: unknown }> = [];
	readonly responses: Array<{ id: number | string; result: unknown }> = [];
	readonly initialize = vi.fn(async () => undefined);
	readonly notify = vi.fn();
	readonly close = vi.fn(async () => undefined);

	private readonly notificationListeners = new Set<(message: CodexRpcNotification) => void>();
	private readonly serverRequestListeners = new Set<(message: CodexRpcServerRequest) => void>();
	private readonly exitListeners = new Set<(error: Error | null) => void>();
	private readonly requestHandlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>();

	setRequestHandler(method: string, handler: (params: unknown) => Promise<unknown> | unknown): void {
		this.requestHandlers.set(method, handler);
	}

	async request<T>(method: string, params?: unknown): Promise<T> {
		this.requests.push({ method, params });
		const handler = this.requestHandlers.get(method);
		if (!handler) {
			throw new Error(`Missing fake Codex handler for ${method}`);
		}
		return (await handler(params)) as T;
	}

	respond(id: number | string, result: unknown): void {
		this.responses.push({ id, result });
	}

	onNotification(listener: (message: CodexRpcNotification) => void): () => void {
		this.notificationListeners.add(listener);
		return () => {
			this.notificationListeners.delete(listener);
		};
	}

	onServerRequest(listener: (message: CodexRpcServerRequest) => void): () => void {
		this.serverRequestListeners.add(listener);
		return () => {
			this.serverRequestListeners.delete(listener);
		};
	}

	onExit(listener: (error: Error | null) => void): () => void {
		this.exitListeners.add(listener);
		return () => {
			this.exitListeners.delete(listener);
		};
	}

	emitNotification(message: CodexRpcNotification): void {
		for (const listener of this.notificationListeners) {
			listener(message);
		}
	}

	emitServerRequest(request: CodexRpcServerRequest): void {
		for (const listener of this.serverRequestListeners) {
			listener(request);
		}
	}

	emitExit(error: Error | null): void {
		for (const listener of this.exitListeners) {
			listener(error);
		}
	}
}

describe("TerminalSessionManager", () => {
	it("clears trust prompt state when transitioning to review", () => {
		const manager = new TerminalSessionManager();
		const entry = {
			summary: createSummary({ state: "running", reviewReason: null }),
			active: {
				kind: "pty",
				workspaceTrustBuffer: "trust this folder",
				awaitingCodexPromptAfterEnter: true,
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		const applySessionEvent = (
			manager as unknown as {
				applySessionEvent: (sessionEntry: unknown, event: { type: "hook.to_review" }) => RuntimeTaskSessionSummary;
			}
		).applySessionEvent;
		const nextSummary = applySessionEvent(entry, { type: "hook.to_review" });
		expect(nextSummary.state).toBe("awaiting_review");
		expect(entry.active.workspaceTrustBuffer).toBe("");
	});

	it("builds shell kickoff command lines with quoted arguments", () => {
		const commandLine = buildShellCommandLine("cline", ["--auto-approve-all", "hello world"]);
		expect(commandLine).toContain("cline");
		expect(commandLine).toContain("--auto-approve-all");
		expect(commandLine).toContain("hello world");
	});

	it("stores hook activity metadata on sessions", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		const updated = manager.applyHookActivity("task-1", {
			source: "claude",
			activityText: "Using Read",
			toolName: "Read",
		});

		expect(updated?.latestHookActivity?.source).toBe("claude");
		expect(updated?.latestHookActivity?.activityText).toBe("Using Read");
		expect(updated?.latestHookActivity?.toolName).toBe("Read");
		expect(typeof updated?.lastHookAt).toBe("number");
	});

	it("resets stale running sessions without active processes", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		const recovered = manager.recoverStaleSession("task-1");

		expect(recovered?.state).toBe("idle");
		expect(recovered?.pid).toBeNull();
		expect(recovered?.agentId).toBe("claude");
		expect(recovered?.workspacePath).toBeNull();
		expect(recovered?.reviewReason).toBeNull();
	});

	it("tracks only the latest two turn checkpoints", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		manager.applyTurnCheckpoint("task-1", {
			turn: 1,
			ref: "refs/kanban/checkpoints/task-1/turn/1",
			commit: "1111111",
			createdAt: 1,
		});
		manager.applyTurnCheckpoint("task-1", {
			turn: 2,
			ref: "refs/kanban/checkpoints/task-1/turn/2",
			commit: "2222222",
			createdAt: 2,
		});

		const summary = manager.getSummary("task-1");
		expect(summary?.latestTurnCheckpoint?.turn).toBe(2);
		expect(summary?.previousTurnCheckpoint?.turn).toBe(1);
	});

	it("does not replay raw PTY history when attaching an output listener", () => {
		const manager = new TerminalSessionManager();
		const onOutput = vi.fn();
		const entry = {
			summary: createSummary({ taskId: "task-probe", state: "running" }),
			active: {
				kind: "pty",
				session: {},
				terminalProtocolFilter: {
					pendingChunk: null,
					interceptOscColorQueries: true,
					suppressDeviceAttributeQueries: false,
				},
			},
			terminalStateMirror: null,
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-probe", entry);

		manager.attach("task-probe", {
			onOutput,
		});

		expect(onOutput).not.toHaveBeenCalled();
		expect(entry.active.terminalProtocolFilter.interceptOscColorQueries).toBe(false);
	});

	it("keeps the startup probe filter enabled when only a non-output listener attaches", () => {
		const manager = new TerminalSessionManager();
		const entry = {
			summary: createSummary({ taskId: "task-control-first", state: "running" }),
			active: {
				kind: "pty",
				session: {
					write: vi.fn(),
				},
				terminalProtocolFilter: {
					pendingChunk: null,
					interceptOscColorQueries: true,
					suppressDeviceAttributeQueries: false,
				},
			},
			terminalStateMirror: null,
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-control-first", entry);

		manager.attach("task-control-first", {
			onState: vi.fn(),
			onExit: vi.fn(),
		});

		expect(entry.active.terminalProtocolFilter.interceptOscColorQueries).toBe(true);
		expect(entry.active.terminalProtocolFilter.pendingChunk).toBeNull();
	});

	it("forwards pixel dimensions through resize when provided", () => {
		const manager = new TerminalSessionManager();
		const resizeSpy = vi.fn();
		const resizeMirrorSpy = vi.fn();
		const entry = {
			summary: createSummary({ taskId: "task-resize", state: "running" }),
			active: {
				kind: "pty",
				session: {
					resize: resizeSpy,
				},
				cols: 80,
				rows: 24,
			},
			terminalStateMirror: {
				resize: resizeMirrorSpy,
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-resize", entry);

		const resized = manager.resize("task-resize", 100, 30, 1200, 720);
		expect(resized).toBe(true);
		expect(resizeSpy).toHaveBeenCalledWith(100, 30, 1200, 720);
		expect(resizeMirrorSpy).toHaveBeenCalledWith(100, 30);
	});

	it("returns the latest terminal restore snapshot when available", async () => {
		const manager = new TerminalSessionManager();
		const getSnapshotSpy = vi.fn(async () => ({
			snapshot: "serialized terminal",
			cols: 120,
			rows: 40,
		}));
		const entry = {
			summary: createSummary({ taskId: "task-restore", state: "running" }),
			active: null,
			terminalStateMirror: {
				getSnapshot: getSnapshotSpy,
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-restore", entry);

		const snapshot = await manager.getRestoreSnapshot("task-restore");

		expect(snapshot).toEqual({
			snapshot: "serialized terminal",
			cols: 120,
			rows: 40,
		});
		expect(getSnapshotSpy).toHaveBeenCalledTimes(1);
	});

	it("falls back to the persisted terminal restore snapshot when no live mirror exists", async () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-restore": createSummary({
				taskId: "task-restore",
				state: "idle",
				terminalRestoreSnapshot: "persisted terminal",
				terminalRestoreCols: 132,
				terminalRestoreRows: 44,
			}),
		});

		const snapshot = await manager.getRestoreSnapshot("task-restore");

		expect(snapshot).toEqual({
			snapshot: "persisted terminal",
			cols: 132,
			rows: 44,
		});
	});

	it("falls back to a fresh Codex thread when exact resume fails", async () => {
		const fakeClient = new FakeCodexClient();
		fakeClient.setRequestHandler("thread/resume", async () => {
			throw new Error("thread not found");
		});
		fakeClient.setRequestHandler("thread/start", async () => ({
			thread: {
				id: "thr-new",
				cwd: "/tmp/worktree",
				turns: [],
			},
		}));
		const manager = new TerminalSessionManager({
			createCodexClient: () => fakeClient,
		});

		const summary = await manager.startTaskSession({
			taskId: "task-codex-fallback",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/worktree",
			prompt: "",
			resumeSessionId: "thr-old",
		});

		expect(summary.agentSessionId).toBe("thr-old");
		await waitForAssertion(() => {
			expect(manager.getSummary("task-codex-fallback")?.agentSessionId).toBe("thr-new");
		});
		expect(fakeClient.requests.map((request) => request.method)).toEqual([
			"thread/resume",
			"thread/start",
		]);
	});

	it("queues Codex input until attach completes and then starts the turn", async () => {
		const fakeClient = new FakeCodexClient();
		const attachDeferred = createDeferredPromise<Record<string, unknown>>();
		fakeClient.setRequestHandler("thread/start", () => attachDeferred.promise);
		fakeClient.setRequestHandler("turn/start", async (params) => ({
			turn: {
				id: "turn-1",
			},
			params,
		}));
		const manager = new TerminalSessionManager({
			createCodexClient: () => fakeClient,
		});

		await manager.startTaskSession({
			taskId: "task-codex-queue",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/worktree",
			prompt: "",
		});

		manager.writeInput("task-codex-queue", Buffer.from("hello\r", "utf8"));
		await waitForAssertion(() => {
			expect(fakeClient.requests.map((request) => request.method)).toContain("thread/start");
		});

		attachDeferred.resolve({
			thread: {
				id: "thr-queued",
				cwd: "/tmp/worktree",
				turns: [],
			},
		});

		await waitForAssertion(() => {
			expect(fakeClient.requests.map((request) => request.method)).toContain("turn/start");
		});
		const turnStartRequest = fakeClient.requests.find((request) => request.method === "turn/start");
		expect(turnStartRequest).toBeDefined();
		expect(JSON.stringify(turnStartRequest?.params)).toContain("hello");
	});

	it("closes the shared Codex host when the terminal manager is disposed", async () => {
		const fakeClient = new FakeCodexClient();
		fakeClient.setRequestHandler("thread/start", async () => ({
			thread: {
				id: "thr-dispose",
				cwd: "/tmp/worktree",
				turns: [],
			},
		}));
		const manager = new TerminalSessionManager({
			createCodexClient: () => fakeClient,
		});

		await manager.startTaskSession({
			taskId: "task-codex-dispose",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/worktree",
			prompt: "",
		});
		await waitForAssertion(() => {
			expect(manager.getSummary("task-codex-dispose")?.agentSessionId).toBe("thr-dispose");
		});

		await manager.dispose();

		expect(fakeClient.close).toHaveBeenCalledTimes(1);
	});
});
