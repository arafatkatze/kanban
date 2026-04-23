import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_AZURE_OPENAI_API_VERSION,
	isAzureOpenAIUrl,
	rewriteAzureRequest,
	withAzureOpenAIFetch,
} from "../../../src/cline-sdk/azure-openai-fetch";

describe("isAzureOpenAIUrl", () => {
	it("matches Azure OpenAI resource hosts", () => {
		expect(isAzureOpenAIUrl("https://contoso.openai.azure.com/openai/deployments/foo/chat/completions")).toBe(true);
		expect(isAzureOpenAIUrl("https://CONTOSO.OPENAI.AZURE.COM/openai/deployments/foo/chat/completions")).toBe(true);
	});

	it("does not match non-Azure hosts", () => {
		expect(isAzureOpenAIUrl("https://api.openai.com/v1/chat/completions")).toBe(false);
		expect(isAzureOpenAIUrl("https://openrouter.ai/api/v1/chat/completions")).toBe(false);
		expect(isAzureOpenAIUrl("http://localhost:11434/v1/chat/completions")).toBe(false);
	});

	it("ignores malformed URLs", () => {
		expect(isAzureOpenAIUrl("not-a-url")).toBe(false);
	});
});

describe("rewriteAzureRequest", () => {
	const BASE = "https://contoso.openai.azure.com/openai/deployments/gpt-5.2/chat/completions";

	it("appends the default api-version when neither URL nor headers specify one", () => {
		const { url, headers, apiVersion } = rewriteAzureRequest(BASE, {
			authorization: "Bearer sk-test",
			"content-type": "application/json",
		});
		const parsed = new URL(url);
		expect(parsed.searchParams.get("api-version")).toBe(DEFAULT_AZURE_OPENAI_API_VERSION);
		expect(apiVersion).toBe(DEFAULT_AZURE_OPENAI_API_VERSION);
		expect(headers.get("api-key")).toBe("sk-test");
		expect(headers.get("authorization")).toBeNull();
		expect(headers.get("content-type")).toBe("application/json");
	});

	it("honors an api-version already present on the URL", () => {
		const { url, apiVersion } = rewriteAzureRequest(`${BASE}?api-version=2025-01-01-preview`, {
			authorization: "Bearer sk-test",
		});
		expect(apiVersion).toBe("2025-01-01-preview");
		expect(new URL(url).searchParams.get("api-version")).toBe("2025-01-01-preview");
	});

	it("promotes an api-version header to the query string and strips the header", () => {
		const { url, headers, apiVersion } = rewriteAzureRequest(BASE, {
			authorization: "Bearer sk-test",
			"api-version": "2024-06-01",
		});
		expect(apiVersion).toBe("2024-06-01");
		expect(new URL(url).searchParams.get("api-version")).toBe("2024-06-01");
		expect(headers.get("api-version")).toBeNull();
	});

	it("lets callers override the default api-version", () => {
		const { apiVersion } = rewriteAzureRequest(
			BASE,
			{ authorization: "Bearer sk-test" },
			{ defaultApiVersion: "2025-03-01-preview" },
		);
		expect(apiVersion).toBe("2025-03-01-preview");
	});

	it("preserves a pre-existing api-key header and drops Authorization", () => {
		const { headers } = rewriteAzureRequest(BASE, {
			authorization: "Bearer ignored",
			"api-key": "primary-key",
		});
		expect(headers.get("api-key")).toBe("primary-key");
		expect(headers.get("authorization")).toBeNull();
	});

	it("translates non-Bearer Authorization values verbatim into api-key", () => {
		const { headers } = rewriteAzureRequest(BASE, { authorization: "raw-key" });
		expect(headers.get("api-key")).toBe("raw-key");
		expect(headers.get("authorization")).toBeNull();
	});

	it("does not create an empty api-key when the Bearer value is empty", () => {
		// `new Headers({ authorization: "Bearer " })` normalizes the trailing
		// whitespace away, so the realistic way to exercise the empty case is
		// to bypass the Headers constructor by passing a Headers instance.
		const source = new Headers();
		source.append("authorization", "Bearer     ");
		const { headers } = rewriteAzureRequest(BASE, source);
		expect(headers.get("api-key")).toBeNull();
	});
});

describe("withAzureOpenAIFetch", () => {
	it("rewrites Azure requests and leaves others untouched", async () => {
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		const mockFetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const url = typeof input === "string" ? input : (input as URL | Request).toString();
			const headerPairs = new Headers(init?.headers ?? undefined);
			const headersObj: Record<string, string> = {};
			headerPairs.forEach((value, key) => {
				headersObj[key] = value;
			});
			calls.push({ url, headers: headersObj });
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;

		const wrapped = withAzureOpenAIFetch(mockFetch);

		await wrapped("https://contoso.openai.azure.com/openai/deployments/gpt-5.2/chat/completions", {
			method: "POST",
			headers: {
				authorization: "Bearer sk-azure",
				"content-type": "application/json",
			},
			body: "{}",
		});

		await wrapped("https://api.openai.com/v1/chat/completions", {
			method: "POST",
			headers: {
				authorization: "Bearer sk-openai",
				"content-type": "application/json",
			},
			body: "{}",
		});

		expect(calls).toHaveLength(2);

		const azureCall = calls[0];
		if (!azureCall) throw new Error("missing azure call");
		const azureUrl = new URL(azureCall.url);
		expect(azureUrl.hostname).toBe("contoso.openai.azure.com");
		expect(azureUrl.pathname).toBe("/openai/deployments/gpt-5.2/chat/completions");
		expect(azureUrl.searchParams.get("api-version")).toBe(DEFAULT_AZURE_OPENAI_API_VERSION);
		expect(azureCall.headers["api-key"]).toBe("sk-azure");
		expect(azureCall.headers.authorization).toBeUndefined();

		const openaiCall = calls[1];
		if (!openaiCall) throw new Error("missing openai call");
		expect(openaiCall.url).toBe("https://api.openai.com/v1/chat/completions");
		expect(openaiCall.headers.authorization).toBe("Bearer sk-openai");
		expect(openaiCall.headers["api-key"]).toBeUndefined();
	});
});
