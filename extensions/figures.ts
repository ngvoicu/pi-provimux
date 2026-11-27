/**
 * The prices and cache lifetimes a Provimux gateway gives for the providers.dev entry of each answer, held and handed on
 * to other extensions (pi-cache-keeper shows them). This extension prices nothing with them: Pi counts each turn at the
 * model's own price, as before.
 *
 * A Provimux that has them answers `/v1/models?include=accounts,figures` with a `figures` object (contract 1): per
 * providers.dev entry (`<provider>/<model>`, the first slash ends the provider) its price, cache lifetimes, input window
 * and output limit. Every answer names its own entry (`X-Provimux-Entry`, or `provimux_entry` on a Codex WebSocket
 * turn's response.created), read by the gateway from the request it really sent: after a fallback to another account,
 * the entry is that account's. Nothing here guesses an entry from a model's name or an account's kind.
 *
 * - The list is read when the models are loaded and when the routes are told (at the start, on `/provimux-refresh`);
 *   once more when an answer names an entry the figures held do not have, once per entry; never once per answer while
 *   it is held. A read that failed is tried again by the next such answer. Such a read hands on its figures only: the
 *   routes stay as last told.
 * - A gateway gives figures when its list has `figures` (whatever its `state`). One that does not (Provimux
 *   8.1.7-pmx.3 or older, plain CLIProxyAPI) is read and used exactly as before.
 */
import type { Account } from "./sources.ts";

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

/** What a model list read gave: the list's model owners and accounts, and the figures if any. */
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
 * What the gateway's model list last said, shared by everything in this extension that reads it: the model loads and
 * the routes told to other extensions. One read in flight at a time; a second asker shares it.
 */
export class GatewayList {
	/** The gateway gives figures: its list had `figures`. Undefined: not known yet. */
	supports: boolean | undefined;
	private latest: ListedSources | undefined;
	private inflight: { key: string; promise: Promise<ListedSources> } | undefined;
	/** The entries whose answers already brought a read of their own. */
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
				this.take(sources);
				return sources;
			})
			.finally(() => {
				if (this.inflight?.promise === promise) this.inflight = undefined;
			});
		this.inflight = { key, promise };
		return promise;
	}

	private take(sources: ListedSources): void {
		// A list that was not read says nothing, either way.
		if (!sources.read) return;
		if (sources.figures) this.supports = true;
		else if (!sources.answers) this.supports = false;
		this.latest = sources;
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
		return this.latest?.figures;
	}

	/**
	 * An answer named this entry: where the figures held lack it, the list is read once more, once per entry. A read that
	 * failed counts as not done: the next such answer reads again. An answer that names an entry is from a gateway that
	 * gives figures, also where the list could not be read before.
	 */
	noteAnswer(entry: string): void {
		this.supports = true;
		const figures = this.latest?.figures;
		if (figures && Object.hasOwn(figures.entries, entry)) return;
		if (this.readFor.has(entry)) return;
		this.readFor.add(entry);
		const connection = this.connection();
		if (!connection) {
			this.readFor.delete(entry);
			return;
		}
		const failed = () => this.readFor.delete(entry);
		void this.read(connection.plainModelsUrl, connection.apiKey).then((sources) => {
			if (!sources.read) failed();
		}, failed);
	}

	/** A list read by hand (`/provimux-refresh`): every answer may bring its one read again. */
	forgetReads(): void {
		this.readFor.clear();
	}
}
