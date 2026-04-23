// Regression tests for issue #293 — "provider does not exist" when editing
// a built-in provider from the Cline settings dialog. The Edit pencil in
// ClineSetupSection triggers runtime.updateClineProvider, which delegates to
// clineProviderService.updateCustomProvider. Before the fix, this call
// always hit the SDK's updateLocalProvider, which only knows about custom
// providers stored in the local models.json. For built-ins (ollama, openai,
// openrouter, ...) it threw `provider "<id>" does not exist`.
//
// These tests lock in the new branching:
//   - Custom provider (present in models.json)   → SDK updateLocalProvider.
//   - Built-in provider (absent in models.json)  → saveSdkProviderSettings
//     with only the editable subset (apiKey, baseUrl, headers, timeout,
//     defaultModelId -> settings.model). SDK-owned fields from the input
//     (name, models, modelsSourceUrl, capabilities) are silently ignored.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const oauthMocks = vi.hoisted(() => ({
	saveProviderSettings: vi.fn(),
	getProviderSettings: vi.fn(),
	getLastUsedProviderSettings: vi.fn(),
	providerSettingsFilePath: "",
	providerSettingsState: {
		providers: {} as Record<string, unknown>,
		lastUsedProvider: undefined as string | undefined,
	},
}));

const sdkMocks = vi.hoisted(() => ({
	addLocalProvider: vi.fn(),
	updateLocalProvider: vi.fn(),
	ensureCustomProvidersLoaded: vi.fn(),
}));

const llmsModelMocks = vi.hoisted(() => ({
	getAllProviders: vi.fn(),
	getModelsForProvider: vi.fn(),
	unregisterProvider: vi.fn(),
}));

const localProviderMocks = vi.hoisted(() => ({
	getLocalProviderModels: vi.fn(),
}));

vi.mock("@clinebot/core", () => ({
	addLocalProvider: sdkMocks.addLocalProvider,
	updateLocalProvider: sdkMocks.updateLocalProvider,
	ensureCustomProvidersLoaded: sdkMocks.ensureCustomProvidersLoaded,
	getLocalProviderModels: localProviderMocks.getLocalProviderModels,
	getValidClineCredentials: vi.fn(),
	getValidOcaCredentials: vi.fn(),
	getValidOpenAICodexCredentials: vi.fn(),
	loginClineOAuth: vi.fn(),
	loginOcaOAuth: vi.fn(),
	loginOpenAICodex: vi.fn(),
	resolveDefaultMcpSettingsPath: vi.fn(),
	loadMcpSettingsFile: vi.fn(),
	ClineAccountService: class {},
	ProviderSettingsManager: class {
		saveProviderSettings = oauthMocks.saveProviderSettings;
		getProviderSettings = oauthMocks.getProviderSettings;
		getLastUsedProviderSettings = oauthMocks.getLastUsedProviderSettings;
		getProviderConfig = vi.fn();
		getFilePath = vi.fn(() => oauthMocks.providerSettingsFilePath);
		read = vi.fn(() => oauthMocks.providerSettingsState);
		write = vi.fn((next: typeof oauthMocks.providerSettingsState) => {
			oauthMocks.providerSettingsState = next;
		});
	},
	Llms: {
		getAllProviders: llmsModelMocks.getAllProviders,
		getModelsForProvider: llmsModelMocks.getModelsForProvider,
		unregisterProvider: llmsModelMocks.unregisterProvider,
	},
	InMemoryMcpManager: class {},
	createMcpTools: vi.fn(async () => []),
	DEFAULT_EXTERNAL_IDCS_CLIENT_ID: "",
	DEFAULT_EXTERNAL_IDCS_SCOPES: "",
	DEFAULT_EXTERNAL_IDCS_URL: "",
	DEFAULT_INTERNAL_IDCS_CLIENT_ID: "",
	DEFAULT_INTERNAL_IDCS_SCOPES: "",
	DEFAULT_INTERNAL_IDCS_URL: "",
}));

vi.mock("../../../src/server/browser.js", () => ({
	openInBrowser: vi.fn(),
}));

import { createClineProviderService } from "../../../src/cline-sdk/cline-provider-service";

let tempDir: string;

function writeModelsRegistry(providers: Record<string, unknown>): void {
	const modelsPath = join(dirname(oauthMocks.providerSettingsFilePath), "models.json");
	mkdirSync(dirname(modelsPath), { recursive: true });
	writeFileSync(modelsPath, JSON.stringify({ version: 1, providers }, null, 2), "utf8");
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "kanban-provider-service-test-"));
	oauthMocks.providerSettingsFilePath = join(tempDir, "providers.json");
	oauthMocks.providerSettingsState = { providers: {}, lastUsedProvider: undefined };
	mkdirSync(tempDir, { recursive: true });

	oauthMocks.saveProviderSettings.mockReset();
	oauthMocks.getProviderSettings.mockReset();
	oauthMocks.getLastUsedProviderSettings.mockReset();
	sdkMocks.addLocalProvider.mockReset();
	sdkMocks.updateLocalProvider.mockReset();
	sdkMocks.ensureCustomProvidersLoaded.mockReset();
	llmsModelMocks.getAllProviders.mockReset();
	llmsModelMocks.getModelsForProvider.mockReset();
	llmsModelMocks.unregisterProvider.mockReset();

	oauthMocks.getLastUsedProviderSettings.mockReturnValue(undefined);
	oauthMocks.getProviderSettings.mockReturnValue(undefined);
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe("clineProviderService.updateCustomProvider", () => {
	it("persists the editable subset via saveSdkProviderSettings for a built-in provider (regression for #293)", async () => {
		// Pre-populate: user added a different custom provider, so the local
		// models.json exists and contains "my-openai" but NOT "ollama".
		writeModelsRegistry({
			"my-openai": {
				provider: {
					name: "My OpenAI",
					baseUrl: "https://api.openai.com/v1",
					defaultModelId: "gpt-4o-mini",
				},
				models: {
					"gpt-4o-mini": { id: "gpt-4o-mini", name: "gpt-4o-mini" },
				},
			},
		});

		// Existing persisted settings for ollama so we merge into them.
		oauthMocks.getProviderSettings.mockImplementation((providerId: string) =>
			providerId === "ollama"
				? { provider: "ollama", baseUrl: "http://localhost:11434", model: "llama3.1" }
				: undefined,
		);
		// Not the last-used provider — keep setLastUsed false in this scenario.
		oauthMocks.getLastUsedProviderSettings.mockReturnValue({ provider: "my-openai" });

		const service = createClineProviderService();
		const summary = await service.updateCustomProvider({
			providerId: "ollama",
			// UI includes these from the pre-populated initial values, but they
			// must be ignored for built-ins.
			name: "Ollama",
			models: ["llama3.1"],
			capabilities: ["streaming"],
			modelsSourceUrl: null,
			// Editable subset — these must be persisted.
			baseUrl: "http://localhost:11500",
			apiKey: "new-ollama-token",
			timeoutMs: 45000,
			defaultModelId: "llama3.2",
		});

		// The SDK's updateLocalProvider path MUST NOT be taken — that was the
		// root cause of issue #293 (it throws for built-ins).
		expect(sdkMocks.updateLocalProvider).not.toHaveBeenCalled();

		// Instead we persist via saveProviderSettings with the editable subset.
		expect(oauthMocks.saveProviderSettings).toHaveBeenCalledTimes(1);
		const [savedSettings, saveOptions] = oauthMocks.saveProviderSettings.mock.calls[0] as [
			Record<string, unknown>,
			Record<string, unknown>,
		];
		expect(savedSettings).toEqual(
			expect.objectContaining({
				provider: "ollama",
				baseUrl: "http://localhost:11500",
				apiKey: "new-ollama-token",
				timeout: 45000,
				model: "llama3.2",
			}),
		);
		// Built-in + oauth-less => tokenSource: manual. Not last-used here.
		expect(saveOptions).toMatchObject({ tokenSource: "manual", setLastUsed: false });

		// After save we re-read the persisted settings for the returned summary.
		oauthMocks.getProviderSettings.mockImplementation((providerId: string) =>
			providerId === "ollama" ? (savedSettings as unknown) : undefined,
		);
		expect(summary.providerId).toBe("ollama");
	});

	it("continues to route user-added custom providers through the SDK updateLocalProvider path", async () => {
		writeModelsRegistry({
			"my-openai": {
				provider: {
					name: "My OpenAI",
					baseUrl: "https://api.openai.com/v1",
					defaultModelId: "gpt-4o-mini",
				},
				models: {
					"gpt-4o-mini": { id: "gpt-4o-mini", name: "gpt-4o-mini" },
				},
			},
		});
		sdkMocks.updateLocalProvider.mockResolvedValue({
			providerId: "my-openai",
			settingsPath: oauthMocks.providerSettingsFilePath,
			modelsPath: join(dirname(oauthMocks.providerSettingsFilePath), "models.json"),
			modelsCount: 2,
		});
		oauthMocks.getProviderSettings.mockImplementation((providerId: string) =>
			providerId === "my-openai"
				? {
						provider: "my-openai",
						baseUrl: "https://api.openai.com/v1",
						model: "gpt-4o-mini",
						apiKey: "sk-existing",
					}
				: undefined,
		);
		oauthMocks.getLastUsedProviderSettings.mockReturnValue({ provider: "my-openai" });

		const service = createClineProviderService();
		await service.updateCustomProvider({
			providerId: "my-openai",
			baseUrl: "https://api.openai.com/v1",
			models: ["gpt-4o-mini", "gpt-4o"],
			defaultModelId: "gpt-4o",
		});

		expect(sdkMocks.updateLocalProvider).toHaveBeenCalledTimes(1);
		expect(sdkMocks.updateLocalProvider).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({
				providerId: "my-openai",
				baseUrl: "https://api.openai.com/v1",
				models: ["gpt-4o-mini", "gpt-4o"],
				defaultModelId: "gpt-4o",
			}),
		);
		expect(oauthMocks.saveProviderSettings).toHaveBeenCalledTimes(1);
		expect(oauthMocks.saveProviderSettings).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "my-openai" }),
			expect.objectContaining({ setLastUsed: true }),
		);
	});
});

describe("clineProviderService.getProviderCatalog", () => {
	it("marks catalog entries with isCustom true for providers present in the local models.json", async () => {
		writeModelsRegistry({
			"my-openai": {
				provider: {
					name: "My OpenAI",
					baseUrl: "https://api.openai.com/v1",
					defaultModelId: "gpt-4o-mini",
				},
				models: {
					"gpt-4o-mini": { id: "gpt-4o-mini", name: "gpt-4o-mini" },
				},
			},
		});
		llmsModelMocks.getAllProviders.mockResolvedValue([
			{ id: "cline", name: "Cline", defaultModelId: "claude-sonnet-4-6", capabilities: ["oauth"] },
			{ id: "ollama", name: "Ollama", defaultModelId: "llama3.1", baseUrl: "http://localhost:11434" },
			{ id: "my-openai", name: "My OpenAI", defaultModelId: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1" },
		]);

		const service = createClineProviderService();
		const response = await service.getProviderCatalog();
		const byId = Object.fromEntries(response.providers.map((provider) => [provider.id, provider]));
		expect(byId["cline"]?.isCustom).toBe(false);
		expect(byId["ollama"]?.isCustom).toBe(false);
		expect(byId["my-openai"]?.isCustom).toBe(true);
	});
});
