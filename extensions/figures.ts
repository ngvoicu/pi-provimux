/**
 * The prices and cache lifetimes a Provimux gateway gives for the providers.dev entry of each answer.
 *
 * A Provimux that has them answers `/v1/models?include=accounts,figures` with a `figures` object (contract 1): per
 * providers.dev entry (`<provider>/<model>`, the first slash ends the provider) its price, cache lifetimes, input window
 * and output limit. Every answer names its own entry (`X-Provimux-Entry`, or `provimux_entry` on a Codex WebSocket
 * turn's response.created), read by the gateway from the request it really sent: after a fallback to another account,
 * the entry is that account's. Nothing here guesses an entry from a model's name or an account's kind.
 *
 * - The list is read when the models are loaded (at the start, on `/provimux-refresh`); once more when an answer names
 *   an entry the copy held does not have, or that its account's row does not list yet; never once per answer.
 * - A gateway gives figures when its list has `figures` (whatever its `state`). One that does not (Provimux
 *   8.1.7-pmx.3 or older, plain CLIProxyAPI) is read and used exactly as before.
 */
import { calculateCost } from "@earendil-works/pi-ai/models";
import type { Account } from "./sources.ts";

/** Prices in US dollars per million tokens, in the shape of Pi's model `cost`. */
export interface EntryCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: Array<{ input: number; output: number; cacheRead: number; cacheWrite: number; inputTokensAbove: number }>;
}

/** The gateway's `figures` object as read: its state and dates, and its entries as the gateway gave them. */
export interface GatewayFigures {
	contract?: number;
	/** held, none, off (or a value not known: as none). */
	state: string;
	datasetVersion?: string;
	generatedAt?: string;
	fetchedAt?: string;
	/** Entry → its figures, as given (without a prototype: an entry called `__proto__` is an entry). */
	entries: Record<string, unknown>;
}

/** What a model list read gave, for the figures: the list's model owners and accounts, and the figures if any. */
export interface ListedSources {
	owners: Map<string, string>;
	accounts: Map<string, Account[]>;
	figures?: GatewayFigures;
	/** Any account row carries `answered`: a gateway that names answers' entries. */
	answers?: boolean;
	read?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
const price = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** The `figures` object of a list answer; undefined when there is none (a gateway without figures). */
export function parseFigures(value: unknown): GatewayFigures | undefined {
	if (!isRecord(value)) return undefined;
	const entries: Record<string, unknown> = Object.create(null);
	if (isRecord(value.entries)) {
		for (const [ref, entry] of Object.entries(value.entries)) if (isRecord(entry)) entries[ref] = entry;
	}
	const state = text(value.state) ?? "unknown";
	return {
		...(typeof value.contract === "number" ? { contract: value.contract } : {}),
		state,
		...(text(value.dataset_version) ? { datasetVersion: value.dataset_version as string } : {}),
		...(text(value.generated_at) ? { generatedAt: value.generated_at as string } : {}),
		...(text(value.fetched_at) ? { fetchedAt: value.fetched_at as string } : {}),
		// With the gateway's figures off or none held, no entry is used whatever the list holds.
		entries: state === "held" ? entries : Object.create(null),
	};
}

/** The figures as handed on to other extensions: the gateway's own field names, the entries as it gave them. */
export function handOnFigures(figures: GatewayFigures): Record<string, unknown> {
	return {
		...(figures.contract !== undefined ? { contract: figures.contract } : {}),
		state: figures.state,
		...(figures.datasetVersion ? { dataset_version: figures.datasetVersion } : {}),
		...(figures.generatedAt ? { generated_at: figures.generatedAt } : {}),
		...(figures.fetchedAt ? { fetched_at: figures.fetchedAt } : {}),
		entries: { ...figures.entries },
	};
}

/**
 * An entry's price as Pi's `cost`: the base input and output price, the cache read price (0 where none is stated, as
 * Pi counts a price it lacks), the cache write price of the lifetime not stated or else the shortest (Pi's own
 * convention), and one tier per prompt size a price changes at. Undefined where the entry is not priced per token or
 * for comparison (`billing` `unknown`, or a value not known), or has no base input or output price.
 */
export function entryCost(entry: unknown): EntryCost | undefined {
	if (!isRecord(entry) || !isRecord(entry.price)) return undefined;
	const p = entry.price;
	if (p.billing !== "per_use" && p.billing !== "reference") return undefined;
	const input = price(p.input);
	const output = price(p.output);
	if (input === undefined || output === undefined) return undefined;
	const writes = (Array.isArray(p.cache_write) ? p.cache_write : [])
		.filter(isRecord)
		.map((item) => ({ lifetime: item.lifetime_s, price: price(item.price) }))
		.filter((item): item is { lifetime: unknown; price: number } => item.price !== undefined);
	const unstated = writes.find((item) => item.lifetime === null || item.lifetime === undefined);
	const timed = writes
		.filter((item) => typeof item.lifetime === "number" && item.lifetime > 0)
		.sort((a, b) => (a.lifetime as number) - (b.lifetime as number));
	const cost: EntryCost = {
		input,
		output,
		cacheRead: price(p.cache_read) ?? 0,
		cacheWrite: (unstated ?? timed[0])?.price ?? 0,
	};
	const tiers: NonNullable<EntryCost["tiers"]> = [];
	let previous = { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite };
	const items = (Array.isArray(p.tiers) ? p.tiers : [])
		.filter(isRecord)
		.filter((tier) => typeof tier.input_tokens_above === "number" && Number.isSafeInteger(tier.input_tokens_above))
		.sort((a, b) => (a.input_tokens_above as number) - (b.input_tokens_above as number));
	for (const tier of items) {
		const next = {
			input: price(tier.input) ?? previous.input,
			output: price(tier.output) ?? previous.output,
			cacheRead: price(tier.cache_read) ?? previous.cacheRead,
			cacheWrite: price(tier.cache_write) ?? previous.cacheWrite,
		};
		tiers.push({ ...next, inputTokensAbove: tier.input_tokens_above as number });
		previous = next;
	}
	if (tiers.length > 0) cost.tiers = tiers;
	return cost;
}

/**
 * A value of an answer's statement as the gateway writes it: a byte outside printable ASCII, a space or `%` as `%` and
 * two hex digits. Undefined where it is not that form or not UTF-8.
 */
export function decodeWireValue(value: string): string | undefined {
	if (!value.includes("%")) return value;
	const bytes: number[] = [];
	for (let i = 0; i < value.length; i++) {
		const char = value.charCodeAt(i);
		if (value[i] === "%") {
			const hex = value.slice(i + 1, i + 3);
			if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return undefined;
			bytes.push(Number.parseInt(hex, 16));
			i += 2;
		} else if (char < 0x80) {
			bytes.push(char);
		} else {
			return undefined;
		}
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
	} catch {
		return undefined;
	}
}

/** Reads the model list with its accounts; with `figures`, asks for the figures too. */
export type SourcesReader = (
	plainModelsUrl: string,
	apiKey: string,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	figures: boolean,
) => Promise<ListedSources>;

/**
 * What the gateway's model list last said, shared by everything in this extension that reads it: the model loads, the
 * routes told to other extensions, and the price of each answer. One read in flight at a time; a second asker shares it.
 */
export class GatewayList {
	/** The gateway gives figures: its list had `figures`. Undefined: not known yet. */
	supports: boolean | undefined;
	private latest: { key: string; sources: ListedSources } | undefined;
	private inflight: { key: string; promise: Promise<ListedSources> } | undefined;
	/** The answers that already brought a read of their own: model, account and entry. */
	private readFor = new Set<string>();
	private listeners = new Set<() => void>();

	constructor(
		private readonly reader: SourcesReader,
		/** Where the list is, for a read an answer brings. */
		private readonly connection: () => { plainModelsUrl: string; apiKey: string } | null,
		private readonly timeoutMs = 10_000,
	) {}

	/**
	 * Reads the list and keeps what it said. `share`: a read already on its way for the same gateway and key serves this
	 * one too (the routes, the read an answer brings); a model load always reads for itself.
	 */
	read(
		plainModelsUrl: string,
		apiKey: string,
		timeoutMs = this.timeoutMs,
		signal?: AbortSignal,
		share = true,
	): Promise<ListedSources> {
		const key = `${plainModelsUrl}\n${apiKey}`;
		if (share && this.inflight?.key === key) return this.inflight.promise;
		const promise = this.reader(plainModelsUrl, apiKey, timeoutMs, signal, this.supports === true)
			.then((sources) => {
				this.take(key, sources);
				return sources;
			})
			.finally(() => {
				if (this.inflight?.promise === promise) this.inflight = undefined;
			});
		this.inflight = { key, promise };
		return promise;
	}

	/** The list last read for this gateway and key, if any. */
	current(plainModelsUrl: string, apiKey: string): ListedSources | undefined {
		return this.latest?.key === `${plainModelsUrl}\n${apiKey}` ? this.latest.sources : undefined;
	}

	private take(key: string, sources: ListedSources): void {
		// A list that was not read says nothing, either way.
		if (!sources.read) return;
		if (sources.figures) this.supports = true;
		else if (!sources.answers) this.supports = false;
		this.latest = { key, sources };
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// A listener never stops the others.
			}
		}
	}

	/** Called after each list read that was read. Returns what removes it. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** The figures last read. */
	figures(): GatewayFigures | undefined {
		return this.latest?.sources.figures;
	}

	/** The price of an entry, where the figures last read give one. */
	priceOf(entry: string): EntryCost | undefined {
		const figures = this.figures();
		return figures && Object.hasOwn(figures.entries, entry) ? entryCost(figures.entries[entry]) : undefined;
	}

	/**
	 * An answer named this entry: where the figures held lack it, or its account's row does not list it yet (the
	 * account's first answer for this name), the list is read once more, once per model, account and entry.
	 */
	noteAnswer(modelId: string, account: string | undefined, entry: string): void {
		if (this.supports !== true) return;
		const sources = this.latest?.sources;
		const held = !!sources?.figures && Object.hasOwn(sources.figures.entries, entry);
		const row = account ? sources?.accounts.get(modelId)?.find((one) => one.account === account) : undefined;
		const listed = !account || !!row?.answered?.some((item) => item.entry === entry);
		if (held && listed) return;
		const key = `${modelId}\n${account ?? ""}\n${entry}`;
		if (this.readFor.has(key)) return;
		this.readFor.add(key);
		const connection = this.connection();
		if (!connection) return;
		void this.read(connection.plainModelsUrl, connection.apiKey).catch(() => {});
	}

	/** A list read by hand (`/provimux-refresh`): every answer may bring its one read again. */
	forgetReads(): void {
		this.readFor.clear();
	}
}

const PRICES_KEY = Symbol.for("pi-provimux.entry-prices");

/** Pi provider id → the price of an entry, as that provider's gateway gives it. Shared by every copy of the module. */
function prices(): Map<string, (entry: string) => EntryCost | undefined> {
	const global = globalThis as { [PRICES_KEY]?: Map<string, (entry: string) => EntryCost | undefined> };
	global[PRICES_KEY] ??= new Map();
	return global[PRICES_KEY];
}

/** Where a provider's answers are priced from. Returns what takes it back. */
export function priceAnswersWith(providerId: string, priceOf: (entry: string) => EntryCost | undefined): () => void {
	prices().set(providerId, priceOf);
	return () => {
		if (prices().get(providerId) === priceOf) prices().delete(providerId);
	};
}

interface CostedMessage {
	provider?: unknown;
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cacheWrite1h?: number;
		totalTokens?: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	};
}

/**
 * A message's cost counted again at the price of the entry its answer named, where the gateway gives one: Pi counts it
 * at the model's one price, which is the price of the account tried first. Nothing changes otherwise.
 */
export function priceByEntry(message: unknown, entry: string | undefined): void {
	if (!entry || !isRecord(message)) return;
	const { provider, usage } = message as CostedMessage;
	if (typeof provider !== "string" || !usage || !isRecord(usage.cost)) return;
	const cost = prices().get(provider)?.(entry);
	if (!cost) return;
	const { totalFromProvider } = usage.cost as { totalFromProvider?: unknown };
	// A total the provider reported is the provider's: left as it is.
	if (totalFromProvider === true) return;
	calculateCost({ cost } as Parameters<typeof calculateCost>[0], usage as Parameters<typeof calculateCost>[1]);
}
