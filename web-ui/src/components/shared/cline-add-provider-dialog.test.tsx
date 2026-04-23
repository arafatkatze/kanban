import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClineAddProviderDialog } from "@/components/shared/cline-add-provider-dialog";

function findButtonByText(container: ParentNode, text: string): HTMLButtonElement | null {
	return (Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === text) ??
		null) as HTMLButtonElement | null;
}

function setInputValue(input: HTMLInputElement, value: string): void {
	const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
	descriptor?.set?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ClineAddProviderDialog", () => {
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

	it("enables save when the user types a model without pressing Enter", async () => {
		const onSubmit = vi.fn(async () => ({ ok: true }));

		await act(async () => {
			root.render(
				<ClineAddProviderDialog open={true} onOpenChange={() => {}} existingProviderIds={[]} onSubmit={onSubmit} />,
			);
		});

		const inputs = Array.from(document.body.querySelectorAll("input"));
		const providerIdInput = inputs.find((input) => input.placeholder === "my-provider") as
			| HTMLInputElement
			| undefined;
		const providerNameInput = inputs.find((input) => input.placeholder === "My Provider") as
			| HTMLInputElement
			| undefined;
		const baseUrlInput = inputs.find((input) => input.placeholder === "https://api.example.com/v1") as
			| HTMLInputElement
			| undefined;
		const modelInput = inputs.find((input) => input.placeholder === "Type a model ID and press Enter") as
			| HTMLInputElement
			| undefined;
		const saveButton = findButtonByText(document.body, "Add provider");

		expect(providerIdInput).toBeDefined();
		expect(providerNameInput).toBeDefined();
		expect(baseUrlInput).toBeDefined();
		expect(modelInput).toBeDefined();
		expect(saveButton).toBeInstanceOf(HTMLButtonElement);
		expect(saveButton?.disabled).toBe(true);

		await act(async () => {
			if (!providerIdInput || !providerNameInput || !baseUrlInput || !modelInput) {
				return;
			}
			setInputValue(providerIdInput, "my-provider");
			setInputValue(providerNameInput, "My Provider");
			setInputValue(baseUrlInput, "http://localhost:8000/v1");
			setInputValue(modelInput, "qwen2.5-coder:32b");
		});

		expect(saveButton?.disabled).toBe(false);

		await act(async () => {
			saveButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			saveButton?.click();
		});

		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: "my-provider",
				name: "My Provider",
				baseUrl: "http://localhost:8000/v1",
				models: ["qwen2.5-coder:32b"],
				defaultModelId: "qwen2.5-coder:32b",
			}),
		);
	});

	it("keeps the header key input focused while typing", async () => {
		await act(async () => {
			root.render(
				<ClineAddProviderDialog
					open={true}
					onOpenChange={() => {}}
					existingProviderIds={[]}
					onSubmit={async () => ({ ok: true })}
				/>,
			);
		});

		const addHeaderButton = findButtonByText(document.body, "Add");
		expect(addHeaderButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			addHeaderButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			addHeaderButton?.click();
		});

		const headerKeyInput = Array.from(document.body.querySelectorAll("input")).find(
			(input) => input.placeholder === "Header name",
		) as HTMLInputElement | undefined;
		expect(headerKeyInput).toBeDefined();

		headerKeyInput?.focus();

		await act(async () => {
			if (!headerKeyInput) {
				return;
			}
			setInputValue(headerKeyInput, "Authorization");
		});

		expect(document.activeElement).toBe(headerKeyInput);
		expect(headerKeyInput?.value).toBe("Authorization");
	});

	it("updates capability toggle state and submits the selected capabilities", async () => {
		const onSubmit = vi.fn(async () => ({ ok: true }));

		await act(async () => {
			root.render(
				<ClineAddProviderDialog open={true} onOpenChange={() => {}} existingProviderIds={[]} onSubmit={onSubmit} />,
			);
		});

		const visionButton = findButtonByText(document.body, "vision");
		const streamingButton = findButtonByText(document.body, "streaming");
		expect(visionButton?.getAttribute("aria-pressed")).toBe("false");
		expect(streamingButton?.getAttribute("aria-pressed")).toBe("true");

		await act(async () => {
			visionButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			visionButton?.click();
			streamingButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			streamingButton?.click();
		});

		expect(visionButton?.getAttribute("aria-pressed")).toBe("true");
		expect(streamingButton?.getAttribute("aria-pressed")).toBe("false");

		const inputs = Array.from(document.body.querySelectorAll("input"));
		const providerIdInput = inputs.find((input) => input.placeholder === "my-provider") as
			| HTMLInputElement
			| undefined;
		const providerNameInput = inputs.find((input) => input.placeholder === "My Provider") as
			| HTMLInputElement
			| undefined;
		const baseUrlInput = inputs.find((input) => input.placeholder === "https://api.example.com/v1") as
			| HTMLInputElement
			| undefined;
		const modelInput = inputs.find((input) => input.placeholder === "Type a model ID and press Enter") as
			| HTMLInputElement
			| undefined;
		const saveButton = findButtonByText(document.body, "Add provider");

		await act(async () => {
			if (!providerIdInput || !providerNameInput || !baseUrlInput || !modelInput) {
				return;
			}
			setInputValue(providerIdInput, "my-provider");
			setInputValue(providerNameInput, "My Provider");
			setInputValue(baseUrlInput, "http://localhost:8000/v1");
			setInputValue(modelInput, "qwen2.5-coder:32b");
		});

		await act(async () => {
			saveButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			saveButton?.click();
		});

		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				capabilities: ["tools", "vision"],
			}),
		);
	});

	// Regression for issue #293: editing a built-in provider from the Cline
	// settings Edit dialog must only submit the editable subset (apiKey,
	// baseUrl, headers, timeoutMs, defaultModelId). Fields owned by the SDK
	// catalog (name, models, capabilities, modelsSourceUrl) must not be sent —
	// those would otherwise drive the backend into the SDK's updateLocalProvider
	// path, which throws `provider "<id>" does not exist` for built-ins.
	it("submits only the editable subset when editing a built-in provider", async () => {
		const onSubmit = vi.fn(async () => ({ ok: true }));

		await act(async () => {
			root.render(
				<ClineAddProviderDialog
					open={true}
					onOpenChange={() => {}}
					existingProviderIds={["ollama"]}
					mode="edit"
					isBuiltInProvider={true}
					initialValues={{
						providerId: "ollama",
						name: "Ollama",
						baseUrl: "http://localhost:11434",
						models: ["llama3.1"],
						defaultModelId: "llama3.1",
					}}
					onSubmit={onSubmit}
				/>,
			);
		});

		// The title should read "Edit provider" (no "OpenAI-compatible" suffix
		// for built-ins) so users don't get confused when editing ollama etc.
		expect(document.body.textContent).toContain("Edit provider");
		expect(document.body.textContent).not.toContain("Edit OpenAI-compatible provider");
		expect(document.body.textContent).toContain("This is a built-in provider");

		// SDK-owned fields are disabled so the user cannot edit them.
		const inputs = Array.from(document.body.querySelectorAll("input"));
		const providerNameInput = inputs.find((input) => input.placeholder === "My Provider") as
			| HTMLInputElement
			| undefined;
		const modelsSourceUrlInput = inputs.find((input) => input.placeholder === "https://api.example.com/v1/models") as
			| HTMLInputElement
			| undefined;
		expect(providerNameInput?.disabled).toBe(true);
		expect(modelsSourceUrlInput?.disabled).toBe(true);

		const visionButton = findButtonByText(document.body, "vision");
		expect(visionButton?.disabled).toBe(true);

		// There must be no free-form model-chip input — the built-in's list is
		// owned by the SDK catalog.
		const modelInput = inputs.find((input) => input.placeholder === "Type a model ID and press Enter");
		expect(modelInput).toBeUndefined();

		// User changes the base URL and API key.
		const baseUrlInput = inputs.find((input) => input.placeholder === "https://api.example.com/v1") as
			| HTMLInputElement
			| undefined;
		const apiKeyInput = inputs.find((input) => input.placeholder === "Optional") as HTMLInputElement | undefined;
		expect(baseUrlInput).toBeDefined();
		expect(apiKeyInput).toBeDefined();

		await act(async () => {
			if (!baseUrlInput || !apiKeyInput) {
				return;
			}
			setInputValue(baseUrlInput, "http://localhost:11500");
			setInputValue(apiKeyInput, "new-ollama-token");
		});

		const saveButton = findButtonByText(document.body, "Update provider");
		expect(saveButton).toBeInstanceOf(HTMLButtonElement);
		expect(saveButton?.disabled).toBe(false);

		await act(async () => {
			saveButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			saveButton?.click();
		});

		expect(onSubmit).toHaveBeenCalledTimes(1);
		const payload = onSubmit.mock.calls[0][0] as Record<string, unknown>;
		expect(payload).toEqual({
			providerId: "ollama",
			baseUrl: "http://localhost:11500",
			apiKey: "new-ollama-token",
		});
		// Explicitly assert none of the SDK-owned fields leak into the payload.
		expect(payload).not.toHaveProperty("name");
		expect(payload).not.toHaveProperty("models");
		expect(payload).not.toHaveProperty("modelsSourceUrl");
		expect(payload).not.toHaveProperty("capabilities");
	});
});
