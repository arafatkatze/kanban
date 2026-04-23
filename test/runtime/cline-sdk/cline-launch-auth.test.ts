import { describe, expect, it } from "vitest";

import { isLocalBaseUrl, resolveClineLaunchApiKey } from "../../../src/cline-sdk/cline-launch-auth";

describe("resolveClineLaunchApiKey", () => {
	it("returns the user-supplied api key unchanged when present", () => {
		expect(resolveClineLaunchApiKey({ apiKey: "sk-abcdef", baseUrl: "https://api.openai.com/v1" })).toBe("sk-abcdef");
		expect(resolveClineLaunchApiKey({ apiKey: "sk-abcdef", baseUrl: "http://localhost:11435/v1" })).toBe("sk-abcdef");
	});

	it("trims surrounding whitespace on user-supplied keys", () => {
		expect(resolveClineLaunchApiKey({ apiKey: "  sk-trimmed  ", baseUrl: null })).toBe("sk-trimmed");
	});

	it("leaves apiKey undefined for blank keys against remote providers", () => {
		expect(resolveClineLaunchApiKey({ apiKey: "", baseUrl: "https://api.openai.com/v1" })).toBeUndefined();
		expect(resolveClineLaunchApiKey({ apiKey: "   ", baseUrl: "https://api.example.com/v1" })).toBeUndefined();
		expect(resolveClineLaunchApiKey({ apiKey: null, baseUrl: "https://api.openrouter.ai/api/v1" })).toBeUndefined();
	});

	it("supplies a local placeholder when the user leaves the key blank and baseUrl is loopback", () => {
		const localUrls = [
			"http://localhost:11435/v1",
			"http://127.0.0.1:1234/v1",
			"http://0.0.0.0:8080/v1",
			"http://[::1]:8000/v1",
			"http://anything.localhost:3000/",
			"http://localhost/v1",
		];
		for (const baseUrl of localUrls) {
			const resolved = resolveClineLaunchApiKey({ apiKey: "", baseUrl });
			expect(resolved, `expected placeholder for ${baseUrl}`).toBeTypeOf("string");
			expect(resolved).not.toEqual("");
		}
	});

	it("leaves apiKey undefined when baseUrl is missing or unparsable", () => {
		expect(resolveClineLaunchApiKey({ apiKey: "", baseUrl: null })).toBeUndefined();
		expect(resolveClineLaunchApiKey({ apiKey: "", baseUrl: undefined })).toBeUndefined();
		expect(resolveClineLaunchApiKey({ apiKey: "", baseUrl: "not a url" })).toBeUndefined();
	});
});

describe("isLocalBaseUrl", () => {
	it("recognizes common loopback hostnames", () => {
		expect(isLocalBaseUrl("http://localhost:11435/v1")).toBe(true);
		expect(isLocalBaseUrl("http://127.0.0.1:1234/v1")).toBe(true);
		expect(isLocalBaseUrl("http://0.0.0.0:8080/v1")).toBe(true);
		expect(isLocalBaseUrl("http://[::1]:8000/v1")).toBe(true);
		expect(isLocalBaseUrl("http://foo.localhost/v1")).toBe(true);
	});

	it("rejects remote URLs", () => {
		expect(isLocalBaseUrl("https://api.openai.com/v1")).toBe(false);
		expect(isLocalBaseUrl("https://openrouter.ai/api/v1")).toBe(false);
		expect(isLocalBaseUrl("https://models.mlx.example/v1")).toBe(false);
	});

	it("rejects empty or invalid URLs", () => {
		expect(isLocalBaseUrl("")).toBe(false);
		expect(isLocalBaseUrl(null)).toBe(false);
		expect(isLocalBaseUrl(undefined)).toBe(false);
		expect(isLocalBaseUrl("not a url")).toBe(false);
	});
});
