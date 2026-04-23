// Resolve the API key handed to the Cline SDK when starting a native session.
//
// Background: the Cline SDK's `openai-compatible` client (used by Ollama, LM
// Studio, llama.cpp, MLX and any user-added custom OpenAI-compatible provider)
// refuses to start a session when no `apiKey` is set and no `Authorization`
// header is pre-configured. That matches the public Cline CLI behavior, but
// local model servers such as MLX (`mlx_lm.server`), Ollama, or llama.cpp
// typically do not require auth and do not ship an API key.
//
// The Cline CLI resolves this by letting the user omit the key entirely, but
// Kanban starts the SDK session directly (see `cline-session-runtime.ts`), so
// we must supply a placeholder when we can confidently infer the provider is a
// local-host server. The placeholder is never compared server-side, and the
// SDK forwards it unchanged as the `Authorization: Bearer …` header. Local
// servers that ignore auth treat it as a no-op, and servers that DO enforce
// auth still reject requests exactly as they did before this change.

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

const PLACEHOLDER_LOCAL_API_KEY = "kanban-local-placeholder";

function normalizeBaseUrlHost(baseUrl: string): string | null {
	const trimmed = baseUrl.trim();
	if (!trimmed) {
		return null;
	}
	try {
		return new URL(trimmed).hostname.toLowerCase();
	} catch {
		return null;
	}
}

export function isLocalBaseUrl(baseUrl: string | null | undefined): boolean {
	if (!baseUrl) {
		return false;
	}
	const hostname = normalizeBaseUrlHost(baseUrl);
	if (!hostname) {
		return false;
	}
	if (LOCAL_HOSTNAMES.has(hostname)) {
		return true;
	}
	return hostname.endsWith(".localhost");
}

export interface ResolveClineLaunchApiKeyInput {
	apiKey: string | null | undefined;
	baseUrl: string | null | undefined;
}

// Return the apiKey Kanban should hand to the Cline SDK when starting a
// session. Preserves user-supplied keys unchanged and only substitutes the
// placeholder when the user left the key blank AND the baseUrl is loopback.
export function resolveClineLaunchApiKey(input: ResolveClineLaunchApiKeyInput): string | undefined {
	const trimmed = input.apiKey?.trim();
	if (trimmed) {
		return trimmed;
	}
	if (isLocalBaseUrl(input.baseUrl)) {
		return PLACEHOLDER_LOCAL_API_KEY;
	}
	return undefined;
}
