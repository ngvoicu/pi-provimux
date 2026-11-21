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
 *   after `/cliproxyapi-refresh`. `upstreams` are what may serve the model (several: not known which), `fallbacks` what may
 *   answer when those fail.
 * - `model-upstreams:answered`: `{ provider, model, upstreams }`, once per answer, while the request is out. Over HTTP
 *   and SSE only the response headers (`X-CPA-AUTH-*`) count; over the Codex WebSocket, which has no headers per turn,
 *   only the `cpa_auth_*` fields the proxy puts on response.created. When the answer gives the provider: the credential
 *   it names, from the response alone; the kind alone: a guess from the credential list. An answer that names nobody,
 *   from a proxy that names answers (one that lists its credentials, or named an answer before): `upstreams: []`,
 *   answered by something the proxy would not name. A proxy that names no answer (plain CLIProxyAPI): nothing.
 *
 * Requests overlap (pi's cache warmer next to the turn it warms, an extension's own call with the session's callbacks),
 * and pi's events say nothing of which request they belong to. So what a request's answer says is kept by that request
 * alone: each call of the provider's stream gets its own callbacks (`answeredOptions`), which hold its headers and its
 * one report, and mark the stream event it is told with. The session's handler only reads that mark.
 *
 * An upstream is `{ provider, model?, subscription? }`: the pi provider the model would come from if used directly
 * (anthropic, openai-codex, openai, meta, openrouter, google) or a providers.dev provider pi has none for (devin,
 * antigravity); the model's id there when it differs; a subscription login (true) or an API key (false).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveEndpoints } from "./lib.ts";
import { type Account, likelyAccounts, own, parseAccounts } from "./sources.ts";

export { type Account, likelyAccounts } from "./sources.ts";

export const REQUEST_EVENT = "model-upstreams:request";
export const UPSTREAMS_EVENT = "model-upstreams";
export const ANSWERED_EVENT = "model-upstreams:answered";
export const AUTH_KIND_HEADER = "x-cpa-auth-kind";
/** The answering credential's provider, as the credential list names providers. */
export const AUTH_PROVIDER_HEADER = "x-cpa-auth-provider";
/** The host of an answering API key with a base URL; absent when the credential has none. */
export const AUTH_HOST_HEADER = "x-cpa-auth-host";
/** The same on a WebSocket turn's response.created event. */
export const AUTH_KIND_FIELD = "cpa_auth_kind";
export const AUTH_PROVIDER_FIELD = "cpa_auth_provider";
export const AUTH_HOST_FIELD = "cpa_auth_host";
const REQUEST_TIMEOUT_MS = 10_000;

export interface Upstream {
	provider: string;
	model?: string;
	subscription?: boolean;
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

/** A credential's upstream for a model; undefined when it leads somewhere not known. */
export function upstreamOf(account: Account, modelId: string): Upstream | undefined {
	const provider =
		account.kind === "apikey" && account.host
			? own(API_HOSTS, account.host)
			: own(own(CREDENTIALS, account.provider) ?? {}, account.kind);
	if (!provider) return undefined;
	// OpenRouter's names are `lab/model`; nobody else's have a slash, so one there is a prefix the proxy added.
	const model = provider === "openrouter" ? modelId : modelId.slice(modelId.lastIndexOf("/") + 1);
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
function upstreamsOf(accounts: Account[], modelId: string): Upstream[] {
	const upstreams = accounts.map((account) => upstreamOf(account, modelId));
	return upstreams.every((upstream) => upstream !== undefined) ? unique(upstreams as Upstream[]) : [];
}

/** A model's route: from its credentials when CLIProxyAPI lists them, else from its owner and CLIProxyAPI's own prefix. */
export function routeOf(modelId: string, listed: ModelAccounts): Route {
	const accounts = own(listed.accounts, modelId);
	if (accounts && accounts.length > 0) {
		const likely = likelyAccounts(accounts);
		const upstreams = upstreamsOf(likely, modelId);
		const main = new Set(upstreams.map((upstream) => JSON.stringify(upstream)));
		const fallbacks = unique(
			accounts
				.filter((account) => !likely.includes(account))
				.map((account) => upstreamOf(account, modelId))
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
 * key that has one, else by its provider as the response gives it.
 */
export function statedUpstream(modelId: string, stated: StatedCredential): Upstream {
	const account: Account = {
		provider: stated.provider.toLowerCase(),
		kind: stated.kind,
		priority: 0,
		...(stated.host ? { host: stated.host.toLowerCase() } : {}),
	};
	const known = upstreamOf(account, modelId);
	if (known) return known;
	const provider = stated.kind === "apikey" && account.host ? account.host : stated.provider;
	return { provider, subscription: stated.kind !== "apikey" };
}

/** What answered a request to a model, from the kind of credential CLIProxyAPI names; undefined when not known. */
export function answeredUpstreams(modelId: string, kind: string, listed: ModelAccounts): Upstream[] | undefined {
	const upstreams = upstreamsOf(likelyAccounts(own(listed.accounts, modelId) ?? [], kind), modelId);
	return upstreams.length > 0 ? upstreams : undefined;
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

/** What an answer says answered it, as given: the kind, provider and host (any may be absent or not a string). */
interface Statement {
	kind: unknown;
	provider: unknown;
	host: unknown;
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
	const onEvent = options?.onProviderStreamEvent;
	// Nobody hears the stream's events: there is nobody to tell.
	if (!options || !onEvent) return options;
	const onResponse = options.onResponse;
	let headers: Record<string, string> | undefined;
	let told = false;
	const header = (wanted: string) =>
		headers && Object.entries(headers).find(([name]) => name.toLowerCase() === wanted)?.[1];
	return {
		...options,
		onResponse: (response: { status: number; headers: Record<string, string> }, model: never) => {
			// A retried request: the last response is the one whose body is read.
			headers = response.headers ?? {};
			return onResponse?.(response, model);
		},
		onProviderStreamEvent: (data: unknown, model: never) => {
			if (!told && isRecord(data)) {
				if (headers) {
					told = true;
					statements().set(data, {
						kind: header(AUTH_KIND_HEADER),
						provider: header(AUTH_PROVIDER_HEADER),
						host: header(AUTH_HOST_HEADER),
					});
				} else if (data.type === "response.created") {
					told = true;
					statements().set(data, {
						kind: data[AUTH_KIND_FIELD],
						provider: data[AUTH_PROVIDER_FIELD],
						host: data[AUTH_HOST_FIELD],
					});
				}
			}
			return onEvent(data, model);
		},
	} as T;
}

/** A stream function whose every call keeps what its answer says to itself (`answeredOptions`). */
export function answeredStream<M, C, O extends AnswerCallbacks<never> | undefined, R>(
	stream: (model: M, context: C, options: O) => R,
): (model: M, context: C, options: O) => R {
	return (model, context, options) => stream(model, context, answeredOptions(options));
}

/** pi-ai's implementation of an API, as `getApiProvider` gives it. */
interface ApiImplementation {
	stream: (model: { provider: string }, context: unknown, options?: AnswerCallbacks<never>) => unknown;
	streamSimple: (model: { provider: string }, context: unknown, options?: AnswerCallbacks<never>) => unknown;
}

const CLAUDE_SCOPE_KEY = Symbol.for("pi-provimux.claude-messages-scope");

interface ClaudeScope {
	/** Provider id → how many loaded copies of the extension want it. */
	providers: Map<string, number>;
	/** The implementations already wrapped (pi replaces its implementation when it reloads extensions). */
	wrapped: WeakSet<object>;
}

/**
 * Gives each request to this provider's Claude Messages models its own callbacks (`answeredOptions`), as the
 * provider's own stream does for the Codex format. pi sends those models with pi-ai's `anthropic-messages`
 * implementation, not the provider's stream, so its calls are wrapped where pi looks the implementation up; other
 * providers' requests go through unchanged. The implementation is changed in place, not registered anew: pi-ai's
 * compat functions treat their built-in providers as built-in only while the implementation is the one they made.
 * Returns what to call when this copy of the extension shuts down.
 */
export function answeredClaudeMessages(
	providerId: string,
	getApiProvider: (api: string) => unknown,
	api = "anthropic-messages",
): () => void {
	const global = globalThis as { [CLAUDE_SCOPE_KEY]?: ClaudeScope };
	global[CLAUDE_SCOPE_KEY] ??= { providers: new Map(), wrapped: new WeakSet() };
	const scope = global[CLAUDE_SCOPE_KEY];
	const implementation = getApiProvider(api) as ApiImplementation | undefined;
	if (
		implementation &&
		typeof implementation.stream === "function" &&
		typeof implementation.streamSimple === "function" &&
		!scope.wrapped.has(implementation)
	) {
		scope.wrapped.add(implementation);
		for (const method of ["stream", "streamSimple"] as const) {
			const original = implementation[method];
			implementation[method] = (model, context, options) =>
				original(model, context, scope.providers.has(model.provider) ? answeredOptions(options) : options);
		}
	}
	scope.providers.set(providerId, (scope.providers.get(providerId) ?? 0) + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const count = (scope.providers.get(providerId) ?? 1) - 1;
		if (count > 0) scope.providers.set(providerId, count);
		else scope.providers.delete(providerId);
	};
}

/** Tells other extensions where this provider's models come from, and what answered each request. */
export class UpstreamsAnnouncer {
	private listed: ModelAccounts | undefined;
	private running: Promise<void> | undefined;
	/** Whether an extension asked: nothing is fetched for nobody. */
	private wanted = false;
	/** Whether the proxy named what answered a request in this session: it is one that names answers. */
	private namedBefore = false;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly providerId: string,
		private readonly connection: () => { baseUrlInput: string; apiKey: string } | null,
		private readonly fetchAccounts: typeof fetchModelAccounts = fetchModelAccounts,
	) {}

	register(): void {
		// pi without a bus between extensions (older, or a test's stand-in): nobody to tell.
		if (!this.pi.events) return;
		this.pi.events.on(REQUEST_EVENT, () => {
			this.wanted = true;
			void this.announce();
		});
		// The event a request's answer is told with, marked by that request's own callbacks (`answeredOptions`); its
		// model is the one the request was sent to, not the session's selection (a virtual model, or another provider's).
		// pi's events name no request, so nothing else here is read from them.
		this.pi.on("provider_stream_event", (event) => {
			if (event.provider !== this.providerId || !isRecord(event.data)) return;
			const stated = statements().get(event.data);
			if (!stated) return;
			statements().delete(event.data);
			this.answered(event.model, stated.kind, stated.provider, stated.host);
		});
	}

	/** Whether the proxy names what answered: it lists its credentials (Provimux), or it named an answer before. */
	private namesAnswers(): boolean {
		if (this.namedBefore) return true;
		return !!this.listed && Object.values(this.listed.accounts).some((accounts) => accounts.length > 0);
	}

	private answered(modelId: string, kindValue: unknown, providerValue: unknown, hostValue: unknown): void {
		const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
		const kind = text(kindValue)?.toLowerCase();
		const provider = text(providerValue);
		const host = text(hostValue);
		let upstreams: Upstream[] | undefined;
		if (kind !== "oauth" && kind !== "apikey") {
			// Named nobody: from a proxy that names answers, one it would not name (plugin code took part); said as
			// `[]`, so that nobody keeps the last credential's values. From plain CLIProxyAPI: nothing, as ever.
			if (!this.wanted || !this.namesAnswers()) return;
			upstreams = [];
		} else if (provider) {
			// Named: from the response alone, without waiting for the credential list; only once an extension asked.
			this.namedBefore = true;
			if (!this.wanted) return;
			upstreams = [statedUpstream(modelId, { provider, kind, ...(host ? { host } : {}) })];
		} else {
			// Kind only (an older Provimux): a guess from the list, once it came.
			this.namedBefore = true;
			if (!this.listed) return;
			upstreams = answeredUpstreams(modelId, kind, this.listed) ?? [];
		}
		if (upstreams) this.pi.events.emit(ANSWERED_EVENT, { provider: this.providerId, model: modelId, upstreams });
	}

	/** After the model list was fetched again: tells the routes again, if an extension asked for them. */
	refreshed(): Promise<void> {
		return this.wanted ? this.announce() : Promise.resolve();
	}

	/** Asks CLIProxyAPI for its credentials and tells the routes. When it does not answer, nothing is said. */
	announce(): Promise<void> {
		this.running ??= (async () => {
			const connection = this.connection();
			if (!connection) return;
			try {
				this.listed = await this.fetchAccounts(connection.baseUrlInput, connection.apiKey);
			} catch {
				return;
			}
			const listed = this.listed;
			const ids = new Set([...Object.keys(listed.owners), ...Object.keys(listed.accounts)]);
			// fromEntries: a model called `__proto__` is an entry, not the object's prototype.
			const models: Record<string, Route> = Object.fromEntries([...ids].map((id) => [id, routeOf(id, listed)]));
			this.pi.events.emit(UPSTREAMS_EVENT, { provider: this.providerId, models });
		})().finally(() => {
			this.running = undefined;
		});
		return this.running;
	}
}
