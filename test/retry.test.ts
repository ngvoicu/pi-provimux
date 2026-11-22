import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AssistantMessage, isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { normalizeTransientNetworkError, registerTransientNetworkErrorRetry } from "../extensions/retry.ts";

const TRANSIENT_STREAM_ERRORS = [
	"Codex error: read tcp 172.16.209.2:57303->172.64.155.209:443: use of closed network connection",
	"Error: Codex error: stream error: stream disconnected before completion: stream closed before response.completed",
	"Codex error: invalid SSE data JSON (len=33181)",
];

/**
 * The first pi-ai release whose own isRetryableAssistantError retries the error, for the errors it does retry: from
 * then on the extension leaves the message as pi has it. An error not listed is not retried by any pi-ai yet.
 */
const RETRIED_BY_PI_SINCE: Record<string, [number, number, number]> = {
	[TRANSIENT_STREAM_ERRORS[1]]: [1, 4, 0],
};

/** The installed pi-ai's version: its package.json, found from its entry point, which is all the package exports. */
function installedPiAiVersion(): [number, number, number] {
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

function atLeast(version: [number, number, number], since: [number, number, number]): boolean {
	for (let i = 0; i < 3; i++) {
		if (version[i] !== since[i]) return version[i] > since[i];
	}
	return true;
}

const PI_AI_VERSION = installedPiAiVersion();

function assistantError(errorMessage: string, provider = "cliproxyapi"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "cliproxyapi-codex-responses",
		provider,
		model: "gpt-5.6-sol",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

describe("transient network error normalization", () => {
	it.each(TRANSIENT_STREAM_ERRORS)("makes CLIProxyAPI transient stream error retryable: %s", (errorMessage) => {
		const original = assistantError(errorMessage);
		const since = RETRIED_BY_PI_SINCE[errorMessage];
		if (since && atLeast(PI_AI_VERSION, since)) {
			// pi retries it itself: the message is left exactly as pi has it, and stays retryable.
			expect(isRetryableAssistantError(original)).toBe(true);
			expect(normalizeTransientNetworkError(original)).toBe(original);
			return;
		}
		expect(isRetryableAssistantError(original)).toBe(false);

		const normalized = normalizeTransientNetworkError(original);
		expect(normalized).not.toBe(original);
		expect(normalized.errorMessage).toBe(`network error: ${errorMessage}`);
		expect(isRetryableAssistantError(normalized)).toBe(true);
	});

	it("leaves existing retryable and unrelated errors unchanged", () => {
		const retryable = assistantError("WebSocket closed 1006");
		const unrelated = assistantError("Codex error: invalid request");

		expect(normalizeTransientNetworkError(retryable)).toBe(retryable);
		expect(normalizeTransientNetworkError(unrelated)).toBe(unrelated);
	});

	it("only rewrites assistant errors from the registered provider", () => {
		let handler: ((event: any, ctx: ExtensionContext) => unknown) | undefined;
		const pi = {
			on: (event: string, candidate: (event: any, ctx: ExtensionContext) => unknown) => {
				if (event === "message_end") handler = candidate;
			},
		} as unknown as ExtensionAPI;
		registerTransientNetworkErrorRetry(pi, "cliproxyapi");
		if (!handler) throw new Error("message_end handler was not registered");

		const matching = assistantError(TRANSIENT_STREAM_ERRORS[0]);
		const replacement = handler({ type: "message_end", message: matching }, {} as ExtensionContext) as {
			message: AssistantMessage;
		};
		expect(replacement.message.errorMessage).toBe(`network error: ${TRANSIENT_STREAM_ERRORS[0]}`);

		const otherProvider = assistantError(TRANSIENT_STREAM_ERRORS[0], "other");
		expect(handler({ type: "message_end", message: otherProvider }, {} as ExtensionContext)).toBeUndefined();
	});
});
