import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Version = [number, number, number];

/** The installed pi-ai's version: its package.json, found from its entry point, which is all the package exports. */
function installedPiAiVersion(): Version {
	let dir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")));
	for (;;) {
		try {
			const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
			if (pkg.name === "@earendil-works/pi-ai" && pkg.version) {
				const match = /^(\d+)\.(\d+)\.(\d+)/.exec(pkg.version);
				if (!match) throw new Error(`pi-ai's version is not x.y.z: ${pkg.version}`);
				return [Number(match[1]), Number(match[2]), Number(match[3])];
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const parent = dirname(dir);
		if (parent === dir) throw new Error("pi-ai's package.json was not found");
		dir = parent;
	}
}

export const PI_AI_VERSION: Version = installedPiAiVersion();

/** Whether the installed pi-ai is `since` or newer. */
export function piAiAtLeast(since: Version): boolean {
	for (let i = 0; i < 3; i++) {
		if (PI_AI_VERSION[i] !== since[i]) return PI_AI_VERSION[i] > since[i];
	}
	return true;
}

/**
 * pi-ai 1.6.0's Codex adapter does two things itself that the extension did before: the system prompt goes in a
 * leading `{ role: "developer", content }` input item, with no `instructions`, and thinking level changes travel as
 * configuration_update items (getConfigurationUpdateEffort), so the extension's patch for them is skipped.
 */
export const PI_AI_NATIVE_CODEX_PROMPT_AND_EFFORT: Version = [1, 6, 0];
