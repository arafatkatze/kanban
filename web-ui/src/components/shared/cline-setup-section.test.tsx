import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClineSetupSection } from "@/components/shared/cline-setup-section";
import type { UseRuntimeSettingsClineControllerResult } from "@/hooks/use-runtime-settings-cline-controller";
import type { RuntimeClineProviderCatalogItem } from "@/runtime/types";

vi.mock("@/runtime/runtime-config-query", () => ({
	openFileOnHost: vi.fn(),
}));

function findButtonByText(container: ParentNode, text: string): HTMLButtonElement | null {
	return (Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === text) ??
		null) as HTMLButtonElement | null;
}

function createProvider(overrides: Partial<RuntimeClineProviderCatalogItem> = {}): RuntimeClineProviderCatalogItem {
	return {
		id: "litellm",
		name: "LiteLLM",
		oauthSupported: false,
		enabled: true,
		defaultModelId: "gpt-5.4",
		baseUrl: "http://localhost:4000/v1",
		supportsBaseUrl: true,
		...overrides,
	};
}

function createController(provider: RuntimeClineProviderCatalogItem): UseRuntimeSettingsClineControllerResult {
	const providerId = provider.id;
	return {
		currentProviderSettings: {
			providerId,
			modelId: provider.defaultModelId,
			baseUrl: provider.baseUrl,
			reasoningEffort: null,
			apiKeyConfigured: false,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		},
		providerId,
		setProviderId: vi.fn(),
		modelId: provider.defaultModelId ?? "",
		setModelId: vi.fn(),
		apiKey: "",
		setApiKey: vi.fn(),
		baseUrl: provider.baseUrl ?? "",
		setBaseUrl: vi.fn(),
		region: "",
		setRegion: vi.fn(),
		reasoningEffort: "",
		setReasoningEffort: vi.fn(),
		awsAccessKey: "",
		setAwsAccessKey: vi.fn(),
		awsSecretKey: "",
		setAwsSecretKey: vi.fn(),
		awsSessionToken: "",
		setAwsSessionToken: vi.fn(),
		awsRegion: "",
		setAwsRegion: vi.fn(),
		awsProfile: "",
		setAwsProfile: vi.fn(),
		awsAuthentication: "",
		setAwsAuthentication: vi.fn(),
		awsEndpoint: "",
		setAwsEndpoint: vi.fn(),
		gcpProjectId: "",
		setGcpProjectId: vi.fn(),
		gcpRegion: "",
		setGcpRegion: vi.fn(),
		providerCatalog: [provider],
		providerModels: [{ id: provider.defaultModelId ?? "gpt-5.4", name: provider.defaultModelId ?? "gpt-5.4" }],
		isLoadingProviderCatalog: false,
		isLoadingProviderModels: false,
		isRunningOauthLogin: false,
		deviceAuthInfo: null,
		normalizedProviderId: providerId,
		managedOauthProvider: null,
		isOauthProviderSelected: false,
		apiKeyConfigured: false,
		oauthConfigured: false,
		oauthAccountId: "",
		oauthExpiresAt: "",
		selectedModelSupportsReasoningEffort: false,
		hasUnsavedChanges: false,
		saveProviderSettings: vi.fn(async () => ({ ok: true })),
		addCustomProvider: vi.fn(async () => ({ ok: true })),
		updateCustomProvider: vi.fn(async () => ({ ok: true })),
		runOauthLogin: vi.fn(async () => ({ ok: true })),
	};
}

describe("ClineSetupSection", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		document.body.innerHTML = "";
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("does not show custom-provider edit controls for built-in providers", async () => {
		await act(async () => {
			root.render(
				<ClineSetupSection
					controller={createController(createProvider({ custom: false }))}
					controlsDisabled={false}
					showMcpSettings={false}
				/>,
			);
		});

		expect(findButtonByText(document.body, "Edit")).toBeNull();
	});

	it("shows custom-provider edit controls for local custom providers", async () => {
		await act(async () => {
			root.render(
				<ClineSetupSection
					controller={createController(createProvider({ id: "my-provider", name: "My Provider", custom: true }))}
					controlsDisabled={false}
					showMcpSettings={false}
				/>,
			);
		});

		expect(findButtonByText(document.body, "Edit")).toBeInstanceOf(HTMLButtonElement);
	});
});
