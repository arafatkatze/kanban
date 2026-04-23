// LiteLLM-specific model discovery that works with virtual (non-admin) keys.
//
// The Cline SDK's built-in LiteLLM catalog fetcher calls `/v1/model/info`.
// That endpoint is an admin-only LiteLLM route: when a user is authenticated
// with a virtual key, the proxy returns 401/403 and the SDK falls back to
// a single hard-coded default model (e.g. `gpt-5.4`). See issue #270.
//
// The OpenAI-compatible `/v1/models` endpoint is allowlist-aware for
// virtual keys (it returns only the model IDs the key is allowed to use),
// so we use it as a reliable secondary source. We still merge in whatever
// the SDK was able to produce from `/v1/model/info`, so admin keys keep
// their richer metadata while virtual keys still see their allow-listed IDs
// in the model picker.

import type { SdkProviderModel } from "./sdk-provider-boundary";

// LiteLLM follows the OpenAI /v1/models shape: `{ object, data: [{ id, ... }] }`.
// We accept a handful of fallback locations to be tolerant of proxies that
// return alternate layouts.
interface LiteLlmOpenAiModelsResponse {
	object?: string;
	data?: Array<{ id?: unknown; display_name?: unknown } | null | undefined>;
	models?: Array<{ id?: unknown; name?: unknown } | string | null | undefined>;
}

export interface DiscoverLiteLlmModelsInput {
	baseUrl: string | null | undefined;
	apiKey: string | null | undefined;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

const DEFAULT_LITELLM_BASE_URL = "http://localhost:4000";
const DEFAULT_TIMEOUT_MS = 5_000;

// `baseUrl` in provider settings commonly ends with `/v1` because LiteLLM is
// OpenAI-compatible. `/v1/models` already lives on `/v1`, so strip it to get
// a canonical root and append `/v1/models`.
export function normalizeLiteLlmRootUrl(baseUrl: string | null | undefined): string {
	const normalized = (baseUrl ?? "").trim();
	if (!normalized) {
		return DEFAULT_LITELLM_BASE_URL;
	}
	const trimmed = normalized.replace(/\/+$/, "");
	if (trimmed.endsWith("/v1")) {
		return trimmed.slice(0, -3);
	}
	return trimmed;
}

function coerceStringId(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function parseLiteLlmOpenAiModelsPayload(payload: unknown): string[] {
	if (!payload || typeof payload !== "object") {
		return [];
	}
	const casted = payload as LiteLlmOpenAiModelsResponse;
	const seen = new Set<string>();
	const output: string[] = [];

	const push = (value: unknown) => {
		const id = coerceStringId(value);
		if (id && !seen.has(id)) {
			seen.add(id);
			output.push(id);
		}
	};

	for (const entry of casted.data ?? []) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		push(entry.id);
	}

	for (const entry of casted.models ?? []) {
		if (typeof entry === "string") {
			push(entry);
			continue;
		}
		if (entry && typeof entry === "object") {
			push((entry as { id?: unknown }).id);
		}
	}

	return output;
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
	fetchImpl: typeof fetch,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchImpl(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

// Ask LiteLLM for the OpenAI-compatible models list. Virtual keys only see the
// IDs they are allowlisted for, which is exactly what the model picker should
// surface. We try both auth header styles LiteLLM supports so that this works
// with every virtual-key configuration we have observed in the wild.
export async function discoverLiteLlmModelIds(input: DiscoverLiteLlmModelsInput): Promise<string[]> {
	const apiKey = (input.apiKey ?? "").trim();
	if (!apiKey) {
		return [];
	}

	const fetchImpl = input.fetchImpl ?? fetch;
	const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const endpoint = `${normalizeLiteLlmRootUrl(input.baseUrl)}/v1/models`;

	const attempts: Array<Record<string, string>> = [
		{ Authorization: `Bearer ${apiKey}` },
		{ "x-litellm-api-key": apiKey },
	];

	for (const headers of attempts) {
		try {
			const response = await fetchWithTimeout(
				endpoint,
				{
					method: "GET",
					headers: {
						accept: "application/json",
						...headers,
					},
				},
				timeoutMs,
				fetchImpl,
			);
			if (!response.ok) {
				continue;
			}
			const payload = (await response.json()) as unknown;
			const ids = parseLiteLlmOpenAiModelsPayload(payload);
			if (ids.length > 0) {
				return ids;
			}
		} catch {
			// Try the next auth style.
		}
	}

	return [];
}

// Merge SDK-returned models with additional IDs discovered from `/v1/models`,
// preserving the SDK-provided metadata (capabilities, display names) when the
// same ID appears in both. Newly discovered IDs get minimal metadata.
export function mergeLiteLlmModels(
	sdkModels: readonly SdkProviderModel[],
	discoveredIds: readonly string[],
): SdkProviderModel[] {
	const byId = new Map<string, SdkProviderModel>();
	for (const model of sdkModels) {
		const id = model.id.trim();
		if (id.length > 0) {
			byId.set(id, { ...model, id });
		}
	}

	for (const rawId of discoveredIds) {
		const id = rawId.trim();
		if (!id || byId.has(id)) {
			continue;
		}
		byId.set(id, { id, name: id });
	}

	return [...byId.values()];
}
