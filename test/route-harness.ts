/**
 * A stand-in for Provimux's two session-route paths, and a Pi context that runs `/provimux-route` against it: what the
 * command prints, what it asks, what it sends, and which sockets it closes. Nothing is sent anywhere.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { PROVIMUX_CODEX_API } from "../extensions/codex-stream.ts";
import { ANTHROPIC_MESSAGES_API } from "../extensions/lib.ts";
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
	/** Every notification shown, in order: [text, level]. Print and JSON mode show none. */
	notes: Array<[string, string]>;
	/** What went to stderr. */
	reported: string[];
	/** Every confirm dialog, in order: [title, message]. */
	asked: Array<[string, string]>;
	sent: Sent[];
	/** What happened, in order: "show", "release", "ask", "close". */
	order: string[];
}

export interface RouteCase {
	show?: StandInAnswer[];
	release?: StandInAnswer[];
	format?: "claude" | "codex";
	mode?: "tui" | "rpc" | "print" | "json";
	/** The answers to the confirm dialogs, in order (false when they run out). */
	confirm?: boolean[];
	/** Whether Pi is idle: at the start, and after the dialog. */
	idle?: [boolean, boolean];
	/** Context tokens as Pi counts them; null: not known. */
	tokens?: number | null;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; tiers?: unknown[] };
	/** Another provider's model selected, or none. */
	model?: { provider: string; id: string } | null;
	/** What Pi resolves for the model's requests: its key, and a server address of a stored login. */
	auth?: { ok: boolean; apiKey?: string; baseUrl?: string };
}

export async function runRoute(args: string, setup: RouteCase = {}): Promise<RouteRun> {
	return routeCommand(setup)(args);
}

/** One Pi with the command registered once; each call of what it returns runs it and gives what that call did. */
export function routeCommand(setup: RouteCase = {}): (args: string) => Promise<RouteRun> {
	let run: RouteRun = { notes: [], reported: [], asked: [], sent: [], order: [] };
	const show = [...(setup.show ?? [])];
	const release = [...(setup.release ?? [])];
	const confirm = [...(setup.confirm ?? [])];
	const idle = [...(setup.idle ?? [true, true])];

	const fetchStandIn = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>))
			headers[name.toLowerCase()] = value;
		run.sent.push({ url, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
		run.order.push(url.endsWith("/release") ? "release" : url.endsWith("/session-route") ? "show" : url);
		const answer = (url.endsWith("/release") ? release : show).shift() ?? { status: 404 };
		if ("unreachable" in answer) throw new TypeError(answer.unreachable);
		return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), { status: answer.status });
	}) as typeof fetch;

	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const pi = {
		registerCommand: (_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		},
	} as unknown as ExtensionAPI;
	registerRouteCommand({
		pi,
		providerId: "provimux",
		providerName: "Provimux",
		closeWebSocketSessions: (sessionId) =>
			run.order.push(`close ${sessionId === SESSION_ID ? "session" : sessionId}`),
		report: (message) => run.reported.push(message),
		fetch: fetchStandIn,
		timeZone: "UTC",
	});

	const claude = (setup.format ?? "claude") === "claude";
	const model =
		setup.model === null
			? undefined
			: setup.model
				? { ...setup.model, api: "openai-completions" }
				: {
						provider: "provimux",
						id: claude ? "opus" : "gpt-main",
						api: claude ? ANTHROPIC_MESSAGES_API : PROVIMUX_CODEX_API,
						// As index.ts registers them: Claude-format models at the root, Codex-format ones under /backend-api.
						baseUrl: claude ? BASE_URL : `${BASE_URL}/backend-api`,
						cost: setup.cost ?? { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
					};
	const mode = setup.mode ?? "tui";
	// Pi's print and JSON modes bind no UI: their notify shows nothing.
	const shows = mode === "tui" || mode === "rpc";
	const ctx = {
		mode,
		hasUI: shows,
		model,
		isIdle: () => idle.shift() ?? true,
		modelRegistry: {
			getApiKeyAndHeaders: async () => setup.auth ?? { ok: true, apiKey: "sk-fixture-client" },
		},
		sessionManager: { getSessionId: () => SESSION_ID },
		getContextUsage: () => ({ tokens: setup.tokens === undefined ? 182_000 : setup.tokens }),
		ui: {
			notify: (text: string, level = "info") => {
				if (shows) run.notes.push([text, level]);
			},
			confirm: async (title: string, message: string) => {
				run.asked.push([title, message]);
				run.order.push("ask");
				return confirm.shift() ?? false;
			},
		},
	} as unknown as ExtensionCommandContext;
	return async (args) => {
		run = { notes: [], reported: [], asked: [], sent: [], order: [] };
		await handler!(args, ctx);
		return run;
	};
}
