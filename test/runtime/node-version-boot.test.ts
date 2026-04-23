import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression test for cline/kanban#357.
 *
 * Boots the built Kanban CLI under both Node 20 and Node 22 (via the
 * locally-installed `nvm`) and asserts:
 *
 *   - Under Node 20 the process exits non-zero with a clear error that names
 *     the minimum required Node version (it must NOT try to load
 *     `node:sqlite` and crash with the confusing `ERR_UNKNOWN_BUILTIN_MODULE`
 *     / `ECOMPROMISED` chain from the issue report).
 *   - Under Node 22 the CLI `--version` command runs to completion.
 *
 * The test is skipped automatically if `nvm` is not available or a required
 * Node version is not installed, so local developer boxes without the exact
 * versions still pass.
 */

const NVM_DIR = process.env.NVM_DIR ?? join(homedir(), ".nvm");

function findInstalledNodeBinary(majorPrefix: string): string | undefined {
	const versionsDir = join(NVM_DIR, "versions", "node");
	if (!existsSync(versionsDir)) {
		return undefined;
	}
	try {
		const entries = readdirSync(versionsDir);
		const match = entries
			.filter((entry) => entry.startsWith(`v${majorPrefix}`))
			.sort()
			.pop();
		if (!match) {
			return undefined;
		}
		const candidate = join(versionsDir, match, "bin", "node");
		return existsSync(candidate) ? candidate : undefined;
	} catch {
		return undefined;
	}
}

function runCliWith(nodeBin: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(nodeBin, [join(process.cwd(), "dist", "cli.js"), ...args], {
		encoding: "utf8",
		timeout: 15_000,
		env: {
			...process.env,
			// Skip browser auto-open and keep output deterministic.
			KANBAN_NO_OPEN: "1",
		},
	});
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

const cliBuildExists = existsSync(join(process.cwd(), "dist", "cli.js"));
const node20Bin = findInstalledNodeBinary("20");
const node22Bin = findInstalledNodeBinary("22");

describe.skipIf(!cliBuildExists)("Kanban CLI boot regression (#357)", () => {
	it.skipIf(!node20Bin)("rejects Node 20 with a clear unsupported-runtime message", () => {
		if (!node20Bin) return;
		const result = runCliWith(node20Bin, ["--version"]);
		expect(result.status).not.toBe(0);
		const combined = `${result.stdout}\n${result.stderr}`;
		expect(combined).toMatch(/Node\.js 22\.5\.0 or newer/i);
		// The confusing crash chain from the issue must NOT surface anymore:
		// the guard must reject before any module loads node:sqlite or the
		// file-lock fallback kicks in.
		expect(combined).not.toMatch(/\bERR_UNKNOWN_BUILTIN_MODULE\b/);
		expect(combined).not.toMatch(/\bECOMPROMISED\b/);
		expect(combined).not.toMatch(/Unable to update lock within the stale threshold/);
	});

	it.skipIf(!node22Bin)("boots on Node 22 and prints --version", () => {
		if (!node22Bin) return;
		const result = runCliWith(node22Bin, ["--version"]);
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
	});
});
