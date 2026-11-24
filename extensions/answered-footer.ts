/**
 * The footer says which route answered the session's last turn: `answered: Anthropic sub`, `answered: Devin sub`,
 * `answered: OpenRouter api`.
 *
 * Through Provimux one model name can be served by several routes (subscription logins, API keys, OpenRouter …), and
 * each answer names the credential that served it (`X-CPA-AUTH-*` headers, or the `cpa_auth_*` fields of a Codex
 * WebSocket turn's response.created). Each request keeps what the attempt that answered said with the message it ends
 * with (`answerOf`); pi hands only the session's own turns to `message_end`, so pi's cache warmer and other
 * extensions' requests, which overlap the turns, never change what the footer says.
 *
 * The footer only ever shows the route that produced the answer the user sees:
 * - Only an answer: a turn that completed (`stop`, or `toolUse`) with something in it. A failed, aborted or empty turn
 *   leaves the footer as it was, whatever its attempt said.
 * - The answer names a credential: `answered: <service> <sub|api>`, in the words of the model names (`sourceLabel`).
 * - It names nobody (no provider), from a proxy that names answers (its model list lists credentials, or it named an
 *   answer before in this session): `answered: unknown`. Provimux names every answer it can from 8.1.1-pmx.1 on.
 * - It names nobody, from a proxy that names no answer (plain CLIProxyAPI): nothing.
 * - Another provider's model (selected, or answering a turn): nothing; a turn of this provider that ends after another
 *   provider's model was selected leaves it so.
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
	const provider = text(said.provider);
	if ((kind !== "oauth" && kind !== "apikey") || !provider) return namesAnswers ? "answered: unknown" : undefined;
	const host = text(said.host);
	return `answered: ${answerLabel({ provider, kind, ...(host ? { host } : {}) })}`;
}

interface AnsweredMessage {
	role?: unknown;
	provider?: unknown;
	stopReason?: unknown;
	content?: unknown;
}

/** A block the user sees: text or thinking with something in it, a tool call, anything else pi shows. */
function shown(block: unknown): boolean {
	if (!block || typeof block !== "object") return false;
	const { type, text: said, thinking } = block as { type?: unknown; text?: unknown; thinking?: unknown };
	if (type === "text") return !!text(said);
	if (type === "thinking") return !!text(thinking);
	return typeof type === "string";
}

/** An answer the user sees: completed, or calling tools, with something in it. */
export function isAnswer(message: AnsweredMessage): boolean {
	if (message.stopReason !== "stop" && message.stopReason !== "toolUse") return false;
	return Array.isArray(message.content) && message.content.some(shown);
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

	/** Whether the session's model is now one of this provider's: an answer that ends later shows on no other. */
	const ownModel = (ctx: ExtensionContext) => {
		try {
			return isOwn(ctx.model?.provider);
		} catch {
			return false;
		}
	};

	pi.on("message_end", (event, ctx) => {
		const message = event.message as AnsweredMessage;
		if (message.role !== "assistant") return;
		// No answer the user sees (failed, aborted, empty): what answered last still stands.
		if (!isAnswer(message)) return;
		if (typeof message.provider !== "string" || !isOwn(message.provider) || !ownModel(ctx)) {
			show(ctx, undefined);
			return;
		}
		const said = answerOf(message);
		// An answer nothing was heard about: nothing to say.
		if (!said) {
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
