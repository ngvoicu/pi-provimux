/**
 * The footer says which route answered the session's last turn: `answered: Anthropic sub`, `answered: Devin sub`,
 * `answered: OpenRouter api`.
 *
 * Through Provimux one model name can be served by several routes (subscription logins, API keys, OpenRouter …), and
 * each answer names the credential that served it (`X-CPA-AUTH-*` headers, or the `cpa_auth_*` fields of a Codex
 * WebSocket turn's response.created). Each request keeps what its answer said with the message it ends with
 * (`answerOf`); pi hands only the session's own turns to `message_end`, so pi's cache warmer and other extensions'
 * requests, which overlap the turns, never change what the footer says.
 *
 * - The answer names a credential: `answered: <service> <sub|api>`, in the words of the model names (`sourceLabel`).
 * - It names nobody, from a proxy that names answers (it lists its credentials, or named an answer before in this
 *   session), or gives only the kind: `answered: unknown`.
 * - It names nobody, from a proxy that names no answer (plain CLIProxyAPI): nothing.
 * - Another provider's model (selected, or answering a turn): nothing.
 *
 * Works on its own: no other extension has to ask for the routes (`model-upstreams:request`).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { answerLabel } from "./sources.ts";
import { answerOf, type Statement } from "./upstreams.ts";

export const ANSWERED_STATUS_KEY = "provimux-answered";

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/**
 * The footer's words for what an answer said; undefined for nothing. `namesAnswers`: whether the proxy is known to
 * name what answers (an answer that names nobody is then one it would not name).
 */
export function answeredStatus(said: Statement, namesAnswers: boolean): string | undefined {
	const kind = text(said.kind)?.toLowerCase();
	if (kind !== "oauth" && kind !== "apikey") return namesAnswers ? "answered: unknown" : undefined;
	const provider = text(said.provider);
	// Only the kind (an older Provimux): which service is not said.
	if (!provider) return "answered: unknown";
	const host = text(said.host);
	return `answered: ${answerLabel({ provider, kind, ...(host ? { host } : {}) })}`;
}

interface AnsweredMessage {
	role?: unknown;
	provider?: unknown;
	stopReason?: unknown;
}

/**
 * Shows what answered each of the session's turns on this provider's models. `provider`: the provider's id, or what
 * tells its ids (one extension can register more than one). `namesAnswers`: what else is known of the proxy (the
 * announcer's credential list, and answers of other requests that named a credential).
 */
export function registerAnsweredFooter(
	pi: ExtensionAPI,
	provider: string | ((provider: string | undefined) => boolean),
	namesAnswers: () => boolean = () => false,
) {
	const isOwn = typeof provider === "string" ? (id: string | undefined) => id === provider : provider;
	/** A turn of this session named a credential: the proxy names answers. */
	let namedBefore = false;

	const show = (ctx: ExtensionContext | undefined, status: string | undefined) => {
		try {
			if (!ctx?.hasUI) return;
			ctx.ui.setStatus(ANSWERED_STATUS_KEY, status === undefined ? undefined : ctx.ui.theme.fg("dim", status));
		} catch {
			// A context from a session that is gone: its footer is too.
		}
	};

	pi.on("message_end", (event, ctx) => {
		const message = event.message as AnsweredMessage;
		if (message.role !== "assistant") return;
		if (typeof message.provider !== "string" || !isOwn(message.provider)) {
			show(ctx, undefined);
			return;
		}
		const said = answerOf(message);
		if (!said) {
			// No answer came (a refused or failed request, a compaction): what answered last still stands.
			if (message.stopReason === "error" || message.stopReason === "aborted") return;
			show(ctx, undefined);
			return;
		}
		const kind = text(said.kind)?.toLowerCase();
		if (kind === "oauth" || kind === "apikey") namedBefore = true;
		show(ctx, answeredStatus(said, namedBefore || namesAnswers()));
	});

	pi.on("model_select", (event, ctx) => {
		if (!isOwn(event.model.provider)) show(ctx, undefined);
	});

	// A new session has had no answer yet.
	pi.on("session_start", (_event, ctx) => {
		namedBefore = false;
		show(ctx, undefined);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		namedBefore = false;
		show(ctx, undefined);
	});
}
