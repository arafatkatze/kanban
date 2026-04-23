import { describe, expect, it } from "vitest";

import {
	assertSupportedNodeVersion,
	compareSemver,
	formatSemver,
	formatUnsupportedNodeErrorMessage,
	isNodeVersionSupported,
	MIN_NODE_VERSION,
	parseNodeVersion,
	UnsupportedNodeVersionError,
} from "../../src/core/node-version";

describe("parseNodeVersion", () => {
	it("parses a canonical Node version", () => {
		expect(parseNodeVersion("v22.5.0")).toEqual({ major: 22, minor: 5, patch: 0 });
	});

	it("parses a version without the leading v", () => {
		expect(parseNodeVersion("22.5.1")).toEqual({ major: 22, minor: 5, patch: 1 });
	});

	it("strips pre-release and build metadata", () => {
		expect(parseNodeVersion("v22.5.0-nightly20240101")).toEqual({ major: 22, minor: 5, patch: 0 });
		expect(parseNodeVersion("22.5.0+build.42")).toEqual({ major: 22, minor: 5, patch: 0 });
	});

	it("returns null for garbage input", () => {
		expect(parseNodeVersion("")).toBeNull();
		expect(parseNodeVersion("nope")).toBeNull();
		expect(parseNodeVersion("22.5")).toBeNull();
	});
});

describe("compareSemver", () => {
	it("orders major, minor, patch in that priority", () => {
		expect(compareSemver({ major: 22, minor: 5, patch: 0 }, { major: 20, minor: 99, patch: 99 })).toBeGreaterThan(0);
		expect(compareSemver({ major: 22, minor: 4, patch: 9 }, { major: 22, minor: 5, patch: 0 })).toBeLessThan(0);
		expect(compareSemver({ major: 22, minor: 5, patch: 0 }, { major: 22, minor: 5, patch: 0 })).toBe(0);
	});
});

describe("isNodeVersionSupported", () => {
	it("rejects Node 18 and Node 20, which lack node:sqlite", () => {
		expect(isNodeVersionSupported("v18.20.8")).toBe(false);
		expect(isNodeVersionSupported("v20.20.2")).toBe(false);
		expect(isNodeVersionSupported("v22.4.1")).toBe(false);
	});

	it("accepts Node 22.5+ where node:sqlite is available", () => {
		expect(isNodeVersionSupported("v22.5.0")).toBe(true);
		expect(isNodeVersionSupported("v22.22.1")).toBe(true);
		expect(isNodeVersionSupported("v24.0.0")).toBe(true);
	});

	it("lets unparseable versions through so the real import error still surfaces", () => {
		expect(isNodeVersionSupported("who-knows")).toBe(true);
	});

	it("honors a caller-supplied minimum", () => {
		expect(isNodeVersionSupported("v22.5.0", { major: 22, minor: 6, patch: 0 })).toBe(false);
		expect(isNodeVersionSupported("v22.6.0", { major: 22, minor: 6, patch: 0 })).toBe(true);
	});
});

describe("formatUnsupportedNodeErrorMessage", () => {
	it("mentions the running version and the minimum", () => {
		const message = formatUnsupportedNodeErrorMessage("v20.20.2");
		expect(message).toContain("v20.20.2");
		expect(message).toContain(formatSemver(MIN_NODE_VERSION));
		expect(message).toContain("node:sqlite");
		expect(message).toContain("https://nodejs.org/en/download");
	});
});

describe("assertSupportedNodeVersion", () => {
	it("is a no-op on supported runtimes", () => {
		expect(() => assertSupportedNodeVersion({ runtimeVersion: "v22.22.1" })).not.toThrow();
	});

	it("throws UnsupportedNodeVersionError with a helpful message on Node 20", () => {
		let caught: unknown;
		try {
			assertSupportedNodeVersion({ runtimeVersion: "v20.20.2" });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(UnsupportedNodeVersionError);
		const error = caught as UnsupportedNodeVersionError;
		expect(error.runtimeVersion).toBe("v20.20.2");
		expect(error.minimum).toEqual(MIN_NODE_VERSION);
		expect(error.message).toContain("v20.20.2");
		expect(error.message).toContain("22.5.0");
	});

	it("invokes the onUnsupported callback instead of throwing when supplied", () => {
		const captured: string[] = [];
		const onUnsupported = ((message: string): never => {
			captured.push(message);
			throw new Error("halt");
		}) as (message: string) => never;
		expect(() =>
			assertSupportedNodeVersion({
				runtimeVersion: "v20.20.2",
				onUnsupported,
			}),
		).toThrow("halt");
		expect(captured).toHaveLength(1);
		expect(captured[0]).toContain("v20.20.2");
		expect(captured[0]).toContain("22.5.0");
	});
});

describe("boots Kanban CLI under both Node 20 and Node 22 (issue #357 regression)", () => {
	it("rejects Node 20 with a clear UnsupportedNodeVersionError", () => {
		expect(() =>
			assertSupportedNodeVersion({
				runtimeVersion: "v20.20.2",
			}),
		).toThrow(UnsupportedNodeVersionError);
	});

	it("accepts Node 22.22.1 and proceeds to boot", () => {
		expect(() =>
			assertSupportedNodeVersion({
				runtimeVersion: "v22.22.1",
			}),
		).not.toThrow();
	});

	it("accepts exactly Node 22.5.0 (the version that introduced node:sqlite)", () => {
		expect(() =>
			assertSupportedNodeVersion({
				runtimeVersion: "v22.5.0",
			}),
		).not.toThrow();
	});

	it("rejects Node 22.4.x because node:sqlite is still unavailable there", () => {
		expect(() =>
			assertSupportedNodeVersion({
				runtimeVersion: "v22.4.1",
			}),
		).toThrow(UnsupportedNodeVersionError);
	});
});
