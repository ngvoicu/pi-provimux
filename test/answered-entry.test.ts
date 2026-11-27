import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	decodeWireValue,
	entryCost,
	GatewayList,
	type ListedSources,
	parseFigures,
	priceAnswersWith,
	priceByEntry,
	type SourcesReader,
} from "../extensions/figures.ts";
import { fetchModelSources, figuresCostFor } from "../extensions/lib.ts";
import { parseAccounts } from "../extensions/sources.ts";
import {
	type Account,
	ANSWERED_EVENT,
	type AnswerCallbacks,
	answeredEntry,
	answeredOptions,
	type ModelAccounts,
	REQUEST_EVENT,
	routeOf,
	routesOfSources,
	UPSTREAMS_EVENT,
	UpstreamsAnnouncer,
} from "../extensions/upstreams.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** One entry of a gateway's figures, contract 1 (prices-and-cache/openapi.yaml, Entry), as the gateway gives it. */
function entry(price: Record<string, unknown>, cache: { short?: number | null; long?: number | null } = {}) {
	const lifetime = (seconds: number | null | undefined) => ({
		rely_on_s: seconds ?? null,
		basis: seconds === undefined || seconds === null ? "none" : "measured",
		date: "2026-11-17",
	});
	return {
		provider: "openrouter",
		model: "anthropic/claude-fable-5.2",
		price: {
			billing: "per_use",
			reference: null,
			input: 10,
			output: 50,
			cache_read: 0.5,
			cache_write: [
				{ lifetime_s: 300, price: 12.5 },
				{ lifetime_s: 3600, price: 20 },
			],
			tiers: [],
			...price,
		},
		cache: { short: lifetime(cache.short), long: lifetime(cache.long) },
		input_window: { tokens: 1_000_000, at_least: false },
		max_output: { tokens: 128_000, at_least: false },
	};
}

const OPENROUTER = "openrouter/anthropic/claude-fable-5.2";
const LOGIN_ENTRY = "claude-subscription/claude-fable-5-2";
const held = (entries: Record<string, unknown>) => ({ contract: 1, state: "held", dataset_version: "d1", entries });

describe("an entry's price, as Pi counts it", () => {
	it("per use and for comparison; the cache write of the shortest lifetime; a missing cache read counts 0", () => {
		expect(entryCost(entry({}))).toEqual({ input: 10, output: 50, cacheRead: 0.5, cacheWrite: 12.5 });
		expect(entryCost(entry({ billing: "reference", reference: "anthropic/claude-fable-5-2" }))?.input).toBe(10);
		expect(entryCost(entry({ cache_read: null, cache_write: [] }))).toEqual({
			input: 10,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
		});
		// A write price the source states without a lifetime comes before every timed one.
		const unstated = entry({
			cache_write: [
				{ lifetime_s: null, price: 11 },
				{ lifetime_s: 300, price: 12.5 },
			],
		});
		expect(entryCost(unstated)?.cacheWrite).toBe(11);
	});

	it("none where the entry is not priced per token or for comparison, or lacks a base price", () => {
		expect(entryCost(entry({ billing: "unknown" }))).toBeUndefined();
		expect(entryCost(entry({ billing: "something-new" }))).toBeUndefined();
		expect(entryCost(entry({ input: null }))).toBeUndefined();
		expect(entryCost(entry({ output: -1 }))).toBeUndefined();
		expect(entryCost({ provider: "x" })).toBeUndefined();
		expect(entryCost("junk")).toBeUndefined();
	});

	it("prices above a prompt size, ascending; a price a tier leaves out is the one below it", () => {
		const tiered = entry({
			tiers: [
				{ input_tokens_above: 400_000, input: 30, output: null, cache_read: null, cache_write: null },
				{ input_tokens_above: 200_000, input: 20, output: 75, cache_read: 1, cache_write: null },
			],
		});
		expect(entryCost(tiered)?.tiers).toEqual([
			{ inputTokensAbove: 200_000, input: 20, output: 75, cacheRead: 1, cacheWrite: 12.5 },
			{ inputTokensAbove: 400_000, input: 30, output: 75, cacheRead: 1, cacheWrite: 12.5 },
		]);
	});
});

describe("an answer's entry as it is written on the wire", () => {
	it("is percent-decoded as UTF-8; a form that can't be read is none", () => {
		expect(decodeWireValue(OPENROUTER)).toBe(OPENROUTER);
		expect(decodeWireValue("house/model%20v3%25")).toBe("house/model v3%");
		expect(decodeWireValue("lab/mod%C3%A8le")).toBe("lab/modèle");
		expect(decodeWireValue("lab/%ZZ")).toBeUndefined();
		expect(decodeWireValue("lab/%C3")).toBeUndefined();
	});
});

describe("the gateway's figures", () => {
	it("are held entries only while the gateway holds them", () => {
		expect(parseFigures(held({ [OPENROUTER]: entry({}) }))?.entries[OPENROUTER]).toBeDefined();
		expect(parseFigures({ state: "off", entries: { [OPENROUTER]: entry({}) } })?.entries).toEqual({});
		expect(parseFigures({ state: "none", entries: {} })?.state).toBe("none");
		expect(parseFigures(undefined)).toBeUndefined();
		expect(parseFigures([])).toBeUndefined();
	});
});

describe("the model list, from a gateway with figures", () => {
	const row = (answered?: unknown) => ({
		provider: "claude",
		kind: "oauth",
		priority: 5,
		account: "a.aaaaaaaaaaaaaaaaaaaa",
		...(answered === undefined ? {} : { answered }),
	});

	it("is asked once as before; a list whose accounts record answers is asked again, with the figures", async () => {
		const urls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				urls.push(url);
				const figures = url.endsWith(",figures") ? { figures: held({ [LOGIN_ENTRY]: entry({}) }) } : {};
				return new Response(
					JSON.stringify({
						data: [{ id: "claude-fable-5-2", owned_by: "anthropic", accounts: [row([])] }],
						...figures,
					}),
				);
			}),
		);
		const sources = await fetchModelSources("http://gw/v1/models", "k");
		expect(urls).toEqual(["http://gw/v1/models?include=accounts", "http://gw/v1/models?include=accounts,figures"]);
		expect(sources.figures?.entries[LOGIN_ENTRY]).toBeDefined();
		expect(sources.accounts.get("claude-fable-5-2")?.[0]).toMatchObject({
			account: "a.aaaaaaaaaaaaaaaaaaaa",
			answered: [],
		});

		// Known to give figures: one read, with them.
		urls.length = 0;
		await fetchModelSources("http://gw/v1/models", "k", 1000, undefined, true);
		expect(urls).toEqual(["http://gw/v1/models?include=accounts,figures"]);
	});

	it("a list whose accounts record nothing (Provimux 8.1.7-pmx.3, plain CLIProxyAPI) is read once, as before", async () => {
		const urls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				urls.push(url);
				return new Response(JSON.stringify({ data: [{ id: "opus", accounts: [row()] }] }));
			}),
		);
		const sources = await fetchModelSources("http://gw/v1/models", "k");
		expect(urls).toEqual(["http://gw/v1/models?include=accounts"]);
		expect(sources.figures).toBeUndefined();
		expect(sources.answers).toBeUndefined();
	});

	it("an account row keeps its marker and its record; a row without them reads as before", () => {
		expect(parseAccounts([{ provider: "claude", kind: "oauth", priority: 1 }])).toEqual([
			{ provider: "claude", kind: "oauth", priority: 1 },
		]);
		expect(
			parseAccounts([
				row([{ entry: LOGIN_ENTRY, on: "2026-11-27" }, { entry: null, on: "2026-11-20" }, { entry: 7 }]),
			]),
		).toEqual([
			{
				provider: "claude",
				kind: "oauth",
				priority: 5,
				account: "a.aaaaaaaaaaaaaaaaaaaa",
				answered: [{ entry: LOGIN_ENTRY, on: "2026-11-27" }, { entry: null, on: "2026-11-20" }, { entry: null }],
			},
		]);
	});
});

describe("a model's price before an answer", () => {
	const figures = parseFigures(
		held({
			[LOGIN_ENTRY]: entry({ input: 8, output: 40 }),
			[OPENROUTER]: entry({}),
			"x/unpriced": entry({ billing: "unknown" }),
		}),
	);
	const account = (priority: number, answered?: Account["answered"]): Account => ({
		provider: "claude",
		kind: "oauth",
		priority,
		...(answered ? { answered } : {}),
	});

	it("is what the account tried first last answered as", () => {
		expect(
			figuresCostFor([account(5, [{ entry: LOGIN_ENTRY }]), account(0, [{ entry: OPENROUTER }])], figures)?.input,
		).toBe(8);
		// The newest item counts.
		expect(figuresCostFor([account(5, [{ entry: OPENROUTER }, { entry: LOGIN_ENTRY }])], figures)?.input).toBe(10);
	});

	it("none, so models.dev's price as before, where it is not one price or not known", () => {
		expect(figuresCostFor([account(5, [])], figures)).toBeUndefined();
		expect(figuresCostFor([account(5)], figures)).toBeUndefined();
		expect(figuresCostFor([account(5, [{ entry: null }])], figures)).toBeUndefined();
		expect(figuresCostFor([account(5, [{ entry: "x/unpriced" }])], figures)).toBeUndefined();
		expect(figuresCostFor([account(5, [{ entry: "not/held" }])], figures)).toBeUndefined();
		// Two accounts share the first place and are priced differently.
		expect(
			figuresCostFor([account(5, [{ entry: LOGIN_ENTRY }]), account(5, [{ entry: OPENROUTER }])], figures),
		).toBeUndefined();
		expect(figuresCostFor([account(5, [{ entry: LOGIN_ENTRY }])], undefined)).toBeUndefined();
	});
});

describe("a route's entry", () => {
	const login = (answered?: Account["answered"]): Account => ({
		provider: "claude",
		kind: "oauth",
		priority: 5,
		...(answered ? { answered } : {}),
	});
	const openrouter = (answered?: Account["answered"]): Account => ({
		provider: "openai-compatible-openrouter",
		kind: "apikey",
		priority: 0,
		host: "openrouter.ai",
		...(answered ? { answered } : {}),
	});
	const route = (accounts: Account[]) =>
		routeOf("claude-fable-5-2", {
			owners: { "claude-fable-5-2": "anthropic" },
			accounts: { "claude-fable-5-2": accounts },
		});

	it("is what the account's answers named; with nothing recorded the upstream is as before", () => {
		expect(answeredEntry(login())).toBeUndefined();
		expect(answeredEntry(login([]))).toBeUndefined();
		expect(answeredEntry(login([{ entry: LOGIN_ENTRY }]))).toBe(LOGIN_ENTRY);
		expect(answeredEntry(login([{ entry: null }]))).toBeNull();
		expect(answeredEntry(login([{ entry: LOGIN_ENTRY }, { entry: null }]))).toBeNull();

		expect(route([login([]), openrouter([])])).toEqual(route([login(), openrouter()]));
		expect(route([login([]), openrouter([{ entry: OPENROUTER }])])).toEqual({
			upstreams: [{ provider: "anthropic", subscription: true }],
			fallbacks: [{ provider: "openrouter", subscription: false, entry: OPENROUTER }],
		});
		expect(route([login([{ entry: null }])])).toEqual({
			upstreams: [{ provider: "anthropic", subscription: true, entry: null }],
		});
	});

	it("an account that leads somewhere not known is known by the entry it answered as", () => {
		const elsewhere: Account = {
			provider: "openai-compatible-x",
			kind: "apikey",
			priority: 0,
			host: "relay.example.test",
		};
		expect(route([elsewhere])).toEqual({ upstreams: [] });
		expect(route([{ ...elsewhere, answered: [{ entry: OPENROUTER }] }])).toEqual({
			upstreams: [
				{ provider: "openrouter", model: "anthropic/claude-fable-5.2", subscription: false, entry: OPENROUTER },
			],
		});
	});
});

describe("each answer counted at the price of its entry", () => {
	const usage = () => ({
		input: 4100,
		output: 14,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 4114,
		cost: { input: 0.0328, output: 0.00056, cacheRead: 0, cacheWrite: 0, total: 0.03336 },
	});

	it("where the gateway gives a price for the entry the answer named; as before otherwise", () => {
		const release = priceAnswersWith("provimux-test", (ref) =>
			ref === OPENROUTER ? entryCost(entry({})) : undefined,
		);
		try {
			const priced = { provider: "provimux-test", usage: usage() };
			priceByEntry(priced, OPENROUTER);
			expect(priced.usage.cost.total).toBeCloseTo(0.041 + 0.0007, 10);

			for (const [provider, ref] of [
				["provimux-test", "not/held"],
				["another", OPENROUTER],
			]) {
				const kept = { provider, usage: usage() };
				priceByEntry(kept, ref);
				expect(kept.usage.cost.total).toBe(0.03336);
			}
			const reported = {
				provider: "provimux-test",
				usage: { ...usage(), cost: { ...usage().cost, totalFromProvider: true } },
			};
			priceByEntry(reported, OPENROUTER);
			expect(reported.usage.cost.total).toBe(0.03336);
		} finally {
			release();
		}
	});
});

describe("the read an answer brings", () => {
	const sources = (figures: Record<string, unknown>, answered: Account["answered"] = []): ListedSources => ({
		owners: new Map(),
		accounts: new Map([
			[
				"claude-fable-5-2",
				[{ provider: "x", kind: "apikey", priority: 0, account: "a.bbbbbbbbbbbbbbbbbbbb", answered }],
			],
		]),
		figures: parseFigures(held(figures)),
		answers: true,
		read: true,
	});

	it("is one read for an entry the figures lack or the account's row does not list, never one per answer", async () => {
		const reader = vi.fn(async (..._args: Parameters<SourcesReader>) => sources({}));
		const gateway = new GatewayList(reader, () => ({ plainModelsUrl: "http://gw/v1/models", apiKey: "k" }));
		await gateway.read("http://gw/v1/models", "k");
		expect(gateway.supports).toBe(true);
		reader.mockClear();
		gateway.noteAnswer("claude-fable-5-2", "a.bbbbbbbbbbbbbbbbbbbb", OPENROUTER);
		gateway.noteAnswer("claude-fable-5-2", "a.bbbbbbbbbbbbbbbbbbbb", OPENROUTER);
		await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(1));
		expect(reader.mock.calls[0]?.[4]).toBe(true);
		// Held and listed: nothing to read.
		reader.mockResolvedValue(sources({ [OPENROUTER]: entry({}) }, [{ entry: OPENROUTER }]));
		await gateway.read("http://gw/v1/models", "k", undefined, undefined, false);
		reader.mockClear();
		gateway.noteAnswer("claude-fable-5-2", "a.bbbbbbbbbbbbbbbbbbbb", OPENROUTER);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(reader).not.toHaveBeenCalled();
		expect(gateway.priceOf(OPENROUTER)?.input).toBe(10);
	});

	it("nothing from a gateway that gives no figures", async () => {
		const reader = vi.fn(
			async (): Promise<ListedSources> => ({ owners: new Map(), accounts: new Map(), read: true }),
		);
		const gateway = new GatewayList(reader, () => ({ plainModelsUrl: "http://gw/v1/models", apiKey: "k" }));
		await gateway.read("http://gw/v1/models", "k");
		expect(gateway.supports).toBe(false);
		reader.mockClear();
		gateway.noteAnswer("claude-fable-5-2", "a.bbbbbbbbbbbbbbbbbbbb", OPENROUTER);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(reader).not.toHaveBeenCalled();
	});
});

describe("the events, from a gateway with figures", () => {
	/** pi as the tests of upstreams.test.ts stand it in: each call is a request of its own, with its own callbacks. */
	function fakePi() {
		const registered = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const listeners = new Map<string, (data: unknown) => void>();
		const emitted: Array<[string, unknown]> = [];
		type Sent = { provider: string; id: string };
		const session = {
			onResponse: () => undefined,
			onProviderStreamEvent: (data: unknown, model: Sent) =>
				registered.get("provider_stream_event")?.(
					{ type: "provider_stream_event", provider: model.provider, api: "x", model: model.id, data },
					{},
				),
		};
		const model = { provider: "provimux", id: "claude-fable-5-2" };
		const pi = {
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => registered.set(name, handler),
			events: {
				emit: (channel: string, data: unknown) => emitted.push([channel, data]),
				on: (channel: string, handler: (data: unknown) => void) => {
					listeners.set(channel, handler);
					return () => {};
				},
			},
		} as unknown as ExtensionAPI;
		/** An HTTP answer with these headers, then its stream's first event. */
		const respond = (headers: Record<string, string>) => {
			const sent = answeredOptions<AnswerCallbacks<Sent>>(session) as Required<AnswerCallbacks<Sent>>;
			sent.onResponse({ status: 200, headers }, model);
			sent.onProviderStreamEvent({ type: "message_start" }, model);
		};
		/** A Codex WebSocket turn: its response.created, no headers. */
		const created = (fields: Record<string, unknown>) => {
			const sent = answeredOptions<AnswerCallbacks<Sent>>(session) as Required<AnswerCallbacks<Sent>>;
			sent.onProviderStreamEvent({ type: "response.created", response: { id: "resp_1" }, ...fields }, model);
		};
		return { pi, listeners, emitted, respond, created };
	}

	const routes: ModelAccounts = routesOfSources({
		owners: new Map([["claude-fable-5-2", "anthropic"]]),
		accounts: new Map([
			[
				"claude-fable-5-2",
				[
					{ provider: "claude", kind: "oauth", priority: 5, account: "a.cccccccccccccccccccc", answered: [] },
					{
						provider: "openai-compatible-openrouter",
						kind: "apikey",
						priority: 0,
						host: "openrouter.ai",
						account: "a.dddddddddddddddddddd",
						answered: [{ entry: OPENROUTER }],
					},
				],
			],
		]),
		figures: parseFigures(held({ [OPENROUTER]: entry({}) })),
		answers: true,
		read: true,
	});

	async function announcer(supports: boolean | undefined) {
		const fake = fakePi();
		const reader = vi.fn(async (): Promise<ListedSources> => ({ owners: new Map(), accounts: new Map() }));
		const gateway = new GatewayList(reader, () => null);
		gateway.supports = supports;
		const it = new UpstreamsAnnouncer(
			fake.pi,
			"provimux",
			() => ({ baseUrlInput: "x", apiKey: "k" }),
			async () => routes,
			undefined,
			gateway,
		);
		it.register();
		fake.listeners.get(REQUEST_EVENT)!({});
		await it.announce();
		return fake;
	}

	it("the routes carry the entries the accounts answered as, and the figures", async () => {
		const { emitted } = await announcer(true);
		const told = emitted.find(([channel]) => channel === UPSTREAMS_EVENT)?.[1] as {
			models: Record<string, unknown>;
			figures: { state: string; entries: Record<string, unknown> };
		};
		expect(told.models["claude-fable-5-2"]).toEqual({
			upstreams: [{ provider: "anthropic", subscription: true }],
			fallbacks: [{ provider: "openrouter", subscription: false, entry: OPENROUTER }],
		});
		expect(told.figures.state).toBe("held");
		expect(Object.keys(told.figures.entries)).toEqual([OPENROUTER]);
	});

	it("an answer names its entry and its account, over HTTP and over the Codex WebSocket", async () => {
		const { emitted, respond, created } = await announcer(true);
		emitted.length = 0;
		respond({
			"X-CPA-AUTH-KIND": "apikey",
			"X-CPA-AUTH-PROVIDER": "openai-compatible-openrouter",
			"X-CPA-AUTH-HOST": "openrouter.ai",
			"X-Provimux-Account": "a.dddddddddddddddddddd",
			"X-Provimux-Entry": OPENROUTER,
		});
		created({
			cpa_auth_kind: "oauth",
			cpa_auth_provider: "claude",
			provimux_account: "a.cccccccccccccccccccc",
			provimux_entry: "claude-subscription/claude-fable-5-2",
		});
		expect(emitted).toEqual([
			[
				ANSWERED_EVENT,
				{
					provider: "provimux",
					model: "claude-fable-5-2",
					upstreams: [
						{
							provider: "openrouter",
							subscription: false,
							entry: OPENROUTER,
							account: "a.dddddddddddddddddddd",
						},
					],
				},
			],
			[
				ANSWERED_EVENT,
				{
					provider: "provimux",
					model: "claude-fable-5-2",
					upstreams: [
						{
							provider: "anthropic",
							subscription: true,
							entry: "claude-subscription/claude-fable-5-2",
							account: "a.cccccccccccccccccccc",
						},
					],
				},
			],
		]);
	});

	it("an answer that names its account and no entry has none; one whose entry can't be read has none", async () => {
		const { emitted, respond } = await announcer(true);
		emitted.length = 0;
		const named = {
			"X-CPA-AUTH-KIND": "apikey",
			"X-CPA-AUTH-PROVIDER": "openai-compatible-house",
			"X-CPA-AUTH-HOST": "llm.example.test",
		};
		respond({ ...named, "X-Provimux-Account": "a.eeeeeeeeeeeeeeeeeeee" });
		respond({ ...named, "X-Provimux-Account": "a.eeeeeeeeeeeeeeeeeeee", "X-Provimux-Entry": "lab/%ZZ" });
		const upstreams = emitted.map(([, data]) => (data as { upstreams: Array<Record<string, unknown>> }).upstreams[0]);
		expect(upstreams.map((upstream) => [upstream?.entry, upstream?.account])).toEqual([
			[null, "a.eeeeeeeeeeeeeeeeeeee"],
			[null, "a.eeeeeeeeeeeeeeeeeeee"],
		]);
	});

	it("from a gateway that names the account only (8.1.7-pmx.3), the answer is reported as before", async () => {
		const { emitted, respond } = await announcer(false);
		emitted.length = 0;
		respond({
			"X-CPA-AUTH-KIND": "apikey",
			"X-CPA-AUTH-PROVIDER": "openai-compatible-openrouter",
			"X-CPA-AUTH-HOST": "openrouter.ai",
			"X-Provimux-Account": "a.dddddddddddddddddddd",
		});
		expect(emitted).toEqual([
			[
				ANSWERED_EVENT,
				{
					provider: "provimux",
					model: "claude-fable-5-2",
					upstreams: [{ provider: "openrouter", subscription: false }],
				},
			],
		]);
	});
});
