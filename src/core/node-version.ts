/**
 * Kanban depends on `node:sqlite` (via `@clinebot/core` -> `@clinebot/shared/db`)
 * for its session store. `node:sqlite` was only introduced as a built-in module
 * in Node.js 22.5.0, so older runtimes fail at load time with
 * `ERR_UNKNOWN_BUILTIN_MODULE` and the file-based fallback then degrades with
 * `ECOMPROMISED` lockfile errors, leaving Kanban unusable.
 *
 * See: https://github.com/cline/kanban/issues/357
 *
 * To give users a clear failure mode instead of the confusing chained crash,
 * we check the active Node version at process startup and exit with a helpful
 * message if it is too old.
 */

export interface SemverVersion {
	major: number;
	minor: number;
	patch: number;
}

/**
 * Minimum Node.js version required to run Kanban. This matches the version
 * that introduced the `node:sqlite` built-in module.
 */
export const MIN_NODE_VERSION: SemverVersion = { major: 22, minor: 5, patch: 0 };

export function formatSemver(version: SemverVersion): string {
	return `${version.major}.${version.minor}.${version.patch}`;
}

/**
 * Parse a Node-style version string (e.g. `v20.20.2` or `22.5.0`) into its
 * semver components. Returns `null` if the string cannot be parsed.
 */
export function parseNodeVersion(raw: string): SemverVersion | null {
	const trimmed = raw.trim().replace(/^v/i, "");
	if (!trimmed) {
		return null;
	}
	// Strip pre-release / build metadata so "22.5.0-nightly+abc" still parses.
	const core = trimmed.split(/[-+]/, 1)[0] ?? trimmed;
	const parts = core.split(".");
	if (parts.length < 3) {
		return null;
	}
	const [majorStr, minorStr, patchStr] = parts;
	const major = Number.parseInt(majorStr ?? "", 10);
	const minor = Number.parseInt(minorStr ?? "", 10);
	const patch = Number.parseInt(patchStr ?? "", 10);
	if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
		return null;
	}
	if (major < 0 || minor < 0 || patch < 0) {
		return null;
	}
	return { major, minor, patch };
}

export function compareSemver(a: SemverVersion, b: SemverVersion): number {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	return a.patch - b.patch;
}

export function isNodeVersionSupported(runtimeVersion: string, minimum: SemverVersion = MIN_NODE_VERSION): boolean {
	const parsed = parseNodeVersion(runtimeVersion);
	if (!parsed) {
		// If the version string is unparseable, err on the side of letting the
		// runtime proceed rather than blocking it: the real import-time failure
		// will still surface a useful error.
		return true;
	}
	return compareSemver(parsed, minimum) >= 0;
}

export function formatUnsupportedNodeErrorMessage(
	runtimeVersion: string,
	minimum: SemverVersion = MIN_NODE_VERSION,
): string {
	return [
		`Kanban requires Node.js ${formatSemver(minimum)} or newer, but this process is running Node.js ${runtimeVersion}.`,
		"",
		"Kanban's session store depends on the node:sqlite built-in module, which",
		`was introduced in Node.js ${formatSemver(minimum)}. Earlier versions fail to load it at`,
		"startup (see https://github.com/cline/kanban/issues/357).",
		"",
		"Upgrade Node.js and try again:",
		"  - macOS (Homebrew):   brew install node           # installs the latest",
		"  - nvm:                nvm install 22 && nvm use 22",
		"  - Windows / Linux:    https://nodejs.org/en/download",
	].join("\n");
}

export interface AssertSupportedNodeVersionOptions {
	runtimeVersion?: string;
	minimum?: SemverVersion;
	onUnsupported?: (message: string) => never;
}

/**
 * Thrown by {@link assertSupportedNodeVersion} when the active Node.js
 * runtime does not meet the minimum required version. Exposed so CLI-style
 * callers can catch it and exit the process, without the helper itself having
 * to touch `process.exit`.
 */
export class UnsupportedNodeVersionError extends Error {
	readonly runtimeVersion: string;
	readonly minimum: SemverVersion;

	constructor(message: string, runtimeVersion: string, minimum: SemverVersion) {
		super(message);
		this.name = "UnsupportedNodeVersionError";
		this.runtimeVersion = runtimeVersion;
		this.minimum = minimum;
	}
}

/**
 * Throws an {@link UnsupportedNodeVersionError} with a human-readable message
 * when Kanban is launched on an unsupported Node.js runtime. Returns `void`
 * on supported runtimes so callers can invoke it at the top of their
 * entrypoint without branching.
 */
export function assertSupportedNodeVersion(options: AssertSupportedNodeVersionOptions = {}): void {
	const runtimeVersion = options.runtimeVersion ?? process.version;
	const minimum = options.minimum ?? MIN_NODE_VERSION;
	if (isNodeVersionSupported(runtimeVersion, minimum)) {
		return;
	}
	const message = formatUnsupportedNodeErrorMessage(runtimeVersion, minimum);
	if (options.onUnsupported) {
		options.onUnsupported(message);
		return;
	}
	throw new UnsupportedNodeVersionError(message, runtimeVersion, minimum);
}
