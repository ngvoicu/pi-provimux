/**
 * Where each CLIProxyAPI model really comes from, told to other extensions.
 *
 * Through CLIProxyAPI pi sees one provider, but a model can be served by a subscription login or an API key, and the
 * two can differ in window, prompt-cache lifetime and price (a Claude login keeps a cache for an hour, a Claude API key
 * for 5 minutes by default). A CLIProxyAPI that lists its credentials (`/v1/models?include=accounts`) says which serve
 * each model; every response names the kind that answered (`X-CPA-AUTH-KIND`) and, from a CLIProxyAPI that says it,
 * the credential's provider (`X-CPA-AUTH-PROVIDER`) and an API key's host (`X-CPA-AUTH-HOST`).
 *
 * This file turns that into the `model-upstreams` events other extensions read (pi-cache-keeper fills windows,
 * lifetimes and prices from providers.dev with them):
 *
 * - `model-upstreams:request` (sent by an extension that wants them): CLIProxyAPI is asked, and the answer follows.
 * - `model-upstreams`: `{ provider, models: { [id]: { upstreams, fallbacks? } } }`, after a request and, once one came,
 *   after `/provimux-refresh`. `upstreams` are what may serve the model (several: not known which), `fallbacks` what may
 *   answer when those fail.
 * - `model-upstreams:answered`: `{ provider, model, upstreams }`, once per answer, while the request is out. Over HTTP
 *   and SSE only the response headers (`X-CPA-AUTH-*`) count; over the Codex WebSocket, which has no headers per turn,
 *   only the `cpa_auth_*` fields the proxy puts on response.created. When the answer gives the kind and the provider
 *   (Provimux 8.1.1-pmx.1 or newer): the credential it names, from the response alone. An answer that names nobody,
 *   from a proxy that names answers (one that lists its credentials, or named an answer before): `upstreams: []`,
 *   answered by something the proxy would not name. A proxy that names no answer (plain CLIProxyAPI): nothing.
 *
 * Requests overlap (pi's cache warmer next to the turn it warms, an extension's own call with the session's callbacks),
 * and pi's events say nothing of which request they belong to. So what a request's answer says is kept by that request
 * alone: each call of the provider's stream gets its own callbacks (`answeredOptions`), which hold its headers and its
 * one report, and mark the stream event it is told with. The session's handler only reads that mark. They also keep
 * what the answer said with the message the request ends with (`answerOf`), for the footer (answered-footer.ts).
 *
 * An upstream is `{ provider, model?, subscription? }`: the pi provider the model would come from if used directly
 * (anthropic, openai-codex, openai, meta, openrouter, google) or a providers.dev provider pi has none for (devin,
 * antigravity); the model's id there when it differs; a subscription login (true) or an API key (false).
 *
 * From a Provimux that gives prices and cache lifetimes per providers.dev entry (figures.ts), and only from one:
 * - `model-upstreams:answered-entry` (ENTRY_EVENT) is told just before an answer's `model-upstreams:answered`, with the
 *   entry the answer names (`X-Provimux-Entry`, `provimux_entry`; `null` where it names its account and no entry) and
 *   its account's marker. `model-upstreams:answered` itself is unchanged.
 * - `model-upstreams` also carries `figures`: the gateway's figures object (its `state`, `dataset_version`,
 *   `generated_at`, `fetched_at`, and `entries`: entry → price, cache, input_window, max_output, as the gateway gives
 *   them). Where a later list read brings other figures (an answer named an entry not held), the event is told again
 *   with the routes last told, unchanged, and the new figures: routes are read only when told, as 105.0.8 reads them.
 * Readers that know none of this (pi-cache-keeper 0.10.8) read the routes and the answers as before.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decodeWireValue, type GatewayList, handOnFigures, type ListedSources } from "./figures.ts";
import { noteCacheUse } from "./last-use.ts";
import { resolveEndpoints } from "./lib.ts";
import { type Account, likelyAccounts, own, parseAccounts } from "./sources.ts";

export { type Account, likelyAccounts } from "./sources.ts";

export const REQUEST_EVENT = "model-upstreams:request";
export const UPSTREAMS_EVENT = "model-upstreams";
export const ANSWERED_EVENT = "model-upstreams:answered";
/**
 * From a Provimux with figures: the providers.dev entry of an answer and its account's marker, told just before that
 * answer's `model-upstreams:answered` (`{ provider, model, entry, account? }`, `entry` null where the answer named its
 * account and no entry). An event of its own, so `model-upstreams:answered` stays as it was for readers that know none
 * of it.
 */
export const ENTRY_EVENT = "model-upstreams:answered-entry";
export const AUTH_KIND_HEADER = "x-cpa-auth-kind";
/** The answering credential's provider, as the credential list names providers. */
export const AUTH_PROVIDER_HEADER = "x-cpa-auth-provider";
/** The host of an answering API key with a base URL; absent when the credential has none. */
export const AUTH_HOST_HEADER = "x-cpa-auth-host";
/** The same on a WebSocket turn's response.created event. */
export const AUTH_KIND_FIELD = "cpa_auth_kind";
export const AUTH_PROVIDER_FIELD = "cpa_auth_provider";
export const AUTH_HOST_FIELD = "cpa_auth_host";
/** Provimux's marker of the account that answered, and the providers.dev entry of the answer. */
export const ACCOUNT_HEADER = "x-provimux-account";
export const ENTRY_HEADER = "x-provimux-entry";
export const ACCOUNT_FIELD = "provimux_account";
export const ENTRY_FIELD = "provimux_entry";
const REQUEST_TIMEOUT_MS = 10_000;

export interface Upstream {
	provider: string;
	model?: string;
	subscription?: boolean;
	/**
	 * `true`: `provider` is not a pi or providers.dev provider id but what the proxy named the credential by (its host for
	 * an API key, else the proxy's provider name), because it leads to a service not known. No providers.dev entry exists
	 * under it. Absent on every other upstream. A reader that does not know the field reads the rest as before.
	 */
	unmapped?: true;
}

export interface Route {
	upstreams: Upstream[];
	fallbacks?: Upstream[];
}

export interface ModelAccounts {
	/** Model id → the lab CLIProxyAPI names as its owner. */
	owners: Record<string, string>;
	/** Model id → the credentials that serve it; empty when CLIProxyAPI does not list them. */
	accounts: Record<string, Account[]>;
	/** Provimux's figures, where its list gave them: told with the routes. */
	figures?: Record<string, unknown>;
}

/** Where a CLIProxyAPI credential leads, by its provider and kind: pi's provider id, or providers.dev's. */
const CREDENTIALS: Record<string, { oauth?: string; apikey?: string }> = {
	claude: { oauth: "anthropic", apikey: "anthropic" },
	codex: { oauth: "openai-codex", apikey: "openai" },
	meta: { oauth: "meta", apikey: "meta" },
	devin: { oauth: "devin", apikey: "devin" },
	antigravity: { oauth: "antigravity" },
	gemini: { oauth: "google", apikey: "google" },
	vertex: { oauth: "google-vertex", apikey: "google-vertex" },
	xai: { oauth: "xai", apikey: "xai" },
	// The kimi.com login is Kimi Code (api.kimi.com/coding): pi's kimi-coding. The kimi.ai login (`kimi-ai`, `kimi.ai`)
	// goes to api.kimi.ai, which pi has no provider for.
	kimi: { oauth: "kimi-coding" },
	// Without a host, an OpenAI-compatible entry is only known by the name the operator gave it.
	"openai-compatible-openrouter": { apikey: "openrouter" },
};

/** Where an API key leads, by the host it is sent to: whatever its entry is called, and wherever a Claude key goes. */
const API_HOSTS: Record<string, string> = {
	"openrouter.ai": "openrouter",
	"api.openai.com": "openai",
	"api.anthropic.com": "anthropic",
	"generativelanguage.googleapis.com": "google",
	// pi's providers whose host serves only them, with their API's own prices.
	"api.x.ai": "xai",
	"api.meta.ai": "meta",
	"api.kimi.com": "kimi-coding",
	"api.moonshot.ai": "moonshotai",
	"api.moonshot.cn": "moonshotai-cn",
	"api.deepseek.com": "deepseek",
	"api.mistral.ai": "mistral",
	"api.groq.com": "groq",
	"api.cerebras.ai": "cerebras",
	"api.fireworks.ai": "fireworks",
	"api.together.ai": "together",
	"integrate.api.nvidia.com": "nvidia",
	"api.xiaomimimo.com": "xiaomi",
};

/** Without the credential list: the lab CLIProxyAPI names as the owner, reached by login or key. */
const OWNERS: Record<string, Upstream[]> = {
	anthropic: [{ provider: "anthropic" }],
	openai: [
		{ provider: "openai-codex", subscription: true },
		{ provider: "openai", subscription: false },
	],
	meta: [{ provider: "meta" }],
};

/** A provider's model ids as pi's catalog has them; undefined when the catalog has none for it. */
export type Catalog = (provider: string) => ReadonlySet<string> | undefined;

/**
 * Without a catalog: how many of a model id's last `/`-parts are the provider's own id, by the shape all its ids have
 * (`openai/gpt-5`, `Qwen/Qwen3.6-Plus`, `google/gemma-3-12b-it`, `accounts/fireworks/models/…`); one for everyone else.
 */
const ID_PARTS: Record<string, number> = { openrouter: 2, together: 2, nvidia: 2, fireworks: 4 };

const partsOf = (id: string) => id.split("/").length;

/**
 * A model's id at a provider, as pi's catalog has it: the proxy's id without a prefix (the proxy's own or one an
 * operator configured). A prefix is left out unless what is left is not in the catalog and the id with it is: of the
 * id and what is left after each `/`, the shortest the catalog has. When the catalog has none of them (a model newer
 * than it), the parts the provider's ids have, if nearly all have as many; else the last part. Without a catalog for the
 * provider, the shape its ids are known to have.
 */
export function ownModelId(provider: string, modelId: string, catalog?: Catalog): string {
	const parts = modelId.split("/");
	const tails = parts.map((_, index) => parts.slice(index).join("/"));
	const ids = catalog?.(provider);
	let count = own(ID_PARTS, provider) ?? 1;
	if (ids && ids.size > 0) {
		for (const tail of [...tails].reverse()) if (ids.has(tail)) return tail;
		const counts = new Map<number, number>();
		for (const id of ids) counts.set(partsOf(id), (counts.get(partsOf(id)) ?? 0) + 1);
		const [common, many] = [...counts].sort((a, b) => b[1] - a[1])[0]!;
		count = many * 10 >= ids.size * 9 ? common : 1;
	}
	return parts.slice(-count).join("/");
}

/** A credential's upstream for a model; undefined when it leads somewhere not known. */
export function upstreamOf(account: Account, modelId: string, catalog?: Catalog): Upstream | undefined {
	const provider =
		account.kind === "apikey" && account.host
			? own(API_HOSTS, account.host)
			: own(own(CREDENTIALS, account.provider) ?? {}, account.kind);
	if (!provider) return undefined;
	const model = ownModelId(provider, modelId, catalog);
	return { provider, ...(model !== modelId ? { model } : {}), subscription: account.kind !== "apikey" };
}

const unique = (upstreams: Upstream[]): Upstream[] => {
	const seen = new Set<string>();
	return upstreams.filter((upstream) => {
		const key = JSON.stringify([upstream.provider, upstream.model, upstream.subscription]);
		return !seen.has(key) && seen.add(key);
	});
};

/** The upstreams of some credentials; empty when one of them leads somewhere not known (it may answer). */
function upstreamsOf(accounts: Account[], modelId: string, catalog?: Catalog): Upstream[] {
	const upstreams = accounts.map((account) => upstreamOf(account, modelId, catalog));
	return upstreams.every((upstream) => upstream !== undefined) ? unique(upstreams as Upstream[]) : [];
}

/** A model's route: from its credentials when CLIProxyAPI lists them, else from its owner and CLIProxyAPI's own prefix. */
export function routeOf(modelId: string, listed: ModelAccounts, catalog?: Catalog): Route {
	const accounts = own(listed.accounts, modelId);
	if (accounts && accounts.length > 0) {
		const likely = likelyAccounts(accounts);
		const upstreams = upstreamsOf(likely, modelId, catalog);
		const main = new Set(upstreams.map((upstream) => JSON.stringify(upstream)));
		const fallbacks = unique(
			accounts
				.filter((account) => !likely.includes(account))
				.map((account) => upstreamOf(account, modelId, catalog))
				.filter((upstream): upstream is Upstream => upstream !== undefined && !main.has(JSON.stringify(upstream))),
		);
		return { upstreams, ...(fallbacks.length > 0 ? { fallbacks } : {}) };
	}
	if (modelId.startsWith("devin/"))
		return { upstreams: [{ provider: "devin", model: modelId.slice("devin/".length) }] };
	// Any OpenAI-compatible entry can use `lab/model`: the name says nothing about who serves it.
	const owner = own(listed.owners, modelId);
	if (modelId.includes("/") || !owner) return { upstreams: [] };
	return { upstreams: own(OWNERS, owner) ?? [{ provider: owner }] };
}

/** What a response says answered it: the credential's provider and kind and, for an API key with a base URL, its host. */
export interface StatedCredential {
	provider: string;
	kind: string;
	/** Absent: the credential has none. */
	host?: string;
}

/**
 * What answered a request to a model, when CLIProxyAPI names the credential: from the response alone, the credential
 * list is not consulted (it may be older than the proxy). The provider is matched without regard to letter case. A
 * credential that leads to a service not known is still named, so a change of route is seen: by its host for an API
 * key that has one, else by its provider as the response gives it, and marked `unmapped` (no providers.dev id).
 */
export function statedUpstream(modelId: string, stated: StatedCredential, catalog?: Catalog): Upstream {
	const account: Account = {
		provider: stated.provider.toLowerCase(),
		kind: stated.kind,
		priority: 0,
		...(stated.host ? { host: stated.host.toLowerCase() } : {}),
	};
	const known = upstreamOf(account, modelId, catalog);
	if (known) return known;
	const provider = stated.kind === "apikey" && account.host ? account.host : stated.provider;
	return { provider, subscription: stated.kind !== "apikey", unmapped: true };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** `/v1/models?include=accounts`. A CLIProxyAPI that does not know the parameter answers the plain list. */
export async function fetchModelAccounts(
	baseUrlInput: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<ModelAccounts> {
	const url = `${resolveEndpoints(baseUrlInput).plainModelsUrl}?include=accounts`;
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!response.ok) throw new Error(`${url} answered ${response.status}`);
	const body: unknown = await response.json();
	if (!isRecord(body) || !Array.isArray(body.data)) throw new Error(`${url} answered without a list`);
	// Without a prototype: a model called `__proto__` or `constructor` is an entry like any other.
	const listed: ModelAccounts = { owners: Object.create(null), accounts: Object.create(null) };
	for (const model of body.data) {
		if (!isRecord(model) || typeof model.id !== "string") continue;
		if (typeof model.owned_by === "string") listed.owners[model.id] = model.owned_by.trim().toLowerCase();
		const accounts = parseAccounts(model.accounts);
		if (accounts.length > 0) listed.accounts[model.id] = accounts;
	}
	return listed;
}

/** A list the extension read (the model load's) in the form of `fetchModelAccounts`, with the gateway's figures. */
export function routesOfSources(sources: ListedSources): ModelAccounts {
	const listed: ModelAccounts = { owners: Object.create(null), accounts: Object.create(null) };
	for (const [id, owner] of sources.owners) listed.owners[id] = owner;
	for (const [id, accounts] of sources.accounts) listed.accounts[id] = accounts;
	if (sources.figures) listed.figures = handOnFigures(sources.figures);
	return listed;
}

/** What an answer says answered it, as given: the kind, provider and host (any may be absent or not a string). */
export interface Statement {
	kind: unknown;
	provider: unknown;
	host: unknown;
	/** Provimux's marker of the account, and the answer's providers.dev entry, as written on the wire. */
	account?: unknown;
	entry?: unknown;
}

/** The entry an answer names, decoded; null where it is written in a form that cannot be read; undefined: none. */
export function statedEntry(statement: Statement | undefined): string | null | undefined {
	const raw = typeof statement?.entry === "string" ? statement.entry.trim() : "";
	if (!raw) return undefined;
	return decodeWireValue(raw) ?? null;
}

const STATEMENTS_KEY = Symbol.for("pi-provimux.answered-statements");

/**
 * The stream event each answer is told with → what the answer said. Keyed by the event itself, which pi hands to the
 * session's `provider_stream_event` handlers as it is: an event belongs to one request, so nothing here can be taken
 * for another's. Shared by every copy of this module in the process (pi may load the extension more than once).
 */
function statements(): WeakMap<object, Statement> {
	const global = globalThis as { [STATEMENTS_KEY]?: WeakMap<object, Statement> };
	global[STATEMENTS_KEY] ??= new WeakMap();
	return global[STATEMENTS_KEY];
}

/**
 * Where a message carries what its answer said: an own property under a symbol shared by every copy of this module,
 * set on the message pi's agent loop takes from the request's stream and hands to `message_end`. Only the session's
 * own turns get there, never pi's cache warmer or another extension's request. An own enumerable property: a shallow
 * copy (`{ ...message }`, as another extension's `message_end` handler may return) keeps it; JSON (the session file)
 * drops it.
 */
const ANSWER = Symbol.for("pi-provimux.answer");

/** What the answer a message came from said answered it; undefined when it is not a message of this provider's stream. */
export function answerOf(message: unknown): Statement | undefined {
	if (!isRecord(message)) return undefined;
	const said = (message as Record<symbol, unknown>)[ANSWER];
	return isRecord(said) ? (said as unknown as Statement) : undefined;
}

/** Keeps what a request's answer said with the message its stream ends with (`answerOf`). */
function keepWithMessage(stream: unknown, said: (message: Record<string, unknown>) => Statement | undefined): void {
	const result = (stream as { result?: unknown } | null | undefined)?.result;
	if (typeof result !== "function") return;
	try {
		Promise.resolve((result as () => unknown).call(stream)).then(
			(message) => {
				const statement = isRecord(message) ? said(message) : undefined;
				if (statement && isRecord(message)) (message as Record<symbol, unknown>)[ANSWER] = statement;
			},
			() => {},
		);
	} catch {
		// A stream without a result to wait for: nothing to keep.
	}
}

/** The callbacks one request is sent with, as `onResponse` and `onProviderStreamEvent` take them. */
export interface AnswerCallbacks<TModel = unknown> {
	onResponse?: (response: { status: number; headers: Record<string, string> }, model: TModel) => unknown;
	onProviderStreamEvent?: (data: unknown, model: TModel) => unknown;
}

/**
 * One request's callbacks, which keep what its answer says to themselves. Over HTTP and SSE its response's headers
 * (`onResponse`, which pi calls with that request's response and model) are told with its stream's first event; over
 * the Codex WebSocket, which calls no `onResponse`, the `cpa_auth_*` fields of its first response.created. Once: later
 * events of the answer, and a body's own fields over HTTP (an inner gateway's), tell nothing. The callbacks given are
 * called as they were, with the same arguments; nothing else changes.
 */
export function answeredOptions<T extends AnswerCallbacks<never> | undefined>(options: T): T {
	return keptOptions(options).options;
}

/** What an attempt that named nobody said: an unnamed answer. */
const UNNAMED: Statement = { kind: undefined, provider: undefined, host: undefined };

/** Codex events that end an attempt without an answer: what it said goes with it. */
const FAILED_ATTEMPT = new Set(["response.failed", "response.incomplete", "error"]);

/**
 * `answeredOptions`, and what the answer the request ends with said (for its message): only what the attempt that
 * answered said itself. pi-ai can try a request again inside one call (an HTTP 429; a Codex WebSocket continuation the
 * proxy lost, replayed on a fresh socket), each attempt may be served by another route, and an attempt starts unnamed.
 * - Over HTTP: the last response's own headers.
 * - Without headers (the Codex WebSocket): the response.created's fields of the response the message comes from. An
 *   attempt that failed takes what it said with it, and a response.created of another response than the message's
 *   (its id) says nothing of it. An answer whose attempt said nothing (no response.created) is unnamed.
 * - Nothing heard of the request at all: undefined.
 */
function keptOptions<T extends AnswerCallbacks<never> | undefined>(
	options: T,
): { options: T; said: (message: Record<string, unknown>) => Statement | undefined } {
	const onEvent = options?.onProviderStreamEvent;
	// Nobody hears the stream's events: there is nobody to tell.
	if (!options || !onEvent) return { options, said: () => undefined };
	const onResponse = options.onResponse;
	let headers: Record<string, string> | undefined;
	/** Whether the current attempt was told: each attempt is told once, so the last told is the attempt that answered. */
	let told = false;
	/** What the current attempt said, and the response it said it of (WebSocket). */
	let said: Statement | undefined;
	let saidOf: string | undefined;
	let heard = false;
	const header = (wanted: string) =>
		headers && Object.entries(headers).find(([name]) => name.toLowerCase() === wanted)?.[1];
	const wrapped = {
		...options,
		onResponse: (response: { status: number; headers: Record<string, string> }, model: never) => {
			// A retried request: the last response is the one whose body is read.
			headers = response.headers ?? {};
			// A new response: a new attempt, told with its first stream event.
			told = false;
			const account = header(ACCOUNT_HEADER);
			const entry = header(ENTRY_HEADER);
			said = {
				kind: header(AUTH_KIND_HEADER),
				provider: header(AUTH_PROVIDER_HEADER),
				host: header(AUTH_HOST_HEADER),
				...(account !== undefined ? { account } : {}),
				...(entry !== undefined ? { entry } : {}),
			};
			return onResponse?.(response, model);
		},
		onProviderStreamEvent: (data: unknown, model: never) => {
			if (isRecord(data)) {
				heard = true;
				// Over HTTP the headers alone count: a body's own fields are an inner gateway's.
				if (!headers && data.type === "response.created") {
					said = {
						kind: data[AUTH_KIND_FIELD],
						provider: data[AUTH_PROVIDER_FIELD],
						host: data[AUTH_HOST_FIELD],
						...(data[ACCOUNT_FIELD] !== undefined ? { account: data[ACCOUNT_FIELD] } : {}),
						...(data[ENTRY_FIELD] !== undefined ? { entry: data[ENTRY_FIELD] } : {}),
					};
					const id = isRecord(data.response) ? data.response.id : undefined;
					saidOf = typeof id === "string" ? id : undefined;
				} else if (!headers && typeof data.type === "string" && FAILED_ATTEMPT.has(data.type)) {
					// The attempt ended without an answer: the next one starts unnamed, and is told.
					said = undefined;
					saidOf = undefined;
					told = false;
				}
				// Each attempt is told once, with its first statement: an attempt tried again (an HTTP retry, a Codex WebSocket
				// replay on a fresh socket after a failed one) tells its own, so the last one told is the attempt that answered.
				if (!told && said && (headers || data.type === "response.created")) {
					told = true;
					statements().set(data, said);
				}
			}
			return onEvent(data, model);
		},
	} as T;
	const saidOfMessage = (message: Record<string, unknown>): Statement | undefined => {
		if (headers) return said;
		if (!heard) return undefined;
		// The message is another response's than the one the held statement was said of: its attempt said nothing.
		if (saidOf && typeof message.responseId === "string" && message.responseId !== saidOf) return UNNAMED;
		return said ?? UNNAMED;
	};
	return { options: wrapped, said: saidOfMessage };
}

/**
 * A stream function whose every call keeps what its answer says to itself (`answeredOptions`), and with the message
 * its stream ends with (`answerOf`).
 */
export function answeredStream<M, C, O extends AnswerCallbacks<never> | undefined, R>(
	stream: (model: M, context: C, options: O) => R,
): (model: M, context: C, options: O) => R {
	return (model, context, options) => {
		noteCacheUse(model, options);
		const kept = keptOptions(options);
		const result = stream(model, context, kept.options);
		keepWithMessage(result, kept.said);
		return result;
	};
}

/** pi-ai's implementation of an API, as `getApiProvider` gives it. */
interface ApiImplementation {
	stream: (model: { provider: string }, context: unknown, options?: AnswerCallbacks<never>) => unknown;
	streamSimple: (model: { provider: string }, context: unknown, options?: AnswerCallbacks<never>) => unknown;
}

const CLAUDE_SCOPE_KEY = Symbol.for("pi-provimux.claude-messages-scope.v2");

type Method = "stream" | "streamSimple";

/** What is wrapped, and what was there before. */
interface Wrap {
	implementation: ApiImplementation;
	originals: Pick<ApiImplementation, Method>;
	wrappers: Pick<ApiImplementation, Method>;
}

interface ClaudeScope {
	/** Provider id → how many loaded copies of the extension want it. */
	providers: Map<string, number>;
	/** The one wrap in the process, however many copies of the extension are loaded. */
	wrap?: Wrap;
}

/** Puts back what was there before, where the wrapper is still in place (a later wrapper of another is kept). */
function unwrap(wrap: Wrap): void {
	for (const method of ["stream", "streamSimple"] as const) {
		if (wrap.implementation[method] === wrap.wrappers[method]) wrap.implementation[method] = wrap.originals[method];
	}
}

/**
 * Gives each request to this provider's Claude Messages models its own callbacks (`answeredOptions`), as the
 * provider's own stream does for the Codex format. pi sends those models with pi-ai's `anthropic-messages`
 * implementation, not the provider's stream, so its calls are wrapped where pi looks the implementation up; other
 * providers' requests go through unchanged. The implementation is changed in place, not registered anew: pi-ai's
 * compat functions treat their built-in providers as built-in only while the implementation is the one they made.
 *
 * One wrap for the process: every loaded copy of the extension shares it. When the last copy shuts down, the
 * implementation gets its own `stream` and `streamSimple` back, the same functions as before. pi replaces the
 * implementation when it reloads extensions; a copy loaded after that wraps the new one.
 * Returns what to call when this copy of the extension shuts down.
 */
export function answeredClaudeMessages(
	providerId: string,
	getApiProvider: (api: string) => unknown,
	api = "anthropic-messages",
): () => void {
	const global = globalThis as { [CLAUDE_SCOPE_KEY]?: ClaudeScope };
	global[CLAUDE_SCOPE_KEY] ??= { providers: new Map() };
	const scope = global[CLAUDE_SCOPE_KEY];
	const found = getApiProvider(api) as ApiImplementation | undefined;
	const implementation =
		found && typeof found.stream === "function" && typeof found.streamSimple === "function" ? found : undefined;
	// pi made a new implementation (a reload): the old one is no longer used; it gets its own back.
	if (scope.wrap && scope.wrap.implementation !== implementation) {
		unwrap(scope.wrap);
		scope.wrap = undefined;
	}
	if (implementation && !scope.wrap) {
		const originals = { stream: implementation.stream, streamSimple: implementation.streamSimple };
		const wrap =
			(original: ApiImplementation[Method]): ApiImplementation[Method] =>
			(model, context, options) => {
				if (!scope.providers.has(model.provider)) return original(model, context, options);
				noteCacheUse(model, options);
				const kept = keptOptions(options);
				const result = original(model, context, kept.options);
				keepWithMessage(result, kept.said);
				return result;
			};
		const wrappers = { stream: wrap(originals.stream), streamSimple: wrap(originals.streamSimple) };
		implementation.stream = wrappers.stream;
		implementation.streamSimple = wrappers.streamSimple;
		scope.wrap = { implementation, originals, wrappers };
	}
	scope.providers.set(providerId, (scope.providers.get(providerId) ?? 0) + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const count = (scope.providers.get(providerId) ?? 1) - 1;
		if (count > 0) scope.providers.set(providerId, count);
		else scope.providers.delete(providerId);
		if (scope.providers.size === 0 && scope.wrap) {
			unwrap(scope.wrap);
			scope.wrap = undefined;
		}
	};
}

/** The session's models, as pi's `ctx.modelRegistry` lists them. */
interface ModelList {
	getAll(): Array<{ provider: string; id: string }>;
}

/**
 * Tells other extensions where this provider's models come from, and what answered each request.
 *
 * Everything it says belongs to the session it was loaded in. pi disposes of an extension's `pi` when its session
 * shuts down (quit, `/reload`, a new or resumed session), and `pi.events.emit` then throws: from a lookup's `await`,
 * an unhandled rejection that ends pi. So on `session_shutdown` the lookup in flight is aborted and every result
 * still to come is dropped, and nothing is emitted through a disposed `pi`.
 */
export class UpstreamsAnnouncer {
	private listed: ModelAccounts | undefined;
	private running: Promise<void> | undefined;
	/** The session's lookups: aborted, and their results dropped, when it shuts down. */
	private session = new AbortController();
	/** Whether an extension asked: nothing is fetched for nobody. */
	private wanted = false;
	/** Whether the proxy named what answered a request in this session: it is one that names answers. */
	private namedBefore = false;
	/** The routes last told, and the figures told with them (as JSON). */
	private told: { models: Record<string, Route>; figures?: string } | undefined;
	/** The session's models (pi's catalog with its updates and models.json), from the context pi gives handlers. */
	private registry: ModelList | undefined;
	/** The catalog pi-ai is built with, once loaded: when the session's models have none of a provider. */
	private builtin: ((provider: string) => Array<{ id: string }>) | undefined;
	private builtinLoading: Promise<void> | undefined;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly providerId: string,
		private readonly connection: () => { baseUrlInput: string; apiKey: string } | null,
		private readonly fetchAccounts: typeof fetchModelAccounts = fetchModelAccounts,
		/** pi's catalog, as a test gives it; else the session's models, else pi-ai's own. */
		private readonly givenCatalog?: Catalog,
		/** The gateway's list as the extension last read it: whether it gives figures, and the read an answer brings. */
		private readonly gateway?: GatewayList,
	) {}

	/** A provider's model ids as pi's catalog has them, for the model ids said (`ownModelId`). */
	readonly catalog: Catalog = (provider) => {
		if (this.givenCatalog) return this.givenCatalog(provider);
		let ids: string[] = [];
		try {
			ids = (this.registry?.getAll() ?? []).filter((model) => model.provider === provider).map((model) => model.id);
		} catch {
			// A context from before a reload: pi-ai's own catalog.
			this.registry = undefined;
		}
		if (ids.length === 0) {
			try {
				ids = (this.builtin?.(provider) ?? []).map((model) => model.id);
			} catch {
				ids = [];
			}
		}
		return ids.length > 0 ? new Set(ids) : undefined;
	};

	private loadBuiltin(): Promise<void> {
		this.builtinLoading ??= import("@earendil-works/pi-ai/providers/all")
			.then((module: { getBuiltinModels: unknown }) => {
				this.builtin = module.getBuiltinModels as (provider: string) => Array<{ id: string }>;
			})
			.catch(() => {});
		return this.builtinLoading;
	}

	private keepRegistry(ctx: unknown): void {
		const registry = (ctx as { modelRegistry?: ModelList } | undefined)?.modelRegistry;
		if (registry && typeof registry.getAll === "function") this.registry = registry;
	}

	register(): void {
		// No bus between extensions (a test's stand-in): nobody to tell.
		if (!this.pi.events) return;
		void this.loadBuiltin();
		this.pi.on("session_start", (_event, ctx) => {
			// A session after one that shut down, with this same copy: a new start, with nothing of the last one's.
			if (this.session.signal.aborted) this.session = new AbortController();
			this.keepRegistry(ctx);
		});
		this.pi.on("session_shutdown", () => this.shutdown());
		// The list read again (a model load, or the read an answer with a new entry brought): its figures only.
		this.gateway?.onChange(() => this.figuresRead());
		this.pi.events.on(REQUEST_EVENT, () => {
			this.wanted = true;
			void this.announce();
		});
		// The event a request's answer is told with, marked by that request's own callbacks (`answeredOptions`); its
		// model is the one the request was sent to, not the session's selection (a virtual model, or another provider's).
		// pi's events name no request, so nothing else here is read from them.
		this.pi.on("provider_stream_event", (event, ctx) => {
			if (event.provider !== this.providerId || !isRecord(event.data)) return;
			const stated = statements().get(event.data);
			if (!stated) return;
			statements().delete(event.data);
			this.keepRegistry(ctx);
			this.answered(event.model, stated);
		});
	}

	/** Whether the proxy names what answered: it lists its credentials (Provimux), or it named an answer before. */
	namesAnswers(): boolean {
		if (this.namedBefore) return true;
		return !!this.listed && Object.values(this.listed.accounts).some((accounts) => accounts.length > 0);
	}

	private answered(modelId: string, stated: Statement): void {
		const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
		const kind = text(stated.kind)?.toLowerCase();
		const provider = text(stated.provider);
		const host = text(stated.host);
		let upstreams: Upstream[] | undefined;
		if ((kind !== "oauth" && kind !== "apikey") || !provider) {
			// Named nobody: from a proxy that names answers, one it would not name (plugin code took part); said as
			// `[]`, so that nobody keeps the last credential's values. From plain CLIProxyAPI: nothing, as ever.
			if (!this.wanted || !this.namesAnswers()) return;
			upstreams = [];
		} else {
			// Named: from the response alone, without waiting for the credential list; only once an extension asked.
			this.namedBefore = true;
			const upstream = statedUpstream(modelId, { provider, kind, ...(host ? { host } : {}) }, this.catalog);
			const named = this.namedEntry(stated);
			if (!this.wanted) return;
			if (named) this.emit(ENTRY_EVENT, { provider: this.providerId, model: modelId, ...named });
			upstreams = [upstream];
		}
		if (upstreams) this.emit(ANSWERED_EVENT, { provider: this.providerId, model: modelId, upstreams });
	}

	/**
	 * What an answer says of its account and entry, for ENTRY_EVENT: from an answer that names its entry, or from a
	 * gateway known to give figures (an answer there that names its account and no entry has none: `entry: null`).
	 * Nothing from any other (Provimux 8.1.7-pmx.3 names the account only). An entry new to what the extension holds
	 * brings one more read of the list.
	 */
	private namedEntry(stated: Statement): { entry: string | null; account?: string } | undefined {
		const account = typeof stated.account === "string" && stated.account.trim() ? stated.account.trim() : undefined;
		const entry = statedEntry(stated);
		if (entry === undefined && !(account && this.gateway?.supports === true)) return undefined;
		if (entry) this.gateway?.noteAnswer(entry);
		return { entry: entry ?? null, ...(account ? { account } : {}) };
	}

	/** The session shut down: what it asked for is dropped, the lookup in flight aborted. */
	shutdown(): void {
		this.session.abort();
		this.running = undefined;
		this.wanted = false;
		this.namedBefore = false;
		this.listed = undefined;
		this.told = undefined;
		this.registry = undefined;
	}

	/** Tells the session's listeners; nothing once it shut down, and never a throw from a disposed `pi`. */
	private emit(channel: string, data: unknown, signal: AbortSignal = this.session.signal): void {
		if (signal.aborted) return;
		try {
			this.pi.events.emit(channel, data);
		} catch {
			// pi disposed of this copy without a session_shutdown it heard: it is done.
			this.shutdown();
		}
	}

	/** After the model list was fetched again: tells the routes again, if an extension asked for them. */
	refreshed(): Promise<void> {
		return this.wanted ? this.announce() : Promise.resolve();
	}

	/**
	 * A list read brought figures other than those told: the routes last told, as they were, with the new figures. Routes
	 * are never read here; before any routes were told, nothing is said (the routes, when told, carry the figures).
	 */
	private figuresRead(): void {
		if (this.running) {
			void this.running.then(() => this.figuresRead());
			return;
		}
		const told = this.told;
		const held = this.gateway?.figures();
		if (!this.wanted || !told || !held) return;
		const figures = handOnFigures(held);
		if (JSON.stringify(figures) === told.figures) return;
		told.figures = JSON.stringify(figures);
		this.emit(UPSTREAMS_EVENT, { provider: this.providerId, models: told.models, figures });
	}

	/** Asks CLIProxyAPI for its credentials and tells the routes. When it does not answer, nothing is said. */
	announce(): Promise<void> {
		if (this.running) return this.running;
		const signal = this.session.signal;
		if (signal.aborted) return Promise.resolve();
		const running: Promise<void> = (async () => {
			const connection = this.connection();
			if (!connection) return;
			let listed: ModelAccounts;
			try {
				[listed] = await Promise.all([
					this.fetchAccounts(connection.baseUrlInput, connection.apiKey, signal),
					this.givenCatalog ? undefined : this.loadBuiltin(),
				]);
			} catch {
				return;
			}
			// The session shut down while the list was on its way: a late answer, for nobody.
			if (signal.aborted) return;
			this.listed = listed;
			const ids = new Set([...Object.keys(listed.owners), ...Object.keys(listed.accounts)]);
			// fromEntries: a model called `__proto__` is an entry, not the object's prototype.
			const models: Record<string, Route> = Object.fromEntries(
				[...ids].map((id) => [id, routeOf(id, listed, this.catalog)]),
			);
			const figures = listed.figures;
			this.told = { models, ...(figures ? { figures: JSON.stringify(figures) } : {}) };
			this.emit(UPSTREAMS_EVENT, { provider: this.providerId, models, ...(figures ? { figures } : {}) }, signal);
		})()
			.catch(() => {
				// Nothing said: a lookup never ends pi.
			})
			.finally(() => {
				if (this.running === running) this.running = undefined;
			});
		this.running = running;
		return running;
	}
}
