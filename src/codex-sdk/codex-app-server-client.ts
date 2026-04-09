import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface CodexRpcError {
	code?: number;
	message: string;
	data?: unknown;
}

export interface CodexRpcNotification {
	method: string;
	params?: unknown;
}

export interface CodexRpcServerRequest {
	id: number | string;
	method: string;
	params?: unknown;
}

export interface CodexAppServerClientInfo {
	name: string;
	title: string;
	version: string;
}

export interface CreateCodexAppServerClientOptions {
	binary: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string | undefined>;
	clientInfo?: CodexAppServerClientInfo;
}

export interface CodexAppServerClient {
	readonly pid: number | null;
	initialize(): Promise<void>;
	request<T>(method: string, params?: unknown): Promise<T>;
	notify(method: string, params?: unknown): void;
	respond(id: number | string, result: unknown): void;
	onNotification(listener: (message: CodexRpcNotification) => void): () => void;
	onServerRequest(listener: (message: CodexRpcServerRequest) => void): () => void;
	onExit(listener: (error: Error | null) => void): () => void;
	close(): Promise<void>;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

interface JsonRpcResponseMessage {
	id: number | string;
	result?: unknown;
	error?: CodexRpcError;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRpcError(method: string, error: unknown): Error {
	if (isJsonObject(error) && typeof error.message === "string") {
		const code = typeof error.code === "number" ? ` (${error.code})` : "";
		return new Error(`${method}${code}: ${error.message}`);
	}
	if (error instanceof Error) {
		return error;
	}
	return new Error(`${method}: ${String(error)}`);
}

export function createCodexAppServerClient(
	options: CreateCodexAppServerClientOptions,
): CodexAppServerClient {
	const commandArgs = options.args ?? ["app-server", "-c", "check_for_update_on_startup=false"];
	const clientInfo: CodexAppServerClientInfo = options.clientInfo ?? {
		name: "kanban",
		title: "Kanban",
		version: "0.0.0",
	};
	const child = spawn(options.binary, commandArgs, {
		cwd: options.cwd,
		env: {
			...process.env,
			...options.env,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});

	let stdoutBuffer = "";
	let closed = false;
	let initialized = false;
	let initializePromise: Promise<void> | null = null;
	let nextRequestId = 1;
	const pendingRequests = new Map<number, PendingRequest>();
	const notificationListeners = new Set<(message: CodexRpcNotification) => void>();
	const serverRequestListeners = new Set<(message: CodexRpcServerRequest) => void>();
	const exitListeners = new Set<(error: Error | null) => void>();
	const stderrLines: string[] = [];

	const rememberStderr = (chunk: string) => {
		for (const line of chunk.split(/\r?\n/u)) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}
			stderrLines.push(trimmed);
			if (stderrLines.length > 20) {
				stderrLines.shift();
			}
		}
	};

	const rejectPendingRequests = (error: Error) => {
		for (const pending of pendingRequests.values()) {
			pending.reject(error);
		}
		pendingRequests.clear();
	};

	const handleExit = (error: Error | null) => {
		if (closed) {
			return;
		}
		closed = true;
		rejectPendingRequests(
			error ??
				new Error(
					stderrLines.length > 0
						? `Codex app-server exited. ${stderrLines.join(" | ")}`
						: "Codex app-server exited.",
				),
		);
		for (const listener of exitListeners) {
			listener(error);
		}
	};

	const writeMessage = (message: Record<string, unknown>) => {
		if (closed || !child.stdin.writable) {
			throw new Error("Codex app-server is not writable.");
		}
		child.stdin.write(`${JSON.stringify(message)}\n`);
	};

	const handleResponse = (message: JsonRpcResponseMessage) => {
		if (typeof message.id !== "number") {
			return;
		}
		const pending = pendingRequests.get(message.id);
		if (!pending) {
			return;
		}
		pendingRequests.delete(message.id);
		if (message.error) {
			pending.reject(normalizeRpcError("Codex app-server request failed", message.error));
			return;
		}
		pending.resolve(message.result);
	};

	const handleMessage = (rawLine: string) => {
		const line = rawLine.trim();
		if (!line) {
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			rememberStderr(line);
			return;
		}
		if (!isJsonObject(parsed)) {
			return;
		}
		if ("result" in parsed || "error" in parsed) {
			handleResponse(parsed as unknown as JsonRpcResponseMessage);
			return;
		}
		if (typeof parsed.method !== "string") {
			return;
		}
		if ("id" in parsed && (typeof parsed.id === "number" || typeof parsed.id === "string")) {
			const request: CodexRpcServerRequest = {
				id: parsed.id,
				method: parsed.method,
				params: parsed.params,
			};
			for (const listener of serverRequestListeners) {
				listener(request);
			}
			return;
		}
		const notification: CodexRpcNotification = {
			method: parsed.method,
			params: parsed.params,
		};
		for (const listener of notificationListeners) {
			listener(notification);
		}
	};

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdoutBuffer += chunk;
		while (true) {
			const newlineIndex = stdoutBuffer.indexOf("\n");
			if (newlineIndex < 0) {
				break;
			}
			const line = stdoutBuffer.slice(0, newlineIndex);
			stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
			handleMessage(line);
		}
	});

	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		rememberStderr(chunk);
	});

	child.on("error", (error) => {
		handleExit(error);
	});

	child.on("exit", (code, signal) => {
		const error =
			code === 0 && signal === null
				? null
				: new Error(
						stderrLines.length > 0
							? `Codex app-server exited with code ${code ?? "null"}${
									signal ? ` signal ${signal}` : ""
							  }. ${stderrLines.join(" | ")}`
							: `Codex app-server exited with code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}.`,
				  );
		handleExit(error);
	});

	const request = async <T>(method: string, params?: unknown): Promise<T> => {
		if (closed) {
			throw new Error("Codex app-server is closed.");
		}
		const id = nextRequestId;
		nextRequestId += 1;
		return await new Promise<T>((resolve, reject) => {
			pendingRequests.set(id, {
				resolve: (value) => resolve(value as T),
				reject,
			});
			try {
				writeMessage({
					id,
					method,
					params,
				});
			} catch (error) {
				pendingRequests.delete(id);
				reject(normalizeRpcError(method, error));
			}
		});
	};

	return {
		get pid() {
			return child.pid ?? null;
		},
		async initialize(): Promise<void> {
			if (initialized) {
				return;
			}
			if (initializePromise) {
				return await initializePromise;
			}
			initializePromise = (async () => {
				await request("initialize", {
					clientInfo,
					capabilities: {
						experimentalApi: true,
					},
				});
				writeMessage({
					method: "initialized",
					params: {},
				});
				initialized = true;
			})()
				.catch((error) => {
					throw normalizeRpcError("initialize", error);
				})
				.finally(() => {
					initializePromise = null;
				});
			return await initializePromise;
		},
		async request<T>(method: string, params?: unknown): Promise<T> {
			return await request<T>(method, params);
		},
		notify(method: string, params?: unknown): void {
			writeMessage({
				method,
				params,
			});
		},
		respond(id: number | string, result: unknown): void {
			writeMessage({
				id,
				result,
			});
		},
		onNotification(listener) {
			notificationListeners.add(listener);
			return () => {
				notificationListeners.delete(listener);
			};
		},
		onServerRequest(listener) {
			serverRequestListeners.add(listener);
			return () => {
				serverRequestListeners.delete(listener);
			};
		},
		onExit(listener) {
			exitListeners.add(listener);
			return () => {
				exitListeners.delete(listener);
			};
		},
		async close(): Promise<void> {
			if (closed) {
				return;
			}
			closed = true;
			rejectPendingRequests(new Error("Codex app-server closed."));
			child.stdin.end();
			child.kill("SIGTERM");
			await new Promise<void>((resolve) => {
				if (child.exitCode !== null || child.killed) {
					resolve();
					return;
				}
				child.once("exit", () => resolve());
			});
		},
	};
}
