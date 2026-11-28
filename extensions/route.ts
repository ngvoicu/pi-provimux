/**
 * `/provimux-route`: which of the server's routes this conversation is bound to, and moving it back to its first route.
 *
 * With `routing.session-affinity` on, Provimux binds a conversation to the account that served it and keeps it there,
 * also after a higher-priority account is free again. Provimux (from the version in SESSION_ROUTE_SINCE) shows that
 * binding and removes it through two requests of its own, named by the session header the conversation's turns carry:
 *
 * - `POST /v1/provimux/session-route`: where the conversation is bound, since when, whether that is a fallback, whether
 *   a higher-priority route is free (or when it is expected free), and what Provimux does by itself (in this release:
 *   nothing). It changes nothing and sends nothing to a model. It says nothing of the cache.
 * - `POST /v1/provimux/session-route/release`: removes the binding (only while it is the one the check saw: `expect`).
 *   The conversation's next request goes to the first available route by priority.
 *
 * Whether the conversation's cache may still be warm is Pi's own knowledge (last-use.ts): when this session last sent a
 * request, and how long Pi takes the model's cache to live. Only when Pi knows the cache is cold is a release made
 * without a yes; otherwise the command says what the move costs (one read of the whole conversation without cache) and
 * asks; outside the TUI the yes is the argument `yes`. Right after a release the conversation's Codex WebSocket is
 * closed, before any further turn: a turn on a socket that stays open is pinned to its login, and Provimux binds the
 * conversation to it again.
 */
import { getPromptCacheTtlMs } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type CacheUse, lastCacheUse } from "./last-use.ts";
import { ANTHROPIC_MESSAGES_API, resolveConnection, resolveEndpoints } from "./lib.ts";
import { answerLabel } from "./sources.ts";

export const ROUTE_COMMAND = "provimux-route";
/** The first Provimux version with the two requests. Filled in at release. */
export const SESSION_ROUTE_SINCE = "<version>";
const REQUEST_TIMEOUT_MS = 10_000;
/** How often a release is tried again after the binding changed between the check and the release (HTTP 409). */
const MAX_MOVED_RETRIES = 2;
/** Pi's limit on a Codex-format session id (pi-ai's clampOpenAIPromptCacheKey). */
const CODEX_SESSION_ID_MAX = 64;
/** A cache is taken as cold only this long after its lifetime ended, as Provimux's own design reckons it. */
const COLD_MARGIN_MS = 60_000;
/** Before saying "not seen" for a session that has sent requests: one more check after this pause. */
export const NOT_SEEN_RETRY_MS = 1_500;

// --- The contract's answers, read leniently: a field or value this version does not know is ignored. -------------

export interface RouteRow {
	provider: string;
	kind: string;
	priority: number;
	host?: string;
	account?: string;
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
	position: { belowFirst: boolean; higherPriorityFree: boolean; higherPriorityFreeAt: string | null } | null;
	first: RouteRow[];
	rule: { inEffect: boolean; coldAfterS: number | null };
	websocketMayHold: boolean;
	subagent: boolean;
}

export interface ReleaseAnswer {
	observedAt: string;
	affinity: string;
	released: boolean;
	conversation: string;
	model: string;
	routedModel: string | null;
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
		priority: typeof value.priority === "number" ? value.priority : 0,
		...(typeof value.host === "string" && value.host ? { host: value.host } : {}),
		...(typeof value.account === "string" && value.account ? { account: value.account } : {}),
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
	if (!observedAt || !affinity || !conversation) return undefined;
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
	const position = isRecord(value.position)
		? {
				belowFirst: value.position.below_first === true,
				higherPriorityFree: value.position.higher_priority_free === true,
				higherPriorityFreeAt: strOrNull(value.position.higher_priority_free_at),
			}
		: null;
	const rule = isRecord(value.rule)
		? {
				inEffect: value.rule.in_effect === true,
				coldAfterS:
					typeof value.rule.cold_after_s === "number" && value.rule.cold_after_s > 0
						? value.rule.cold_after_s
						: null,
			}
		: { inEffect: false, coldAfterS: null };
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
		rule,
		websocketMayHold: value.websocket_may_hold === true,
		subagent: value.subagent === true,
	};
}

/** A release answer; undefined when it is not one. */
export function parseReleaseAnswer(value: unknown): ReleaseAnswer | undefined {
	if (!isRecord(value)) return undefined;
	const observedAt = str(value.observed_at);
	const conversation = str(value.conversation);
	if (!observedAt || !conversation || typeof value.released !== "boolean") return undefined;
	return {
		observedAt,
		// A release answer without it comes from an early build of the path, before the field was added: read as "on".
		affinity: str(value.affinity) ?? "on",
		released: value.released,
		conversation,
		model: str(value.model) ?? "",
		routedModel: strOrNull(value.routed_model),
		was: parseBoundRoute(value.was),
		next: parseRows(value.next),
		websocketMayHold: value.websocket_may_hold === true,
	};
}

/** `expect` is the show's token as it came, when it is one: a non-empty string without spaces. Else none is sent. */
export function expectToken(binding: string | null): string | undefined {
	return binding && /^\S+$/.test(binding) ? binding : undefined;
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

/** A length of time in words: "5 minutes", "1 hour", "1 hour 5 minutes", "under a minute". */
export function durationWords(seconds: number): string {
	const minutes = Math.round(Math.max(0, seconds) / 60);
	if (minutes < 1) return "under a minute";
	if (minutes < 60) return plural(minutes, "minute");
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest === 0 ? plural(hours, "hour") : `${plural(hours, "hour")} ${plural(rest, "minute")}`;
}

export interface Clock {
	/** The server's "now": the gateway's times are said relative to the answer's own observed_at, not this machine's clock. */
	now: number;
	/** The time zone times are written in; the machine's own unless a test gives one. */
	timeZone?: string;
}

function clockTime(iso: string, clock: Clock): string {
	const at = new Date(iso);
	const options: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
	const day = (date: Date) =>
		new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: clock.timeZone }).format(date);
	const time = new Intl.DateTimeFormat("en-GB", { ...options, timeZone: clock.timeZone }).format(at);
	return day(at) === day(new Date(clock.now)) ? time : `${day(at)} ${time}`;
}

const secondsFrom = (iso: string, clock: Clock) => (Date.parse(iso) - clock.now) / 1000;

/** "09:35 (40 minutes ago)". */
const ago = (iso: string, clock: Clock) => `${clockTime(iso, clock)} (${durationWords(-secondsFrom(iso, clock))} ago)`;
/** "10:40 (in 25 minutes)". */
const ahead = (iso: string, clock: Clock) => `${clockTime(iso, clock)} (in ${durationWords(secondsFrom(iso, clock))})`;

const NO_COST = "this check sends nothing to a model and costs nothing";

// --- The cache, as Pi knows it. ---------------------------------------------------------------------------------------

/** What Pi knows of the conversation's cache: its lifetime (if any), and when the session last used it (if ever). */
export interface CacheView {
	/** How long Pi takes the cache to live, ms; undefined: not known. */
	ttlMs?: number;
	/** How long ago the session last sent a request, ms; undefined: Pi has none to go by. */
	sinceMs?: number;
}

/** Cold only when Pi knows both, and the lifetime (plus a minute) has passed. */
export const knownCold = (cache: CacheView) =>
	cache.ttlMs !== undefined && cache.sinceMs !== undefined && cache.sinceMs > cache.ttlMs + COLD_MARGIN_MS;

/** How much longer the cache may be warm, in seconds; undefined when Pi cannot say. */
const warmFor = (cache: CacheView) =>
	cache.ttlMs !== undefined && cache.sinceMs !== undefined
		? Math.max(0, (cache.ttlMs - cache.sinceMs) / 1000)
		: undefined;

/** The cache line: which of the two it is, and on what Pi goes. */
export function cacheText(cache: CacheView): string {
	const last = cache.sinceMs === undefined ? undefined : `last answer ${durationWords(cache.sinceMs / 1000)} ago`;
	if (cache.ttlMs === undefined)
		return last
			? `Pi does not know how long this cache lasts (${last}), so it may still be warm.`
			: "Pi does not know how long this cache lasts, so it may still be warm.";
	const lasts = `Pi knows this cache lasts ${durationWords(cache.ttlMs / 1000)}`;
	if (!last) return `${lasts}, but has no answer of this session to go by, so it may still be warm.`;
	if (knownCold(cache)) return `${lasts}; ${last}: it is cold.`;
	const remaining = warmFor(cache) ?? 0;
	return remaining > 0
		? `${lasts}; ${last}: it may be warm for about ${durationWords(remaining)} more.`
		: `${lasts}; ${last}: it is about to go cold.`;
}

/**
 * What Pi knows of a session's cache: the later of the last request this process noted for it (with the lifetime Pi
 * took for that request) and the session's last answer (with the lifetime of the model as it is now).
 */
export function cacheViewOf(options: {
	noted: CacheUse | undefined;
	lastAnswerAt: number | undefined;
	modelTtlMs: number | undefined;
	now: number;
}): CacheView {
	const { noted, lastAnswerAt, modelTtlMs, now } = options;
	const at = Math.max(noted?.at ?? Number.NEGATIVE_INFINITY, lastAnswerAt ?? Number.NEGATIVE_INFINITY);
	const ttlMs = noted && noted.at >= (lastAnswerAt ?? 0) ? (noted.ttlMs ?? modelTtlMs) : modelTtlMs;
	return {
		...(ttlMs !== undefined ? { ttlMs } : {}),
		...(Number.isFinite(at) ? { sinceMs: Math.max(0, now - at) } : {}),
	};
}

// --- Texts. ---------------------------------------------------------------------------------------------------------

/** The name asked about, and the model it is routed to where that differs. */
const nameOf = (answer: { model: string; routedModel: string | null }, asked: string) => {
	const model = answer.model || asked;
	return answer.routedModel && answer.routedModel !== model ? `${model} (routed to ${answer.routedModel})` : model;
};

/** What a show says when nothing is bound: session affinity not running, or no binding for this conversation. */
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
		return `Provimux has no record of this conversation on ${model} from your key: it has seen no message of it since it started, or it has forgotten it since its binding expired. Send a message, then type /${ROUTE_COMMAND} again.`;
	if (answer.conversation === "not-bound")
		return `This conversation is not bound to a route on ${model} right now (it was released, or its binding expired): its next message goes to the first available route.`;
	if (answer.conversation !== "bound")
		return `Provimux says the conversation is "${answer.conversation}", which this version of pi-provimux does not know: nothing to show.`;
	return undefined;
}

/** The lines of a show for a bound conversation, in the order the user reads them. */
export function describeBound(answer: ShowAnswer, clock: Clock, cache: CacheView): string[] {
	const bound = answer.bound!;
	const here = routeLabel(bound.route);
	const lines: string[] = [];
	lines.push(
		bound.since
			? `• Now on: ${here}, since ${ago(bound.since, clock)}.`
			: `• Now on: ${here} (since when is not known: Provimux restarted after this conversation's last answer).`,
	);
	if (bound.origin === "fallback" && bound.fellBackFrom) {
		const when = bound.fellBackAt ? `, until ${clockTime(bound.fellBackAt, clock)}` : "";
		lines.push(`• A fallback: ${routeLabel(bound.fellBackFrom)} answered it before${when}.`);
	} else if (bound.origin === "first") {
		lines.push("• Not a fallback: no other route has answered it.");
	} else {
		lines.push("• Whether it fell back is not known: Provimux restarted since this conversation began.");
	}

	const position = answer.position;
	const route = bound.route;
	if (route === UNLISTED || !position) {
		lines.push(
			answer.first.length > 0
				? `• The first route now: ${destination(answer.first)}. Provimux does not say where the account it is on stands.`
				: "• Provimux does not say where the account it is on stands.",
		);
	} else if (position.belowFirst) {
		const firstName =
			bound.fellBackFrom && bound.fellBackFrom !== UNLISTED
				? `The first route, ${routeLabel(bound.fellBackFrom)},`
				: "A route with a higher priority";
		if (position.higherPriorityFree) {
			const free = answer.first.filter((row) => row.priority > route.priority);
			lines.push(`• The first route, ${destination(free.length > 0 ? free : answer.first)}, is free now.`);
		} else if (position.higherPriorityFreeAt) {
			lines.push(`• ${firstName} is not free yet: expected free at ${ahead(position.higherPriorityFreeAt, clock)}.`);
		} else {
			lines.push(`• ${firstName} is not free yet, and Provimux does not know when it will be.`);
		}
	} else if (answer.first.length > 1) {
		lines.push(
			`• It is on a first route: ${answer.first.length} routes share the top priority (${routesLabel(answer.first)}). A release lets Provimux choose among them again, and it may choose the same one.`,
		);
	} else {
		lines.push("• It is on the first route: no route has a higher priority.");
	}

	lines.push(`• Its cache: ${cacheText(cache)}`);
	lines.push(`• ${ruleText(answer)}`);
	if (answer.subagent)
		lines.push("• This is a sub-agent's conversation: a release of its main conversation does not move it.");
	return lines;
}

/** What Provimux does by itself. This release: never. A later one fills `rule` (`cold_after_s`). */
function ruleText(answer: ShowAnswer): string {
	if (!answer.rule.inEffect) return "By itself: Provimux never moves it back; only a release does.";
	const after = answer.rule.coldAfterS
		? ` once this conversation has been unused for ${durationWords(answer.rule.coldAfterS)}`
		: "";
	return answer.position?.belowFirst
		? `By itself: Provimux moves it back at your next message${after}, if a higher-priority route is free then.`
		: "By itself: nothing to do, it is on a first route.";
}

/** Whether a release can lead somewhere better: below a free first route, among several first routes, or unlisted. */
function releasable(answer: ShowAnswer): boolean {
	if (!answer.bound) return false;
	if (answer.bound.route === UNLISTED || !answer.position) return answer.first.length > 0;
	if (answer.position.belowFirst) return answer.position.higherPriorityFree;
	return answer.first.length > 1;
}

/** A show answer in full: the header line (said once: the check costs nothing), then what it found, then what to type. */
export function showText(answer: ShowAnswer, model: string, clock: Clock, cache: CacheView, withHint = true): string {
	const name = nameOf(answer, model);
	const head = `Route of this conversation on ${name}, as Provimux says now (${NO_COST}):`;
	const unbound = unboundText(answer, name);
	if (unbound !== undefined || !answer.bound) return `${head}\n${unbound ?? "Provimux says nothing is bound."}`;
	const lines = describeBound(answer, clock, cache);
	const position = answer.position;
	const hint =
		answer.bound.route === UNLISTED || !position
			? answer.first.length > 0
				? `To move it to a listed route now: /${ROUTE_COMMAND} release (it asks first unless Pi knows the cache is cold).`
				: undefined
			: position.belowFirst
				? position.higherPriorityFree
					? `To move it back now: /${ROUTE_COMMAND} release (it asks first unless Pi knows the cache is cold).`
					: `To check again later: /${ROUTE_COMMAND} (it asks Provimux afresh every time).`
				: answer.first.length > 1
					? `To let Provimux choose again: /${ROUTE_COMMAND} release (it asks first unless Pi knows the cache is cold).`
					: undefined;
	return [head, ...lines, ...(hint && withHint ? [hint] : [])].join("\n");
}

// --- What a move costs. -----------------------------------------------------------------------------------------------

export interface ModelPrice {
	/** $ per million input tokens, as pi holds the model's price; 0 or absent: not known. */
	input?: number;
	cacheRead?: number;
}

/** "about $0.55", or "less than $0.01". */
const money = (amount: number) => (amount < 0.01 ? "less than $0.01" : `about $${amount.toFixed(2)}`);

/**
 * What moving a conversation whose cache may be warm costs: one read of the whole conversation without cache, as
 * tokens and, where pi has the model's input price, as an amount at list price; on a subscription, quota. Then what Pi
 * knows of the cache.
 */
export function costText(options: {
	tokens: number | null | undefined;
	price: ModelPrice | undefined;
	cache: CacheView;
	to: RouteRow[];
}): string {
	const { tokens, price, cache, to } = options;
	const known = typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0;
	const input = price?.input && price.input > 0 ? price.input : undefined;
	const read = known
		? `about ${Math.round(tokens).toLocaleString("en-US")} tokens${input ? `, ${money((tokens * input) / 1e6)} at the list price` : ""}`
		: "its size is not known until its next answer";
	const parts = [
		`Moving now costs one read of the whole conversation without cache (${read}; more where the vendor also charges for writing the new cache).`,
	];
	if (known && input && price?.cacheRead && price.cacheRead > 0) {
		parts.push(
			`Staying costs a cached read, ${money((tokens * price.cacheRead) / 1e6)} a message, while the cache is warm.`,
		);
	}
	parts.push(cacheText(cache));
	if (!input) parts.push("Pi has no price for this model, so no amount is given.");
	const subscriptions = to.filter((row) => row.kind === "oauth");
	if (subscriptions.length > 0) {
		const labels = [...new Set(to.map(routeLabel))].join(" or ");
		const where = subscriptions.length === to.length ? labels : "a subscription route";
		parts.push(
			`On ${where} this is quota of the subscription, not money${input ? ": the amounts are at API list price, for comparison" : ""}.`,
		);
	}
	return parts.join(" ");
}

// --- The command. -----------------------------------------------------------------------------------------------------

type Fetch = typeof fetch;

export interface RouteCommandOptions {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	providerName: string;
	/** Closes the Codex WebSockets of a session (the patched module's); absent when the Codex stream did not load. */
	closeWebSocketSessions?: (sessionId: string) => void;
	/** For tests: the fetch the two requests use, the time zone times are written in, this machine's clock, a pause. */
	fetch?: Fetch;
	timeZone?: string;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	lastUse?: (sessionId: string) => CacheUse | undefined;
}

type Reply = { kind: "answer"; status: number; body: unknown } | { kind: "unreachable"; message: string };

const USAGE = `/${ROUTE_COMMAND} takes nothing (show where this conversation is), or release (move it back to its first route).`;

/** What the server's error body says, in its own words; "" when it says nothing readable. */
function errorMessage(body: unknown): string {
	if (!isRecord(body)) return "";
	if (typeof body.error === "string") return body.error;
	if (isRecord(body.error) && typeof body.error.message === "string") return body.error.message;
	return "";
}

/** The time of the session's last answer of this provider, from its entries (ms); undefined when it has none. */
function lastAnswerAt(ctx: ExtensionCommandContext, providerId: string): number | undefined {
	try {
		const entries = ctx.sessionManager.getEntries() as unknown as Array<{
			type?: string;
			message?: { role?: string; provider?: string; timestamp?: number };
		}>;
		for (let index = entries.length - 1; index >= 0; index--) {
			const message = entries[index]?.message;
			if (entries[index]?.type !== "message" || message?.role !== "assistant") continue;
			if (message.provider !== undefined && message.provider !== providerId) continue;
			return typeof message.timestamp === "number" ? message.timestamp : undefined;
		}
	} catch {
		// No entries to go by.
	}
	return undefined;
}

/** The same account, by its marker where both have one, else by its label and priority. */
function sameAccount(a: BoundRoute | null, b: BoundRoute | null): boolean {
	if (!a || !b || a === UNLISTED || b === UNLISTED) return false;
	if (a.account && b.account) return a.account === b.account;
	return routeLabel(a) === routeLabel(b) && a.priority === b.priority;
}

export function registerRouteCommand(options: RouteCommandOptions): void {
	const { pi, agentDir, providerId, providerName, closeWebSocketSessions, timeZone } = options;
	const doFetch: Fetch = options.fetch ?? ((...args) => fetch(...args));
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const lastUse = options.lastUse ?? lastCacheUse;

	const send = async (url: string, apiKey: string, header: Record<string, string>, body: unknown): Promise<Reply> => {
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
	};

	/** An answer that is not the contract's 200 (or 409 on release), in words that say what to do next. */
	const failureText = (reply: Reply, url: string, release: boolean): string => {
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
	};

	const unreadable = (release: boolean) =>
		`The server's answer could not be read as a conversation route: is it Provimux ${SESSION_ROUTE_SINCE} or newer?${release ? " Nothing was released." : ""}`;

	const handler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
		const release = words[0] === "release";
		const yes = release && words[1] === "yes";
		if ((words.length > 0 && !release) || words.length > 2 || (words.length === 2 && !yes)) {
			ctx.ui.notify(USAGE, "error");
			return;
		}

		const connection = resolveConnection(agentDir, providerId);
		if (!connection) {
			ctx.ui.notify(
				`${providerName} is not set up yet, so there is no conversation route to show. Type /login ${providerName} (or /login ${providerId}) and enter your server's address and key.`,
				"error",
			);
			return;
		}
		const model = ctx.model;
		if (!model || model.provider !== providerId) {
			const current = model ? `the current model is ${model.provider}/${model.id}` : "no model is selected";
			ctx.ui.notify(
				`/${ROUTE_COMMAND} shows the route of a ${providerName} model, and ${current}. Choose a ${providerName} model in /model, then type /${ROUTE_COMMAND} again.`,
				"error",
			);
			return;
		}
		const rawSessionId = ctx.sessionManager.getSessionId();
		const sessionId = typeof rawSessionId === "string" ? rawSessionId.trim() : "";
		if (!sessionId) {
			ctx.ui.notify(
				`This session has no id yet, so ${providerName} cannot tell which conversation it is. Send a message first.`,
				"error",
			);
			return;
		}

		// Named exactly as this model's turns name the conversation: pi's Claude format sends x-session-affinity, its
		// Codex format session-id (clamped as pi clamps it).
		const claudeFormat = model.api === ANTHROPIC_MESSAGES_API;
		const header: Record<string, string> = claudeFormat
			? { "x-session-affinity": sessionId }
			: { "session-id": Array.from(sessionId).slice(0, CODEX_SESSION_ID_MAX).join("") };
		// The server's root, where /v1/messages is too.
		const root = resolveEndpoints(connection.baseUrlInput).messagesBaseUrl;
		const showUrl = `${root}/v1/provimux/session-route`;
		const releaseUrl = `${root}/v1/provimux/session-route/release`;
		const clockOf = (observedAt: string): Clock => ({
			now: Number.isFinite(Date.parse(observedAt)) ? Date.parse(observedAt) : now(),
			timeZone,
		});
		/** Read afresh each time: a request may have gone out meanwhile. */
		const cacheNow = (): CacheView => {
			let modelTtlMs: number | undefined;
			try {
				modelTtlMs = getPromptCacheTtlMs(model, undefined);
			} catch {
				modelTtlMs = undefined;
			}
			return cacheViewOf({
				noted: lastUse(sessionId),
				lastAnswerAt: lastAnswerAt(ctx, providerId),
				modelTtlMs,
				now: now(),
			});
		};

		const show = async (): Promise<{ answer: ShowAnswer } | { failed: string }> => {
			let reply = await send(showUrl, connection.apiKey, header, { model: model.id });
			for (let again = true; ; again = false) {
				if (reply.kind !== "answer" || reply.status !== 200)
					return { failed: failureText(reply, showUrl, release) };
				const answer = parseShowAnswer(reply.body);
				if (!answer) return { failed: unreadable(release) };
				// A turn that ended this instant may not be recorded yet: one more look before "not seen", for a session
				// that has sent requests.
				const sent = lastUse(sessionId) !== undefined || lastAnswerAt(ctx, providerId) !== undefined;
				if (answer.affinity !== "on" || answer.conversation !== "not-seen" || !again || !sent) return { answer };
				await sleep(NOT_SEEN_RETRY_MS);
				reply = await send(showUrl, connection.apiKey, header, { model: model.id });
			}
		};

		const first = await show();
		if ("failed" in first) {
			ctx.ui.notify(first.failed, "error");
			return;
		}
		let shown = first.answer;

		if (!release) {
			ctx.ui.notify(showText(shown, model.id, clockOf(shown.observedAt), cacheNow()), "info");
			return;
		}

		/** Releases the binding a show saw: with its token as `expect` where it has a well-formed one. */
		const releaseOnce = (answer: ShowAnswer) => {
			const expect = expectToken(answer.binding);
			return send(releaseUrl, connection.apiKey, header, { model: model.id, ...(expect ? { expect } : {}) });
		};

		// The TUI asks in a dialog; RPC, JSON and print mode take the yes as the argument.
		const asks = ctx.hasUI && (ctx.mode === undefined || ctx.mode === "tui");
		for (let attempt = 0; ; attempt++) {
			const clock = clockOf(shown.observedAt);
			const name = nameOf(shown, model.id);
			const unbound = unboundText(shown, name);
			if (unbound !== undefined || !shown.bound) {
				ctx.ui.notify(`${unbound ?? "Provimux says nothing is bound."} Nothing was released.`, "info");
				return;
			}
			const bound = shown.bound;
			const here = routeLabel(bound.route);
			const position = shown.position;

			if (!releasable(shown)) {
				if (position?.belowFirst && !position.higherPriorityFree) {
					// The first route is not free: nothing to gain, nothing released.
					const firstName =
						bound.fellBackFrom && bound.fellBackFrom !== UNLISTED
							? `the first route, ${routeLabel(bound.fellBackFrom)},`
							: "a route with a higher priority";
					const when = position.higherPriorityFreeAt
						? `It is expected free at ${ahead(position.higherPriorityFreeAt, clock)}: type /${ROUTE_COMMAND} release again then.`
						: `Provimux does not know when it will be: check again later with /${ROUTE_COMMAND}.`;
					ctx.ui.notify(
						`Nothing was released: ${firstName} is not free yet, so the conversation stays on ${here}. ${when}`,
						"warning",
					);
				} else if (bound.route === UNLISTED || !position) {
					ctx.ui.notify(
						`Nothing was released: this conversation is on ${here}, and Provimux lists no route to move it to now. Check again later with /${ROUTE_COMMAND}.`,
						"warning",
					);
				} else {
					// Already on the only first route: there is nowhere else to go.
					ctx.ui.notify(
						`Nothing was released: this conversation is already on the first route (${here}), and no other route shares its priority.`,
						"info",
					);
				}
				return;
			}

			const boundRoute = bound.route;
			const target =
				position?.belowFirst && boundRoute !== UNLISTED
					? shown.first.filter((row) => row.priority > boundRoute.priority)
					: shown.first;
			const to = target.length > 0 ? target : shown.first;
			const choosing = !!position && !position.belowFirst && boundRoute !== UNLISTED;
			const sameAgain = choosing
				? ` It is already on a first route: Provimux chooses among the ${to.length} routes of the top priority again, and may choose the same one.`
				: "";
			const cache = cacheNow();
			const cold = knownCold(cache);
			if (!cold) {
				const cost = costText({ tokens: ctx.getContextUsage()?.tokens, price: model.cost, cache, to });
				if (asks) {
					const ok = await ctx.ui.confirm(
						choosing
							? "Let Provimux choose this conversation's route again now?"
							: `Move this conversation from ${here} to ${destination(to)} now?`,
						`${cost}${sameAgain}`,
					);
					if (!ok) {
						ctx.ui.notify(`Nothing was released: the conversation stays on ${here}, with its cache.`, "info");
						return;
					}
				} else if (!yes) {
					ctx.ui.notify(
						`${cost}${sameAgain}\nNothing was released. To move it from ${here} to ${destination(to)} anyway, type /${ROUTE_COMMAND} release yes.`,
						"warning",
					);
					return;
				}
			}

			const releaseReply = await releaseOnce(shown);
			if (releaseReply.kind === "answer" && releaseReply.status === 409) {
				const changed = parseShowAnswer(releaseReply.body);
				if (!changed) {
					ctx.ui.notify(
						`The conversation's binding changed since the check, so nothing was released. ${unreadable(false)}`,
						"warning",
					);
					return;
				}
				const moved = "The conversation's binding changed since the check, so nothing was released yet.";
				const state = showText(changed, model.id, clockOf(changed.observedAt), cacheNow(), false);
				// A yes given outside the TUI was for the state it was shown: the new state needs its own.
				if (!asks || attempt >= MAX_MOVED_RETRIES) {
					ctx.ui.notify(
						`${moved}\n${state}\nType /${ROUTE_COMMAND} release again to release it as it is now.`,
						"warning",
					);
					return;
				}
				ctx.ui.notify(`${moved}\n${state}`, "info");
				shown = changed;
				continue;
			}
			if (releaseReply.kind !== "answer" || releaseReply.status !== 200) {
				ctx.ui.notify(failureText(releaseReply, releaseUrl, true), "error");
				return;
			}
			const released = parseReleaseAnswer(releaseReply.body);
			if (!released) {
				ctx.ui.notify(unreadable(true), "error");
				return;
			}
			if (!released.released) {
				const why = unboundText(released, name);
				ctx.ui.notify(
					released.affinity === "on" && released.conversation === "not-bound"
						? "Nothing was released: the conversation was no longer bound (its binding expired or was released meanwhile). Its next message goes to the first available route."
						: `${why ?? "Provimux released nothing."} Nothing was released.`,
					"info",
				);
				return;
			}

			// Right after the release, before any further turn: a Codex WebSocket left open would bind the conversation to
			// its login again. Closing is harmless where there is none, so it is done whatever header named the conversation.
			const onSocket = released.websocketMayHold || shown.websocketMayHold || !claudeFormat;
			let socket = "";
			let closed = false;
			if (closeWebSocketSessions) {
				try {
					closeWebSocketSessions(sessionId);
					closed = true;
					if (onSocket) socket = " Its Codex WebSocket, if one was open, was closed, so that the release holds.";
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (onSocket)
						socket = ` Closing its Codex WebSocket failed (${message}): its next turn may bind it to ${here} again; type /${ROUTE_COMMAND} after that turn to check.`;
				}
			}
			// A turn that slipped in on the old socket before it closed binds the conversation there again: release that
			// binding too, now that the socket is closed. Once.
			if (onSocket && closed) {
				const after = await show();
				const back = "answer" in after && after.answer.conversation === "bound" ? after.answer : undefined;
				if (back?.bound && sameAccount(back.bound.route, released.was)) {
					const again = await releaseOnce(back);
					try {
						closeWebSocketSessions?.(sessionId);
					} catch {
						// Said above when it fails.
					}
					const ok =
						again.kind === "answer" && again.status === 200 && parseReleaseAnswer(again.body)?.released === true;
					socket += ok
						? " A turn had bound it to the old account again on the open socket: it was released again."
						: ` A turn had bound it to the old account again on the open socket, and releasing it again did not succeed: type /${ROUTE_COMMAND} to check.`;
				}
			}
			const next = released.next.length > 0 ? released.next : to;
			const was = released.was ? routeLabel(released.was) : here;
			const price = cold
				? "Pi knows the cache was cold, so the move costs nothing extra."
				: "That message reads the whole conversation once without cache.";
			ctx.ui.notify(
				`Released: this conversation is no longer bound to ${was}. Its next message goes to ${destination(next)}. ${price}${socket}`,
				"info",
			);
			return;
		}
	};

	pi.registerCommand(ROUTE_COMMAND, {
		description:
			"Show which account this conversation is on and whether its first route is free, or move it back there with /provimux-route release",
		getArgumentCompletions: (prefix: string) =>
			"release".startsWith(prefix.trim().toLowerCase()) ? [{ value: "release", label: "release" }] : null,
		handler,
	});
}
