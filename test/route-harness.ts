/**
 * A stand-in for Provimux's two session-route paths (answers from the contract's examples), and a pi that runs
 * `/provimux-route` against it: what the command prints, what it asks, what it sends, and which sockets it closes.
 * Nothing is sent anywhere: the command's fetch is this stand-in.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { PROVIMUX_CODEX_API } from "../extensions/codex-stream.ts";
import { ANTHROPIC_MESSAGES_API, saveConfigFile } from "../extensions/lib.ts";
import { registerRouteCommand } from "../extensions/route.ts";

export const SESSION_ID = "0c9b1f0e-6a51-4c58-9b1e-2f6f3f1f7a10";
export const BASE_URL = "http://gateway.test:8400";
export const SHOW_URL = `${BASE_URL}/v1/provimux/session-route`;
export const RELEASE_URL = `${BASE_URL}/v1/provimux/session-route/release`;

/** One answer of the stand-in: a status and a JSON body; or a failure to connect. */
export type StandInAnswer = { status: number; body?: unknown } | { unreachable: string };

export interface Sent {
	url: string;
	headers: Record<string, string>;
	body: unknown;
}

export interface RouteRun {
	/** Every notify, in order: [text, level]. */
	notes: Array<[string, string]>;
	/** Every confirm dialog, in order: [title, message]. */
	asked: Array<[string, string]>;
	/** The requests the command sent. */
	sent: Sent[];
	/** Sessions whose Codex sockets were closed. */
	closed: string[];
	/** What happened, in order: "show", "release", "ask", "close", "sleep". */
	order: string[];
}

/** Pi's own clock in these tests: half a minute after the contract's examples were observed. */
export const PI_NOW = Date.parse("2026-11-27T10:15:30Z");

export interface RouteCase {
	show?: StandInAnswer[];
	release?: StandInAnswer[];
	/** "claude" (the Claude format) or "codex". */
	format?: "claude" | "codex";
	mode?: "tui" | "rpc" | "print";
	/** The answers to the confirm dialogs, in order (false when they run out). */
	confirm?: boolean[];
	/** Context tokens as pi counts them; null: not known. */
	tokens?: number | null;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/** Another provider's model selected, or none. */
	model?: { provider: string; id: string } | null;
	/** No provimux.json: not set up. */
	unconfigured?: boolean;
	/**
	 * The last request this Pi noted for the session: how long ago, and the lifetime Pi took for it (ms; absent: not
	 * known). null: none noted. Default: 2 minutes ago, a 5-minute cache, so it may be warm.
	 */
	noted?: { agoMs: number; ttlMs?: number } | null;
	/** The session's last answer, how long ago (ms); absent: none in its entries. */
	lastAnswerAgoMs?: number;
	/** The model's promptCache, as Pi holds it (pi-cache-keeper writes it). */
	promptCache?: { short?: number; long?: number };
}

const temp: string[] = [];
export function cleanupRouteRuns(): void {
	while (temp.length > 0) rmSync(temp.pop()!, { recursive: true, force: true });
}

export async function runRoute(args: string, setup: RouteCase = {}): Promise<RouteRun> {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-provimux-route-test-"));
	temp.push(agentDir);
	if (!setup.unconfigured) saveConfigFile(agentDir, { baseUrl: BASE_URL, apiKey: "sk-fixture-client" });
	const run: RouteRun = { notes: [], asked: [], sent: [], closed: [], order: [] };
	const show = [...(setup.show ?? [])];
	const release = [...(setup.release ?? [])];
	const confirm = [...(setup.confirm ?? [])];

	const fetchStandIn = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>))
			headers[name.toLowerCase()] = value;
		run.sent.push({ url, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
		const queue = url === SHOW_URL ? show : url === RELEASE_URL ? release : [];
		run.order.push(url === SHOW_URL ? "show" : url === RELEASE_URL ? "release" : url);
		const answer = queue.shift() ?? { status: 404, body: undefined };
		if ("unreachable" in answer) throw new TypeError(answer.unreachable);
		return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), {
			status: answer.status,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;

	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const pi = {
		registerCommand: (_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		},
	} as unknown as ExtensionAPI;
	registerRouteCommand({
		pi,
		agentDir,
		providerId: "provimux",
		providerName: "Provimux",
		closeWebSocketSessions: (sessionId) => {
			run.closed.push(sessionId);
			run.order.push("close");
		},
		fetch: fetchStandIn,
		timeZone: "UTC",
		now: () => PI_NOW,
		sleep: async (ms) => {
			run.order.push(`sleep ${ms}`);
		},
		lastUse: (sessionId) => {
			if (sessionId !== SESSION_ID) return undefined;
			const noted = setup.noted === undefined ? { agoMs: 120_000, ttlMs: 300_000 } : setup.noted;
			return noted
				? { at: PI_NOW - noted.agoMs, ...(noted.ttlMs !== undefined ? { ttlMs: noted.ttlMs } : {}) }
				: undefined;
		},
	});

	const format = setup.format ?? "claude";
	const model =
		setup.model === null
			? undefined
			: setup.model
				? { ...setup.model, api: "openai-completions" }
				: {
						provider: "provimux",
						id: format === "claude" ? "opus" : "gpt-main",
						api: format === "claude" ? ANTHROPIC_MESSAGES_API : PROVIMUX_CODEX_API,
						cost: setup.cost ?? { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
						...(setup.promptCache ? { promptCache: setup.promptCache } : {}),
					};
	const mode = setup.mode ?? "tui";
	const ctx = {
		mode,
		hasUI: mode !== "print",
		model,
		sessionManager: {
			getSessionId: () => SESSION_ID,
			getEntries: () =>
				setup.lastAnswerAgoMs === undefined
					? []
					: [
							{
								type: "message",
								message: { role: "assistant", provider: "provimux", timestamp: PI_NOW - setup.lastAnswerAgoMs },
							},
						],
		},
		getContextUsage: () => ({ tokens: setup.tokens === undefined ? 182_000 : setup.tokens }),
		ui: {
			notify: (text: string, level = "info") => run.notes.push([text, level]),
			confirm: async (title: string, message: string) => {
				run.asked.push([title, message]);
				run.order.push("ask");
				return confirm.shift() ?? false;
			},
		},
	} as unknown as ExtensionCommandContext;
	await handler!(args, ctx);
	return run;
}
