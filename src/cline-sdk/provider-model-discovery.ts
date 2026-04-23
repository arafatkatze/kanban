import type { RuntimeClineProviderModel } from "../core/api-contract";

const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 5_000;

interface NormalizedModelCandidate {
	id?: unknown;
	name?: unknown;
	supportsVision?: unknown;
	supportsAttachments?: unknown;
	supportsReasoning?: unknown;
	supportsReasoningEffort?: unknown;
}

function ensureTrailingSlash(value: string): string {
	return value.endsWith("/") ? value : `${value}/`;
}

function toOptionalBoolean(value: unknown): boolean | undefined {
	return value === true ? true : undefined;
}

function normalizeModel(value: unknown): RuntimeClineProviderModel | null {
	if (typeof value === "string") {
		const id = value.trim();
		if (!id) {
			return null;
		}
		return {
			id,
			name: id,
		};
	}
	if (!value || typeof value !== "object") {
		return null;
	}

	const candidate = value as NormalizedModelCandidate;
	const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
	if (!id) {
		return null;
	}

	const supportsReasoningEffort =
		toOptionalBoolean(candidate.supportsReasoningEffort) ?? toOptionalBoolean(candidate.supportsReasoning);

	return {
		id,
		name: typeof candidate.name === "string" && candidate.name.trim().length > 0 ? candidate.name.trim() : id,
		...(toOptionalBoolean(candidate.supportsVision) ? { supportsVision: true } : {}),
		...(toOptionalBoolean(candidate.supportsAttachments) ? { supportsAttachments: true } : {}),
		...(supportsReasoningEffort ? { supportsReasoningEffort: true } : {}),
	};
}

function collectModelsFromList(value: unknown, models: Map<string, RuntimeClineProviderModel>): boolean {
	if (!Array.isArray(value)) {
		return false;
	}

	let added = false;
	for (const item of value) {
		const model = normalizeModel(item);
		if (!model) {
			continue;
		}
		models.set(model.id, model);
		added = true;
	}
	return added;
}

function collectModelsFromObjectKeys(value: unknown, models: Map<string, RuntimeClineProviderModel>): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}

	const ids = Object.keys(value)
		.map((id) => id.trim())
		.filter((id) => id.length > 0);
	if (ids.length === 0) {
		return false;
	}

	for (const id of ids) {
		models.set(id, {
			id,
			name: id,
		});
	}
	return true;
}

function extractModelsFromPayload(payload: unknown): RuntimeClineProviderModel[] {
	const models = new Map<string, RuntimeClineProviderModel>();
	if (collectModelsFromList(payload, models)) {
		return [...models.values()];
	}
	if (!payload || typeof payload !== "object") {
		return [];
	}

	const root = payload as {
		data?: unknown;
		models?: unknown;
		providers?: Record<string, unknown>;
	};

	if (collectModelsFromList(root.data, models) || collectModelsFromList(root.models, models)) {
		return [...models.values()];
	}
	if (collectModelsFromObjectKeys(root.models, models)) {
		return [...models.values()];
	}

	if (root.providers && typeof root.providers === "object") {
		for (const scopedValue of Object.values(root.providers)) {
			if (collectModelsFromList(scopedValue, models)) {
				return [...models.values()];
			}
			if (!scopedValue || typeof scopedValue !== "object") {
				continue;
			}
			const scopedObject = scopedValue as { models?: unknown };
			if (
				collectModelsFromList(scopedObject.models, models) ||
				collectModelsFromObjectKeys(scopedObject.models, models)
			) {
				return [...models.values()];
			}
		}
	}

	return [...models.values()];
}

function buildModelDiscoveryUrls(baseUrl: string): string[] {
	const trimmedBaseUrl = baseUrl.trim();
	if (!trimmedBaseUrl) {
		return [];
	}

	const urls = new Set<string>();
	const normalizedBaseUrl = ensureTrailingSlash(trimmedBaseUrl);
	urls.add(new URL("models", normalizedBaseUrl).toString());

	const parsedBaseUrl = new URL(trimmedBaseUrl);
	const normalizedPath = parsedBaseUrl.pathname.replace(/\/+$/, "");
	if (!normalizedPath.endsWith("/v1")) {
		const withV1 = new URL(parsedBaseUrl.toString());
		withV1.pathname = normalizedPath.length > 0 ? `${normalizedPath}/v1/models` : "/v1/models";
		withV1.search = "";
		withV1.hash = "";
		urls.add(withV1.toString());
	}

	return [...urls];
}

export async function fetchOpenAiCompatibleModelsFromBaseUrl(input: {
	baseUrl: string;
	apiKey?: string | null;
	timeoutMs?: number;
}): Promise<RuntimeClineProviderModel[]> {
	const urls = buildModelDiscoveryUrls(input.baseUrl);
	if (urls.length === 0) {
		return [];
	}

	const headers = new Headers({
		Accept: "application/json",
	});
	const trimmedApiKey = input.apiKey?.trim() ?? "";
	if (trimmedApiKey.length > 0) {
		headers.set("Authorization", `Bearer ${trimmedApiKey}`);
	}

	let lastError: Error | null = null;
	for (const url of urls) {
		try {
			const response = await fetch(url, {
				method: "GET",
				headers,
				signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS),
			});
			if (!response.ok) {
				throw new Error(`Model discovery failed for ${url}: HTTP ${response.status}`);
			}

			const payload = (await response.json()) as unknown;
			const models = extractModelsFromPayload(payload);
			if (models.length > 0) {
				return models.sort((left, right) => left.name.localeCompare(right.name));
			}
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
	}

	if (lastError) {
		throw lastError;
	}
	return [];
}
