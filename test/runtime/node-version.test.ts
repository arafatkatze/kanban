import { describe, expect, it } from "vitest";

import {
	checkNodeVersion,
	formatNodeVersionError,
	MINIMUM_NODE_VERSION,
	parseNodeVersion,
} from "../../src/core/node-version";

describe("parseNodeVersion", () => {
	it("parses the standard `vMAJOR.MINOR.PATCH` format emitted by process.version", () => {
		expect(parseNodeVersion("v20.12.2")).toEqual({ major: 20, minor: 12, patch: 2 });
	});

	it("parses versions without the leading v", () => {
		expect(parseNodeVersion("22.5.0")).toEqual({ major: 22, minor: 5, patch: 0 });
	});

	it("returns null for unparseable strings", () => {
		expect(parseNodeVersion("")).toBeNull();
		expect(parseNodeVersion("not-a-version")).toBeNull();
	});
});

describe("checkNodeVersion", () => {
	it("rejects Node 18 (documented minimum that is actually broken)", () => {
		const result = checkNodeVersion("v18.19.1");
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("too_old");
		expect(result.minimum).toBe(MINIMUM_NODE_VERSION);
	});

	it("rejects Node 20 which lacks node:sqlite", () => {
		const result = checkNodeVersion("v20.18.0");
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("too_old");
	});

	it("rejects Node 22.4.x (node:sqlite landed in 22.5.0)", () => {
		const result = checkNodeVersion("v22.4.1");
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("too_old");
	});

	it("accepts the minimum supported version (22.5.0)", () => {
		const result = checkNodeVersion("v22.5.0");
		expect(result.ok).toBe(true);
		expect(result.reason).toBeUndefined();
	});

	it("accepts newer patch releases on 22.x", () => {
		expect(checkNodeVersion("v22.12.0").ok).toBe(true);
	});

	it("accepts future major versions", () => {
		expect(checkNodeVersion("v24.0.0").ok).toBe(true);
	});

	it("fails closed on unparseable version strings", () => {
		const result = checkNodeVersion("mystery-runtime");
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("unparseable");
		expect(result.parsed).toBeNull();
	});
});

describe("formatNodeVersionError", () => {
	it("includes the detected version and the minimum in the message", () => {
		const message = formatNodeVersionError(checkNodeVersion("v20.18.0"));
		expect(message).toContain("v20.18.0");
		expect(message).toContain(MINIMUM_NODE_VERSION);
		expect(message).toContain("node:sqlite");
	});

	it("describes the unparseable case without printing NaN", () => {
		const message = formatNodeVersionError(checkNodeVersion("not-a-version"));
		expect(message).toContain('"not-a-version"');
		expect(message).not.toContain("NaN");
	});
});
