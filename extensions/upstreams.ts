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
 * - `model-upstreams:answered`: `{ provider, model, upstreams }`, after a response that names what answered (the
 *   `X-CPA-AUTH-*` headers, or the `cpa_auth_*` fields on response.created over the Codex WebSocket): when it gives the
 *   provider, the credential it names, from the response alone; else a guess from the kind and the credential list.
 *
 * An upstream is `{ provider, model?, subscription? }`: the pi provider the model would come from if used directly
 * (anthropic, openai-codex, openai, meta, openrouter, google) or a providers.dev provider pi has none for (devin,
 * antigravity); the model's id there when it differs; a subscription login (true) or an API key (false).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveEndpoints } from "./lib.ts";
import { type Account, likelyAccounts, parseAccounts } from "./sources.ts";

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

/** Where a CLIProxyAPI credential leads, by its provider and kind. */
const CREDENTIALS: Record<string, { oauth?: string; apikey?: string }> = {
	claude: { oauth: "anthropic", apikey: "anthropic" },
	codex: { oauth: "openai-codex", apikey: "openai" },
	meta: { oauth: "meta", apikey: "meta" },
	devin: { oauth: "devin", apikey: "devin" },
	antigravity: { oauth: "antigravity" },
	gemini: { oauth: "google", apikey: "google" },
	// Without a host, an OpenAI-compatible entry is only known by the name the operator gave it.
	"openai-compatible-openrouter": { apikey: "openrouter" },
};

/** Where an API key leads, by the host it is sent to: whatever its entry is called, and wherever a Claude key goes. */
const API_HOSTS: Record<string, string> = {
	"openrouter.ai": "openrouter",
	"api.openai.com": "openai",
	"api.anthropic.com": "anthropic",
	"generativelanguage.googleapis.com": "google",
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
			? API_HOSTS[account.host]
			: CREDENTIALS[account.provider]?.[account.kind as "oauth" | "apikey"];
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
	const accounts = listed.accounts[modelId];
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
	const owner = listed.owners[modelId];
	if (modelId.includes("/") || !owner) return { upstreams: [] };
	return { upstreams: OWNERS[owner] ?? [{ provider: owner }] };
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
	const upstreams = upstreamsOf(likelyAccounts(listed.accounts[modelId] ?? [], kind), modelId);
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
	const listed: ModelAccounts = { owners: {}, accounts: {} };
	for (const model of body.data) {
		if (!isRecord(model) || typeof model.id !== "string") continue;
		if (typeof model.owned_by === "string") listed.owners[model.id] = model.owned_by.trim().toLowerCase();
		const accounts = parseAccounts(model.accounts);
		if (accounts.length > 0) listed.accounts[model.id] = accounts;
	}
	return listed;
}

/** Tells other extensions where this provider's models come from, and what answered each request. */
export class UpstreamsAnnouncer {
	private listed: ModelAccounts | undefined;
	private running: Promise<void> | undefined;
	/** Whether an extension asked: nothing is fetched for nobody. */
	private wanted = false;

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
		this.pi.on("after_provider_response", (event, ctx) => {
			const model = ctx.model;
			if (!model || model.provider !== this.providerId) return;
			const headers = (event as { headers?: Record<string, string | undefined> }).headers ?? {};
			const header = (wanted: string) =>
				Object.entries(headers).find(([name]) => name.toLowerCase() === wanted)?.[1];
			this.answered(model.id, header(AUTH_KIND_HEADER), header(AUTH_PROVIDER_HEADER), header(AUTH_HOST_HEADER));
		});
		// The Codex WebSocket has no response headers per turn: CLIProxyAPI names what answered on response.created.
		this.pi.on("provider_stream_event", (event) => {
			if (event.provider !== this.providerId) return;
			const data = event.data;
			if (!isRecord(data) || data.type !== "response.created") return;
			const kind = data[AUTH_KIND_FIELD];
			if (typeof kind === "string")
				this.answered(event.model, kind, data[AUTH_PROVIDER_FIELD], data[AUTH_HOST_FIELD]);
		});
	}

	private answered(modelId: string, kindValue: unknown, providerValue: unknown, hostValue: unknown): void {
		const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
		const kind = text(kindValue)?.toLowerCase();
		if (kind !== "oauth" && kind !== "apikey") return;
		const provider = text(providerValue);
		const host = text(hostValue);
		// Named: from the response alone, without waiting for the credential list; only once an extension asked.
		// Kind only (an older CLIProxyAPI): a guess from the list, once it came.
		let upstreams: Upstream[] | undefined;
		if (provider) {
			if (!this.wanted) return;
			upstreams = [statedUpstream(modelId, { provider, kind, ...(host ? { host } : {}) })];
		} else {
			if (!this.listed) return;
			upstreams = answeredUpstreams(modelId, kind, this.listed);
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
			const models: Record<string, Route> = {};
			for (const id of new Set([...Object.keys(this.listed.owners), ...Object.keys(this.listed.accounts)])) {
				models[id] = routeOf(id, this.listed);
			}
			this.pi.events.emit(UPSTREAMS_EVENT, { provider: this.providerId, models });
		})().finally(() => {
			this.running = undefined;
		});
		return this.running;
	}
}
