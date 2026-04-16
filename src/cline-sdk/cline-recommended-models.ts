import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { getSdkProviderSettingsDirectory } from "./sdk-provider-boundary";

const CLINE_RECOMMENDED_MODELS_CACHE_FILE = "cline-recommended-models.json";
const CLINE_RECOMMENDED_MODELS_CACHE_TTL_MS = 60 * 60 * 1000;

const recommendedModelSchema = z.object({
	id: z.string().trim().min(1),
	name: z.string().optional(),
	description: z.string().optional(),
	tags: z.array(z.string()).optional(),
});

const recommendedModelsSchema = z.object({
	recommended: z.array(recommendedModelSchema).default([]),
	free: z.array(recommendedModelSchema).default([]),
});

type RecommendedModelsData = z.infer<typeof recommendedModelsSchema>;

const CLINE_RECOMMENDED_MODEL_IDS_FALLBACK = [
	"google/gemini-3.1-pro-preview",
	"anthropic/claude-sonnet-4.6",
	"anthropic/claude-opus-4.6",
	"openai/gpt-5.3-codex",
] as const;

let inMemoryCache: { apiBaseUrl: string; ids: string[]; timestamp: number } | null = null;
let pendingRefresh: Promise<string[]> | null = null;

function normalizeRecommendedModelIds(input: RecommendedModelsData): string[] {
	return [...new Set(input.recommended.map((model) => model.id.trim()).filter((id) => id.length > 0))];
}

function resolveCacheFilePath(): string {
	return join(getSdkProviderSettingsDirectory(), CLINE_RECOMMENDED_MODELS_CACHE_FILE);
}

function getFallbackRecommendedModelIds(): string[] {
	return [...CLINE_RECOMMENDED_MODEL_IDS_FALLBACK];
}

async function readCachedRecommendedModelIds(): Promise<string[] | null> {
	try {
		const raw = await readFile(resolveCacheFilePath(), "utf8");
		const parsed = recommendedModelsSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) {
			return null;
		}
		const ids = normalizeRecommendedModelIds(parsed.data);
		return ids.length > 0 ? ids : null;
	} catch {
		return null;
	}
}

async function writeCachedRecommendedModels(data: RecommendedModelsData): Promise<void> {
	await mkdir(getSdkProviderSettingsDirectory(), { recursive: true });
	await writeFile(resolveCacheFilePath(), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function fetchAndCacheRecommendedModelIds(apiBaseUrl: string): Promise<string[]> {
	try {
		const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/v1/ai/cline/recommended-models`);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}

		const parsed = recommendedModelsSchema.safeParse(await response.json());
		if (!parsed.success) {
			throw new Error("Invalid response body");
		}

		const ids = normalizeRecommendedModelIds(parsed.data);
		if (ids.length > 0) {
			await writeCachedRecommendedModels(parsed.data);
			return ids;
		}
	} catch {
		const cachedIds = await readCachedRecommendedModelIds();
		if (cachedIds && cachedIds.length > 0) {
			return cachedIds;
		}
	}

	return getFallbackRecommendedModelIds();
}

export async function fetchClineRecommendedModelIds(apiBaseUrl: string): Promise<string[]> {
	if (
		inMemoryCache &&
		inMemoryCache.apiBaseUrl === apiBaseUrl &&
		Date.now() - inMemoryCache.timestamp <= CLINE_RECOMMENDED_MODELS_CACHE_TTL_MS
	) {
		return inMemoryCache.ids;
	}

	if (pendingRefresh) {
		return pendingRefresh;
	}

	pendingRefresh = (async () => {
		try {
			const ids = await fetchAndCacheRecommendedModelIds(apiBaseUrl);
			if (ids.length > 0) {
				inMemoryCache = {
					apiBaseUrl,
					ids,
					timestamp: Date.now(),
				};
			}
			return ids;
		} finally {
			pendingRefresh = null;
		}
	})();

	return pendingRefresh;
}

export function resetClineRecommendedModelsCacheForTests(): void {
	inMemoryCache = null;
	pendingRefresh = null;
}
