const MIN_MAJOR = 22;
const MIN_MINOR = 5;
const MIN_PATCH = 0;

export const MINIMUM_NODE_VERSION = `${MIN_MAJOR}.${MIN_MINOR}.${MIN_PATCH}` as const;

export interface ParsedNodeVersion {
	major: number;
	minor: number;
	patch: number;
}

export interface NodeVersionCheckResult {
	ok: boolean;
	current: string;
	parsed: ParsedNodeVersion | null;
	minimum: string;
	reason?: "unparseable" | "too_old";
}

export function parseNodeVersion(rawVersion: string): ParsedNodeVersion | null {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(rawVersion.trim());
	if (!match) {
		return null;
	}
	const [, majorStr, minorStr, patchStr] = match;
	const major = Number.parseInt(majorStr ?? "", 10);
	const minor = Number.parseInt(minorStr ?? "", 10);
	const patch = Number.parseInt(patchStr ?? "", 10);
	if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
		return null;
	}
	return { major, minor, patch };
}

export function checkNodeVersion(rawVersion: string): NodeVersionCheckResult {
	const parsed = parseNodeVersion(rawVersion);
	if (!parsed) {
		return {
			ok: false,
			current: rawVersion,
			parsed: null,
			minimum: MINIMUM_NODE_VERSION,
			reason: "unparseable",
		};
	}

	const isSupported =
		parsed.major > MIN_MAJOR ||
		(parsed.major === MIN_MAJOR &&
			(parsed.minor > MIN_MINOR || (parsed.minor === MIN_MINOR && parsed.patch >= MIN_PATCH)));

	return {
		ok: isSupported,
		current: rawVersion,
		parsed,
		minimum: MINIMUM_NODE_VERSION,
		reason: isSupported ? undefined : "too_old",
	};
}

export function formatNodeVersionError(result: NodeVersionCheckResult): string {
	const header = `Kanban requires Node.js ${MINIMUM_NODE_VERSION} or newer.`;
	const detail =
		result.reason === "unparseable"
			? `Detected an unrecognized Node.js version string: "${result.current}".`
			: `You are running Node.js ${result.current}.`;
	const reason =
		"Kanban's Cline SDK integration depends on the built-in node:sqlite module, which was " +
		"introduced in Node.js 22.5.0. Older runtimes crash with ERR_UNKNOWN_BUILTIN_MODULE as " +
		"soon as a task session is created.";
	const remedy = "Install Node.js 22.5+ (for example via nvm: `nvm install 22 && nvm use 22`) and re-run the command.";
	return [header, detail, "", reason, "", remedy].join("\n");
}
