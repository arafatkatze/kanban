// Azure OpenAI request adapter.
//
// Azure OpenAI exposes a "chat completions" endpoint that is wire-compatible
// with OpenAI but diverges from the plain OpenAI API in two important ways:
//
// 1. Auth header — Azure uses `api-key: <key>` instead of
//    `Authorization: Bearer <key>`. Azure will return 401 if only the
//    `Authorization` header is present.
// 2. `api-version` — every Azure OpenAI request MUST include an
//    `api-version=<yyyy-mm-dd[-preview]>` query parameter in the URL.
//    Azure returns 404 ("Resource not found") if it is missing.
//
// The underlying `@ai-sdk/openai-compatible` provider that the Cline SDK
// reaches for when a user configures a generic OpenAI-compatible provider
// does neither of these things: it sends `Authorization: Bearer <key>` and
// leaves the URL's query string alone. That is why pointing Kanban at an
// Azure deployment base URL reproducibly fails with 404 / "stream ended
// without producing output" today.
//
// Rather than coerce the OpenAI-compatible adapter into understanding
// Azure, we wrap the Cline SDK's outbound `fetch` so Azure OpenAI hosts get
// first-class handling: URLs are rewritten to include a valid
// `api-version`, and the Bearer header is translated to `api-key` before
// the request leaves the process. Non-Azure URLs are passed through
// unchanged so the generic OpenAI path continues to work exactly as
// before.

// Keep in sync with the current Azure OpenAI GA api-version; users can
// still override via a per-provider header (see `extractApiVersion`).
export const DEFAULT_AZURE_OPENAI_API_VERSION = "2024-10-21";

const AZURE_OPENAI_HOST_SUFFIX = ".openai.azure.com";
const API_VERSION_QUERY_PARAM = "api-version";
const API_VERSION_HEADER = "api-version";
const API_KEY_HEADER = "api-key";
const AUTHORIZATION_HEADER = "authorization";
const BEARER_SCHEME = "bearer";

export interface AzureOpenAIFetchOptions {
	/** Fallback api-version used when neither the URL nor the request headers specify one. */
	defaultApiVersion?: string;
}

/**
 * Returns true when the given URL targets an Azure OpenAI resource
 * (`<resource>.openai.azure.com`). This is the one signal Azure gives us
 * at the HTTP layer; the deployment is encoded in the URL path and the
 * model id in the request body.
 */
export function isAzureOpenAIUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase();
		return host.endsWith(AZURE_OPENAI_HOST_SUFFIX);
	} catch {
		return false;
	}
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function coerceRequestUrl(input: FetchInput): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	const candidate = input as { url?: unknown };
	if (candidate && typeof candidate.url === "string") return candidate.url;
	return String(input);
}

function extractApiVersion(url: URL, headers: Headers): string | null {
	const fromUrl = url.searchParams.get(API_VERSION_QUERY_PARAM);
	if (fromUrl && fromUrl.trim().length > 0) return fromUrl;
	const fromHeader = headers.get(API_VERSION_HEADER);
	if (fromHeader && fromHeader.trim().length > 0) return fromHeader.trim();
	return null;
}

export interface RewrittenAzureRequest {
	url: string;
	headers: Headers;
	apiVersion: string;
}

/**
 * Pure, synchronous rewrite so it can be unit-tested without a fetch
 * round-trip. Callers pass the raw URL + headers as they would hand them
 * to `fetch`; we hand back a URL with `api-version` appended and headers
 * with Azure's auth scheme applied.
 */
export type AzureRewriteHeadersInput = Headers | Record<string, string> | Iterable<readonly [string, string]>;

export function rewriteAzureRequest(
	rawUrl: string,
	rawHeaders: AzureRewriteHeadersInput | undefined,
	options: AzureOpenAIFetchOptions = {},
): RewrittenAzureRequest {
	const parsedUrl = new URL(rawUrl);
	const headers = rawHeaders instanceof Headers ? new Headers(rawHeaders) : new Headers((rawHeaders ?? {}) as never);

	const resolvedApiVersion =
		extractApiVersion(parsedUrl, headers) ?? options.defaultApiVersion ?? DEFAULT_AZURE_OPENAI_API_VERSION;

	parsedUrl.searchParams.set(API_VERSION_QUERY_PARAM, resolvedApiVersion);

	// Azure expects the version in the query string only; strip any stray
	// `api-version` header so it does not leak into request bodies.
	headers.delete(API_VERSION_HEADER);

	// Translate Bearer auth -> Azure's `api-key` header. We keep any
	// user-supplied `api-key` header untouched so managed-identity /
	// pre-configured deployments keep working.
	const authorization = headers.get(AUTHORIZATION_HEADER);
	const existingApiKey = headers.get(API_KEY_HEADER);
	if (authorization && !existingApiKey) {
		const trimmed = authorization.trim();
		const lower = trimmed.toLowerCase();
		const isBearer = lower === BEARER_SCHEME || lower.startsWith(`${BEARER_SCHEME} `);
		const apiKey = isBearer ? trimmed.slice(BEARER_SCHEME.length).trim() : trimmed;
		if (apiKey.length > 0) {
			headers.set(API_KEY_HEADER, apiKey);
		}
	}
	if (headers.has(API_KEY_HEADER)) {
		headers.delete(AUTHORIZATION_HEADER);
	}

	return {
		url: parsedUrl.toString(),
		headers,
		apiVersion: resolvedApiVersion,
	};
}

/**
 * Wrap a `fetch` implementation so it speaks Azure OpenAI's dialect on
 * Azure hosts and behaves like plain `fetch` everywhere else.
 */
export function withAzureOpenAIFetch(
	baseFetch: typeof fetch = fetch,
	options: AzureOpenAIFetchOptions = {},
): typeof fetch {
	const wrapped: typeof fetch = async (input: FetchInput, init?: FetchInit) => {
		const rawUrl = coerceRequestUrl(input);
		if (!isAzureOpenAIUrl(rawUrl)) {
			return baseFetch(input, init);
		}

		const requestCandidate = input as { headers?: Headers | Record<string, string> };
		const sourceHeaders: AzureRewriteHeadersInput | undefined =
			(init?.headers as AzureRewriteHeadersInput | undefined) ??
			(requestCandidate && requestCandidate.headers instanceof Headers
				? new Headers(requestCandidate.headers)
				: undefined);
		const { url, headers } = rewriteAzureRequest(rawUrl, sourceHeaders, options);

		const nextInit = {
			...(init ?? {}),
			headers,
		} as FetchInit;
		return baseFetch(url, nextInit);
	};
	return wrapped;
}
