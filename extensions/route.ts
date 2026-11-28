/**
 * `/provimux-route`: which of the server's routes this conversation is bound to, and moving it back to its first route.
 *
 * With `routing.session-affinity` on, Provimux binds a conversation to the account that answered it. Provimux (from the
 * version in SESSION_ROUTE_SINCE) shows that binding and removes it through two requests of its own, named by the
 * session header the conversation's turns carry:
 *
 * - `POST /v1/provimux/session-route`: where the conversation is bound, since when, whether that is a fallback, whether
 *   a higher-priority route is free (or when one is expected free), and whether the server's automatic return is on.
 *   It changes nothing and sends nothing to a model.
 * - `POST /v1/provimux/session-route/release`: removes the binding, only while it is the one the show saw (`expect`).
 *   The conversation's next request goes to the first available route by priority.
 *
 * The command: one show; in the TUI, while Pi is idle, a release after the cost was said and the user said yes; then
 * the conversation's Codex WebSocket is closed once, so that its next turn is routed afresh.
 */
import { calculateCost } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ANTHROPIC_MESSAGES_API, resolveEndpoints } from "./lib.ts";
import { answerLabel } from "./sources.ts";

export const ROUTE_COMMAND = "provimux-route";
/** The first Provimux version with the two requests. */
export const SESSION_ROUTE_SINCE = "8.1.7-pmx.4";
const REQUEST_TIMEOUT_MS = 10_000;
/** Pi's limit on a Codex-format session id (pi-ai's clampOpenAIPromptCacheKey). */
const CODEX_SESSION_ID_MAX = 64;

// --- The command. -----------------------------------------------------------------------------------------------------

type Fetch = typeof fetch;

export interface RouteCommandOptions {
	pi: ExtensionAPI;
	providerId: string;
	providerName: string;
	/** Closes the Codex WebSockets of a session (the patched module's); absent when the Codex stream did not load. */
	closeWebSocketSessions?: (sessionId: string) => void;
	/** Where a message goes in print and JSON mode, which show no notification: stderr. */
	report?: (message: string) => void;
	/** For tests: the fetch the two requests use, and the time zone times are written in. */
	fetch?: Fetch;
	timeZone?: string;
}

type Reply = { kind: "answer"; status: number; body: unknown } | { kind: "unreachable"; message: string };

const USAGE = `/${ROUTE_COMMAND} takes nothing (show where this conversation is), or release (move it back to a free higher-priority route).`;

export function registerRouteCommand(options: RouteCommandOptions): void {
	const { pi, providerId, providerName, closeWebSocketSessions, timeZone } = options;
	const doFetch: Fetch = options.fetch ?? ((...args) => fetch(...args));
	const report = options.report ?? ((message: string) => console.error(message));

	const handler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		if (ctx.mode === "print" || ctx.mode === "json") {
			report(
				`/${ROUTE_COMMAND} works in Pi's interactive terminal (and shows the route in RPC mode): nothing was sent.`,
			);
			return;
		}
		const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
		const release = words[0] === "release";
		if (words.length > 1 || (words.length === 1 && !release)) {
			ctx.ui.notify(USAGE, "error");
			return;
		}
		if (release && ctx.mode !== "tui") {
			ctx.ui.notify(
				`Nothing was released: /${ROUTE_COMMAND} release asks before it moves the conversation, and it can ask only in Pi's interactive terminal. Here, /${ROUTE_COMMAND} shows the route.`,
				"warning",
			);
			return;
		}
		const busy = () => {
			if (ctx.isIdle()) return false;
			ctx.ui.notify(
				`Nothing was released: Pi is answering. Type /${ROUTE_COMMAND} release again when the answer is done.`,
				"warning",
			);
			return true;
		};
		if (release && busy()) return;

		const model = ctx.model;
		if (!model || model.provider !== providerId) {
			const current = model ? `the current model is ${model.provider}/${model.id}` : "no model is selected";
			ctx.ui.notify(
				`/${ROUTE_COMMAND} shows the route of a ${providerName} model, and ${current}. Choose a ${providerName} model in /model, then type /${ROUTE_COMMAND} again.`,
				"error",
			);
			return;
		}
		// The server and the key the model's own turns use: Pi's resolution, with a key given on the command line and
		// the address of a stored login.
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			ctx.ui.notify(
				`${providerName} has no key set up, so there is no conversation route to show. Type /login ${providerName} (or /login ${providerId}) and enter your server's address and key.`,
				"error",
			);
			return;
		}
		const apiKey = auth.apiKey;
		const root = resolveEndpoints(auth.baseUrl ?? model.baseUrl).messagesBaseUrl;
		const showUrl = `${root}/v1/provimux/session-route`;
		const releaseUrl = `${root}/v1/provimux/session-route/release`;
		// Named exactly as this model's turns name the conversation: Pi's Claude format sends x-session-affinity, its
		// Codex format session-id (clamped as Pi clamps it).
		const sessionId = ctx.sessionManager.getSessionId();
		const claudeFormat = model.api === ANTHROPIC_MESSAGES_API;
		const header: Record<string, string> = claudeFormat
			? { "x-session-affinity": sessionId }
			: { "session-id": Array.from(sessionId).slice(0, CODEX_SESSION_ID_MAX).join("") };
		const clockOf = (answer: ShowAnswer): Clock => ({ now: Date.parse(answer.observedAt), timeZone });

		// One show.
		const reply = await post(doFetch, showUrl, apiKey, header, { model: model.id });
		if (reply.kind !== "answer" || reply.status !== 200) {
			ctx.ui.notify(failureText(reply, showUrl, providerName, release), "error");
			return;
		}
		const shown = parseShowAnswer(reply.body);
		if (!shown) {
			ctx.ui.notify(unreadable(release), "error");
			return;
		}
		if (!release) {
			ctx.ui.notify(showText(shown, model.id, clockOf(shown), ctx.mode === "tui"), "info");
			return;
		}

		// Whether a release leads anywhere, decided once (the show's hint uses the same).
		const name = nameOf(shown, model.id);
		const bound = shown.bound;
		const unbound = unboundText(shown, name);
		if (unbound !== undefined || !bound) {
			ctx.ui.notify(`${unbound} Nothing was released.`, "info");
			return;
		}
		const here = routeLabel(bound.route);
		const eligibility = releaseEligibility(shown);
		if (eligibility !== "release") {
			ctx.ui.notify(notReleasedText(shown, eligibility, here, clockOf(shown)), "info");
			return;
		}
		if (!shown.binding) {
			ctx.ui.notify(
				`Nothing was released: Provimux could not identify this conversation's binding just now. Check again with /${ROUTE_COMMAND}.`,
				"warning",
			);
			return;
		}

		const ok = await ctx.ui.confirm(
			`Move this conversation from ${here} to ${destination(shown.first)} now?`,
			costText({ tokens: ctx.getContextUsage()?.tokens, model, to: shown.first }),
		);
		if (!ok) {
			ctx.ui.notify("Nothing was released.", "info");
			return;
		}
		if (busy()) return;

		const answer = await post(doFetch, releaseUrl, apiKey, header, { model: model.id, expect: shown.binding });
		if (answer.kind === "answer" && answer.status === 409) {
			const changed = parseShowAnswer(answer.body);
			const moved = "Nothing was released: this conversation's binding changed since the check.";
			ctx.ui.notify(
				changed
					? `${moved}\n${showText(changed, model.id, clockOf(changed), true)}`
					: `${moved} Check again with /${ROUTE_COMMAND}.`,
				"warning",
			);
			return;
		}
		if (answer.kind === "unreachable" || answer.status >= 500) {
			const why =
				answer.kind === "unreachable"
					? `the server's answer did not come (${answer.message})`
					: `the server could not confirm the release (HTTP ${answer.status})`;
			ctx.ui.notify(unknownOutcome(why), "error");
			return;
		}
		if (answer.status !== 200) {
			ctx.ui.notify(failureText(answer, releaseUrl, providerName, true), "error");
			return;
		}
		const released = parseReleaseAnswer(answer.body);
		if (!released) {
			ctx.ui.notify(unknownOutcome("the server's answer could not be read"), "error");
			return;
		}
		if (!released.released) {
			ctx.ui.notify(
				released.affinity === "on" && released.conversation === "not-bound"
					? "Nothing was released: the conversation was no longer bound (its binding expired or was released meanwhile). Its next message goes to the first available route."
					: `${unboundText(released, name)} Nothing was released.`,
				"info",
			);
			return;
		}

		// Right after the release, before any further turn: a turn on a Codex WebSocket left open stays on its login.
		const onSocket = closeWebSocketSessions && (released.websocketMayHold || shown.websocketMayHold || !claudeFormat);
		if (onSocket) closeWebSocketSessions(sessionId);
		const was = released.was ? routeLabel(released.was) : here;
		const next =
			released.next.length > 0
				? `Its next message goes to the first available route (now: ${destination(released.next)}), and may read the whole conversation once without cache.`
				: "Provimux lists no route for its next message right now.";
		const socket = onSocket
			? " Its Codex WebSocket, if one was open, was closed, so that message is routed afresh."
			: "";
		ctx.ui.notify(`Released: this conversation is no longer bound to ${was}. ${next}${socket}`, "info");
	};

	pi.registerCommand(ROUTE_COMMAND, {
		description:
			"Show which account this conversation is on and whether a higher-priority route is free; /provimux-route release moves it back, after saying what that may cost and asking",
		getArgumentCompletions: (prefix: string) =>
			"release".startsWith(prefix.trim().toLowerCase()) ? [{ value: "release", label: "release" }] : null,
		handler,
	});
}

async function post(
	doFetch: Fetch,
	url: string,
	apiKey: string,
	header: Record<string, string>,
	body: unknown,
): Promise<Reply> {
	try {
		const response = await doFetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				Accept: "application/json",
				...header,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const text = await response.text();
		let parsed: unknown;
		try {
			parsed = text ? JSON.parse(text) : undefined;
		} catch {
			parsed = undefined;
		}
		return { kind: "answer", status: response.status, body: parsed };
	} catch (error) {
		return { kind: "unreachable", message: error instanceof Error ? error.message : String(error) };
	}
}

/** A reply that is not the contract's 200, in words that say what to do next. Only where nothing can have changed. */
function failureText(reply: Reply, url: string, providerName: string, release: boolean): string {
	const nothing = release ? " Nothing was released." : "";
	if (reply.kind === "unreachable")
		return `Could not reach your ${providerName} server at ${url}: ${reply.message}.${nothing} Check that it is running, or type /login ${providerName} to change its address.`;
	if (reply.status === 404)
		return `This server has no conversation routes: /${ROUTE_COMMAND} needs Provimux ${SESSION_ROUTE_SINCE} or newer (plain CLIProxyAPI has none).${nothing} Update Provimux to use it; everything else works as before.`;
	if (reply.status === 401)
		return `The server refused the client key (HTTP 401).${nothing} Type /login ${providerName} to enter the key again.`;
	const said = errorMessage(reply.body);
	if (reply.status === 400)
		return `The server refused the request (HTTP 400)${said ? `: ${said}` : ""}.${nothing} If it says the model is not served, choose another in /model.`;
	return `The server answered HTTP ${reply.status}${said ? `: ${said}` : ""}.${nothing} Try again in a moment; if it persists, check the server.`;
}

const unreadable = (release: boolean) =>
	`The server's answer could not be read as a conversation route: is it Provimux ${SESSION_ROUTE_SINCE} or newer?${release ? " Nothing was released." : ""}`;

/** A release that went out and whose answer did not come or could not be read. */
const unknownOutcome = (why: string) =>
	`The release was sent, but ${why}, so whether this conversation was released is not known. Check with /${ROUTE_COMMAND}.`;

/** What the server's error body says, in its own words; "" when it says nothing readable. */
function errorMessage(body: unknown): string {
	if (!isRecord(body)) return "";
	if (typeof body.error === "string") return body.error;
	if (isRecord(body.error) && typeof body.error.message === "string") return body.error.message;
	return "";
}

// --- The contract's answers, read leniently: a field or value this version does not know is ignored. -------------

export interface RouteRow {
	provider: string;
	kind: string;
	host?: string;
}

/** A bound account the model list no longer shows for the name (`{listed: false}`). */
export const UNLISTED = "unlisted" as const;
export type BoundRoute = RouteRow | typeof UNLISTED;

export interface ShowAnswer {
	observedAt: string;
	affinity: string;
	conversation: string;
	model: string;
	routedModel: string | null;
	binding: string | null;
	bound: {
		route: BoundRoute;
		since: string | null;
		origin: string;
		fellBackFrom: BoundRoute | null;
		fellBackAt: string | null;
	} | null;
	/** Null for an unlisted account: its rank is not known. */
	position: { belowFirst: boolean; higherPriorityFree: boolean; higherPriorityFreeAt: string | null } | null;
	/** The available routes of the highest priority. */
	first: RouteRow[];
	rule: { inEffect: boolean; coldAfterS: number | null };
	websocketMayHold: boolean;
	subagent: boolean;
}

export interface ReleaseAnswer {
	affinity: string;
	released: boolean;
	conversation: string;
	was: BoundRoute | null;
	next: RouteRow[];
	websocketMayHold: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const strOrNull = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

function parseRow(value: unknown): RouteRow | null {
	if (!isRecord(value) || typeof value.provider !== "string") return null;
	return {
		provider: value.provider,
		kind: typeof value.kind === "string" ? value.kind : "",
		...(typeof value.host === "string" && value.host ? { host: value.host } : {}),
	};
}

/** A route, or `{listed: false}`; null when it is neither. */
function parseBoundRoute(value: unknown): BoundRoute | null {
	if (isRecord(value) && value.listed === false) return UNLISTED;
	return parseRow(value);
}

const parseRows = (value: unknown): RouteRow[] =>
	Array.isArray(value) ? value.map(parseRow).filter((row): row is RouteRow => row !== null) : [];

/** A show answer (also the body of a 409); undefined when it is not one. */
export function parseShowAnswer(value: unknown): ShowAnswer | undefined {
	if (!isRecord(value)) return undefined;
	const observedAt = str(value.observed_at);
	const affinity = str(value.affinity);
	const conversation = str(value.conversation);
	if (!observedAt || !Number.isFinite(Date.parse(observedAt)) || !affinity || !conversation) return undefined;
	let bound: ShowAnswer["bound"] = null;
	if (isRecord(value.bound)) {
		const route = parseBoundRoute(value.bound.route);
		if (route) {
			bound = {
				route,
				since: strOrNull(value.bound.since),
				origin: str(value.bound.origin) ?? "not-known",
				fellBackFrom: parseBoundRoute(value.bound.fell_back_from),
				fellBackAt: strOrNull(value.bound.fell_back_at),
			};
		}
	}
	if (conversation === "bound" && affinity === "on" && !bound) return undefined;
	const position = isRecord(value.position)
		? {
				belowFirst: value.position.below_first === true,
				higherPriorityFree: value.position.higher_priority_free === true,
				higherPriorityFreeAt: strOrNull(value.position.higher_priority_free_at),
			}
		: null;
	const rule = isRecord(value.rule) ? value.rule : {};
	return {
		observedAt,
		affinity,
		conversation,
		model: str(value.model) ?? "",
		routedModel: strOrNull(value.routed_model),
		binding: strOrNull(value.binding),
		bound,
		position,
		first: parseRows(value.first),
		rule: {
			inEffect: rule.in_effect === true,
			coldAfterS: typeof rule.cold_after_s === "number" && rule.cold_after_s > 0 ? rule.cold_after_s : null,
		},
		websocketMayHold: value.websocket_may_hold === true,
		subagent: value.subagent === true,
	};
}

/** A release answer; undefined when it is not one. */
export function parseReleaseAnswer(value: unknown): ReleaseAnswer | undefined {
	if (!isRecord(value)) return undefined;
	const affinity = str(value.affinity);
	const conversation = str(value.conversation);
	if (!affinity || !conversation || typeof value.released !== "boolean") return undefined;
	return {
		affinity,
		released: value.released,
		conversation,
		was: parseBoundRoute(value.was),
		next: parseRows(value.next),
		websocketMayHold: value.websocket_may_hold === true,
	};
}

// --- Whether a release leads anywhere. --------------------------------------------------------------------------------

type Eligibility = "release" | "cooling" | "on-first" | "nowhere";

/**
 * "release": below a free higher-priority route, or on an account of unknown rank with a listed route to go to.
 * "cooling": below, and no higher-priority route is free. "on-first": nothing available ranks higher. "nowhere": an
 * account of unknown rank and no listed route.
 */
function releaseEligibility(answer: ShowAnswer): Eligibility {
	const position = answer.position;
	if (!position) return answer.first.length > 0 ? "release" : "nowhere";
	if (!position.belowFirst) return "on-first";
	return position.higherPriorityFree ? "release" : "cooling";
}

function notReleasedText(answer: ShowAnswer, eligibility: Eligibility, here: string, clock: Clock): string {
	if (eligibility === "cooling") {
		const at = answer.position?.higherPriorityFreeAt;
		const when = at
			? `One is expected free at ${ahead(at, clock)}: type /${ROUTE_COMMAND} release again then.`
			: `Provimux does not know when one will be: check again later with /${ROUTE_COMMAND}.`;
		return `Nothing was released: no higher-priority route is free yet, so the conversation stays on ${here}. ${when}`;
	}
	if (eligibility === "on-first")
		return `Nothing was released: this conversation is already on a first route (${here}).`;
	return `Nothing was released: this conversation is on ${here}, and Provimux lists no route to move it to now. Check again later with /${ROUTE_COMMAND}.`;
}

// --- Words. ---------------------------------------------------------------------------------------------------------

/** A route in the words of the model names and the footer: "Anthropic sub", "Devin sub", "OpenRouter api". */
export function routeLabel(row: BoundRoute): string {
	if (row === UNLISTED) return "an account that is no longer listed";
	return answerLabel({ provider: row.provider, kind: row.kind, ...(row.host ? { host: row.host } : {}) }).trim();
}

/** Several routes: each label once, with how many accounts share it, "or" between them: "2 Anthropic sub accounts". */
function routesLabel(rows: RouteRow[]): string {
	const counts = new Map<string, number>();
	for (const row of rows) counts.set(routeLabel(row), (counts.get(routeLabel(row)) ?? 0) + 1);
	return [...counts].map(([label, count]) => (count > 1 ? `${count} ${label} accounts` : label)).join(" or ");
}

/** Where a request goes: the route, or "one of" several. */
const destination = (rows: RouteRow[]) => (rows.length > 1 ? `one of ${routesLabel(rows)}` : routesLabel(rows));

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** A length of time in rounded words: "5 minutes", "1 hour 5 minutes", "under a minute". */
function durationWords(seconds: number): string {
	const minutes = Math.round(Math.max(0, seconds) / 60);
	if (minutes < 1) return "under a minute";
	if (minutes < 60) return plural(minutes, "minute");
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest === 0 ? plural(hours, "hour") : `${plural(hours, "hour")} ${plural(rest, "minute")}`;
}

/** A setting, exactly: "6 minutes", "1 hour", "90 seconds", "60.9 seconds". */
function exactDuration(seconds: number): string {
	if (seconds % 3600 === 0) return plural(seconds / 3600, "hour");
	if (seconds % 60 === 0) return plural(seconds / 60, "minute");
	return plural(seconds, "second");
}

interface Clock {
	/** The server's "now": the gateway's times are said relative to the answer's own observed_at. */
	now: number;
	/** The time zone times are written in; the machine's own unless a test gives one. */
	timeZone?: string;
}

function clockTime(iso: string, clock: Clock): string {
	const at = new Date(iso);
	const day = (date: Date) =>
		new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: clock.timeZone }).format(date);
	const time = new Intl.DateTimeFormat("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		timeZone: clock.timeZone,
	}).format(at);
	return day(at) === day(new Date(clock.now)) ? time : `${day(at)} ${time}`;
}

const secondsFrom = (iso: string, clock: Clock) => (Date.parse(iso) - clock.now) / 1000;
/** "09:35 (40 minutes ago)". */
const ago = (iso: string, clock: Clock) => `${clockTime(iso, clock)} (${durationWords(-secondsFrom(iso, clock))} ago)`;
/** "10:40 (in 25 minutes)". */
const ahead = (iso: string, clock: Clock) => `${clockTime(iso, clock)} (in ${durationWords(secondsFrom(iso, clock))})`;

/** The name asked about, and the model it is routed to where that differs. */
const nameOf = (answer: { model: string; routedModel?: string | null }, asked: string) => {
	const model = answer.model || asked;
	return answer.routedModel && answer.routedModel !== model ? `${model} (routed to ${answer.routedModel})` : model;
};

/** What a show or release says when nothing is bound: session affinity not running, or no binding. */
function unboundText(answer: { affinity: string; conversation: string }, model: string): string | undefined {
	switch (answer.affinity) {
		case "on":
			break;
		case "off":
			return "Provimux does not bind conversations to a route (its session affinity is off): every request already goes to the first available route, so there is nothing to move.";
		case "home":
			return "Provimux runs in Home mode: Home chooses the route of every request, so there is no binding here to show or move.";
		case "not-supported":
			return "A plugin chooses the routes on this Provimux, so there is no binding here to show or move.";
		default:
			return `Provimux says its session affinity is "${answer.affinity}", which this version of pi-provimux does not know: nothing to show.`;
	}
	if (answer.conversation === "not-seen")
		return `Provimux has no record of this conversation on ${model} from your key. Send a message, then type /${ROUTE_COMMAND} again.`;
	if (answer.conversation === "not-bound")
		return `This conversation is not bound to a route on ${model} right now: its next message goes to the first available route.`;
	if (answer.conversation !== "bound")
		return `Provimux says the conversation is "${answer.conversation}", which this version of pi-provimux does not know: nothing to show.`;
	return undefined;
}

/**
 * A show in full: the header line, then what it found, then what to type. The release is offered only where the
 * release would go ahead: in the TUI, for a binding with a token, where the release's own eligibility allows it.
 */
export function showText(answer: ShowAnswer, model: string, clock: Clock, tui: boolean): string {
	const name = nameOf(answer, model);
	const head = `Route of this conversation on ${name}, as Provimux says now (this check sends nothing to a model and costs nothing):`;
	const unbound = unboundText(answer, name);
	if (unbound !== undefined || !answer.bound) return `${head}\n${unbound}`;
	const { bound, position, first } = answer;
	const lines = [head];

	lines.push(
		bound.since
			? `• Now on: ${routeLabel(bound.route)}, since ${ago(bound.since, clock)}.`
			: `• Now on: ${routeLabel(bound.route)}.`,
	);
	if (bound.origin === "fallback") {
		const from = bound.fellBackFrom ? `: it was on ${routeLabel(bound.fellBackFrom)}` : "";
		const until = bound.fellBackFrom && bound.fellBackAt ? ` until ${clockTime(bound.fellBackAt, clock)}` : "";
		lines.push(`• A fallback${from}${until}.`);
	} else if (bound.origin === "first") {
		lines.push("• No fallback recorded for this binding.");
	} else {
		lines.push("• No history recorded for this binding.");
	}

	if (!position) {
		lines.push(
			first.length > 0
				? `• Provimux does not say where this account ranks. The first route now: ${destination(first)}.`
				: "• Provimux does not say where this account ranks.",
		);
	} else if (!position.belowFirst) {
		lines.push(
			first.length > 1
				? `• It is on a first route: no available route has a higher priority (${first.length} available at the top: ${routesLabel(first)}).`
				: "• It is on a first route: no available route has a higher priority.",
		);
	} else if (position.higherPriorityFree) {
		lines.push(`• A higher-priority route is free now: ${destination(first)}.`);
	} else if (position.higherPriorityFreeAt) {
		lines.push(
			`• No higher-priority route is free yet: one is expected free at ${ahead(position.higherPriorityFreeAt, clock)}.`,
		);
	} else {
		lines.push("• No higher-priority route is free yet, and Provimux does not know when one will be.");
	}

	lines.push(`• ${ruleText(answer.rule)}`);
	if (answer.subagent)
		lines.push("• This is a sub-agent's conversation: a release of its main conversation does not move it.");

	const eligibility = releaseEligibility(answer);
	if (tui && answer.binding && eligibility === "release")
		lines.push(`To move it now: /${ROUTE_COMMAND} release (it says what that may cost and asks first).`);
	if (eligibility === "cooling") lines.push(`To check again later: /${ROUTE_COMMAND}.`);
	return lines.join("\n");
}

/** The server's automatic return, as its policy: what it can do, not what it will. */
function ruleText(rule: ShowAnswer["rule"]): string {
	if (!rule.inEffect) return "Automatic return: off on this server.";
	const after = rule.coldAfterS ? ` for ${exactDuration(rule.coldAfterS)}` : "";
	return `Automatic return: on. Once no request of this conversation has been routed${after} (a keep-warm request counts), Provimux can send its next request to a free higher-priority route; a pinned Codex follow-up stays on its account.`;
}

// --- What a move may cost. --------------------------------------------------------------------------------------------

/** "about $0.55", or "less than $0.01". */
const money = (amount: number) => (amount < 0.01 ? "less than $0.01" : `about $${amount.toFixed(2)}`);

type PricedModel = Parameters<typeof calculateCost>[0];

/** What reading `tokens` of input costs at the model's price, as Pi prices it (its tier for that many tokens). */
function priceOf(model: PricedModel, tokens: number, cached: boolean): number {
	const usage = {
		input: cached ? 0 : tokens,
		output: 0,
		cacheRead: cached ? tokens : 0,
		cacheWrite: 0,
		totalTokens: tokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const cost = calculateCost(model, usage);
	return cached ? cost.cacheRead : cost.input;
}

/**
 * What moving a conversation may cost: its next message may read the whole conversation once without cache, as tokens
 * and, where Pi has the model's price, as an amount at list price; on a subscription, quota.
 */
export function costText(options: { tokens: number | null | undefined; model: PricedModel; to: RouteRow[] }): string {
	const { tokens, model, to } = options;
	const known = typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0;
	const priced = (model.cost?.input ?? 0) > 0;
	const read = known
		? `about ${Math.round(tokens).toLocaleString("en-US")} tokens${priced ? `, ${money(priceOf(model, tokens, false))} at the list price` : ""}`
		: "its size is not known until its next answer";
	const parts = [
		`Its next message may read the whole conversation once without cache (${read}; more where the vendor also charges for writing the new cache).`,
	];
	if (known && priced && (model.cost?.cacheRead ?? 0) > 0)
		parts.push(
			`Staying costs a cached read, ${money(priceOf(model, tokens, true))} a message, while the cache is warm.`,
		);
	if (!priced) parts.push("Pi has no price for this model, so no amount is given.");
	const subscriptions = to.filter((row) => row.kind === "oauth");
	if (subscriptions.length > 0) {
		const where =
			subscriptions.length === to.length ? [...new Set(to.map(routeLabel))].join(" or ") : "a subscription route";
		parts.push(
			`On ${where} this is quota of the subscription, not money${priced ? ": the amounts are at API list price, for comparison" : ""}.`,
		);
	}
	return parts.join(" ");
}
