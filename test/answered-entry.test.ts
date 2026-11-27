import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	decodeWireValue,
	GatewayList,
	type ListedSources,
	parseFigures,
	type SourcesReader,
} from "../extensions/figures.ts";
import { fetchModelSources, loadMappedModels } from "../extensions/lib.ts";
import { parseAccounts } from "../extensions/sources.ts";
import {
	type Account,
	ANSWERED_EVENT,
	type AnswerCallbacks,
	answeredEntry,
	answeredOptions,
	ENTRY_EVENT,
	type ModelAccounts,
	REQUEST_EVENT,
	routeOf,
	routesOfSources,
	UPSTREAMS_EVENT,
	type Upstream,
	UpstreamsAnnouncer,
} from "../extensions/upstreams.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** One entry of a gateway's figures, contract 1 (prices-and-cache/openapi.yaml, Entry), as the gateway gives it. */
function entry(price: Record<string, unknown> = {}) {
	return {
		provider: "openrouter",
		model: "anthropic/claude-fable-5.2",
		price: {
			billing: "per_use",
			reference: null,
			input: 10,
			output: 50,
			cache_read: 0.5,
			cache_write: [],
			tiers: [],
			...price,
		},
		cache: { short: { rely_on_s: 300, basis: "measured" }, long: { rely_on_s: 3600, basis: "measured" } },
		input_window: { tokens: 1_000_000, at_least: false },
		max_output: { tokens: 128_000, at_least: false },
	};
}

const OPENROUTER = "openrouter/anthropic/claude-fable-5.2";
const LOGIN_ENTRY = "claude-subscription/claude-fable-5-2";
const held = (entries: Record<string, unknown>) => ({ contract: 1, state: "held", dataset_version: "d1", entries });

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
		expect(parseFigures(held({ [OPENROUTER]: entry() }))?.entries[OPENROUTER]).toBeDefined();
		expect(parseFigures({ state: "off", entries: { [OPENROUTER]: entry() } })?.entries).toEqual({});
		expect(parseFigures({ state: "none", entries: {} })?.state).toBe("none");
		expect(parseFigures(undefined)).toBeUndefined();
		expect(parseFigures([])).toBeUndefined();
	});
});

const row = (answered?: unknown) => ({
	provider: "claude",
	kind: "oauth",
	priority: 5,
	account: "a.aaaaaaaaaaaaaaaaaaaa",
	...(answered === undefined ? {} : { answered }),
});

describe("the model list, from a gateway with figures", () => {
	it("is asked once as before; a list whose accounts record answers is asked again, with the figures", async () => {
		const urls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				urls.push(url);
				const figures = url.endsWith(",figures") ? { figures: held({ [LOGIN_ENTRY]: entry() }) } : {};
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

// The review's case (2026-11-27): an alias the owner set, `opus`, whose login has answered and is recorded; the list
// is loaded again. Pi's price for it is the model's listed one, exactly as without the figures: nothing is priced from
// them, also not Fast mode's price.
describe("prices: pi-provimux prices nothing from the gateway's figures", () => {
	it("a model's registered price is the same with the figures and the record as without them", async () => {
		const opus = "claude-subscription/claude-opus-5-5";
		const gpt = "openai/gpt-6.1-sol";
		const rows = (recorded: boolean) => [
			{
				id: "opus",
				owned_by: "anthropic",
				accounts: [{ ...row(recorded ? [{ entry: opus }] : undefined), priority: 1 }],
			},
			{
				id: "gpt-6.1-sol",
				owned_by: "openai",
				accounts: [
					{
						provider: "codex",
						kind: "apikey",
						priority: 1,
						account: "s.bbbbbbbbbbbbbbbbbbbb",
						...(recorded ? { answered: [{ entry: gpt }] } : {}),
					},
				],
			},
		];
		const figures = held({
			[gpt]: entry({ input: 4, output: 20, cache_read: null }),
			[opus]: entry({ billing: "reference", input: 4, output: 20 }),
		});
		const load = async (recorded: boolean, fast: boolean) => {
			vi.stubGlobal("fetch", async (input: unknown) => {
				const url = String(input);
				if (url.includes("models.dev"))
					return Response.json({
						openai: {
							models: {
								"gpt-6.1-sol": {
									cost: { input: 4, output: 20 },
									experimental: { modes: { fast: { cost: { input: 8, output: 40 } } } },
								},
							},
						},
					});
				if (url.includes("client_version"))
					return Response.json({
						models: [{ slug: "opus" }, { slug: "gpt-6.1-sol", service_tiers: ["priority"] }],
					});
				return Response.json({
					data: rows(recorded),
					...(recorded && url.endsWith(",figures") ? { figures } : {}),
				});
			});
			const loaded = await loadMappedModels("http://fixture.invalid", "k", fast, undefined);
			return Object.fromEntries(loaded.models.map((model) => [model.id, model.cost]));
		};
		for (const fast of [false, true]) expect(await load(true, fast)).toEqual(await load(false, fast));
		expect((await load(true, false)).opus).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});
});

describe("a route's entry and accounts", () => {
	const login = (answered?: Account["answered"], account = "a.cccccccccccccccccccc"): Account => ({
		provider: "claude",
		kind: "oauth",
		priority: 5,
		account,
		...(answered ? { answered } : {}),
	});
	const openrouter = (answered?: Account["answered"]): Account => ({
		provider: "openai-compatible-openrouter",
		kind: "apikey",
		priority: 0,
		host: "openrouter.ai",
		account: "a.dddddddddddddddddddd",
		...(answered ? { answered } : {}),
	});
	const route = (accounts: Account[]) =>
		routeOf("claude-fable-5-2", {
			owners: { "claude-fable-5-2": "anthropic" },
			accounts: { "claude-fable-5-2": accounts },
		});
	/** A route as a reader that knows no entry reads it: provider, model and kind only. */
	const asBefore = (told: { upstreams: Upstream[]; fallbacks?: Upstream[] }) =>
		JSON.parse(
			JSON.stringify(told, (key, value) => (key === "entry" || key === "accounts" ? undefined : value)),
		) as unknown;

	it("is what the account's answers named, with its marker; with nothing recorded the entry is not said", () => {
		expect(answeredEntry(login())).toBeUndefined();
		expect(answeredEntry(login([]))).toBeUndefined();
		expect(answeredEntry(login([{ entry: LOGIN_ENTRY }]))).toBe(LOGIN_ENTRY);
		expect(answeredEntry(login([{ entry: null }]))).toBeNull();
		expect(answeredEntry(login([{ entry: LOGIN_ENTRY }, { entry: null }]))).toBeNull();

		expect(route([login([]), openrouter([{ entry: OPENROUTER }])])).toEqual({
			upstreams: [{ provider: "anthropic", subscription: true, accounts: ["a.cccccccccccccccccccc"] }],
			fallbacks: [
				{ provider: "openrouter", subscription: false, entry: OPENROUTER, accounts: ["a.dddddddddddddddddddd"] },
			],
		});
		expect(route([login()])).toEqual({ upstreams: [{ provider: "anthropic", subscription: true }] });
	});

	it("a reader that knows no entry reads the same routes as before, however the accounts' records stand", () => {
		const before = route([login(), openrouter(), login(undefined, "a.eeeeeeeeeeeeeeeeeeee")]);
		for (const records of [
			[[{ entry: LOGIN_ENTRY }], [{ entry: OPENROUTER }], [{ entry: "claude-subscription/other" }]],
			[[{ entry: LOGIN_ENTRY }], [], []],
			[[], [{ entry: null }], [{ entry: LOGIN_ENTRY }]],
		] as Array<Array<Account["answered"]>>) {
			const told = route([login(records[0]), openrouter(records[1]), login(records[2], "a.eeeeeeeeeeeeeeeeeeee")]);
			expect(asBefore(told)).toEqual(before);
		}
		// An account that leads somewhere not known stays not known, whatever it answered as.
		const elsewhere: Account = {
			provider: "openai-compatible-x",
			kind: "apikey",
			priority: 0,
			host: "relay.example.test",
			answered: [{ entry: OPENROUTER }],
		};
		expect(route([elsewhere])).toEqual({ upstreams: [] });
	});

	it("two accounts read alike are one upstream with both markers; their entry where they agree, else none", () => {
		const two = (second: Account["answered"]) =>
			route([login([{ entry: LOGIN_ENTRY }]), login(second, "a.eeeeeeeeeeeeeeeeeeee")]).upstreams;
		expect(two([{ entry: LOGIN_ENTRY }])).toEqual([
			{
				provider: "anthropic",
				subscription: true,
				entry: LOGIN_ENTRY,
				accounts: ["a.cccccccccccccccccccc", "a.eeeeeeeeeeeeeeeeeeee"],
			},
		]);
		expect(two([{ entry: "claude-subscription/other" }])[0]?.entry).toBeNull();
		expect(two([])[0]).not.toHaveProperty("entry");
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
	const failedRead = (): ListedSources => ({ owners: new Map(), accounts: new Map() });
	const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

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
		reader.mockResolvedValue(sources({ [OPENROUTER]: entry() }, [{ entry: OPENROUTER }]));
		await gateway.read("http://gw/v1/models", "k", undefined, undefined, false);
		reader.mockClear();
		gateway.noteAnswer("claude-fable-5-2", "a.bbbbbbbbbbbbbbbbbbbb", OPENROUTER);
		await settle();
		expect(reader).not.toHaveBeenCalled();
		expect(gateway.figures()?.entries[OPENROUTER]).toBeDefined();
	});

	// The review's two cases (2026-11-27): the read an answer brought failed; the list could not be read at the start.
	it("a read that failed is not remembered as done: the next answer naming the entry reads again", async () => {
		const reader = vi.fn(async (..._args: Parameters<SourcesReader>) => sources({}));
		const gateway = new GatewayList(reader, () => ({ plainModelsUrl: "http://gw/v1/models", apiKey: "k" }));
		await gateway.read("http://gw/v1/models", "k");
		reader.mockClear();
		reader.mockResolvedValueOnce(failedRead());
		gateway.noteAnswer("new-name", "a.cccccccccccccccccccc", "openrouter/x");
		await settle();
		reader.mockResolvedValue(sources({ "openrouter/x": entry() }, [{ entry: "openrouter/x" }]));
		for (let i = 0; i < 4; i++) {
			gateway.noteAnswer("new-name", "a.cccccccccccccccccccc", "openrouter/x");
			await settle();
		}
		expect(reader).toHaveBeenCalledTimes(2);
		// A read that threw counts as failed too.
		reader.mockClear();
		reader.mockRejectedValueOnce(new Error("down"));
		gateway.noteAnswer("other-name", "a.cccccccccccccccccccc", "openrouter/y");
		await settle();
		gateway.noteAnswer("other-name", "a.cccccccccccccccccccc", "openrouter/y");
		await settle();
		expect(reader).toHaveBeenCalledTimes(2);
	});

	it("a list that could not be read at the start: an answer that names an entry brings the read, with the figures", async () => {
		const reader = vi.fn(async (..._args: Parameters<SourcesReader>) => failedRead());
		const gateway = new GatewayList(reader, () => ({ plainModelsUrl: "http://gw/v1/models", apiKey: "k" }));
		await gateway.read("http://gw/v1/models", "k");
		expect(gateway.supports).toBeUndefined();
		reader.mockClear();
		reader.mockResolvedValue(sources({ "openai/gpt-6.1-sol": entry() }, [{ entry: "openai/gpt-6.1-sol" }]));
		for (let i = 0; i < 4; i++)
			gateway.noteAnswer("claude-fable-5-2", "a.bbbbbbbbbbbbbbbbbbbb", "openai/gpt-6.1-sol");
		await settle();
		expect(reader).toHaveBeenCalledTimes(1);
		expect(reader.mock.calls[0]?.[4]).toBe(true);
		expect(gateway.figures()?.entries["openai/gpt-6.1-sol"]).toBeDefined();
	});

	it("nothing from a gateway whose answers name no entry", async () => {
		const reader = vi.fn(
			async (): Promise<ListedSources> => ({ owners: new Map(), accounts: new Map(), read: true }),
		);
		const gateway = new GatewayList(reader, () => ({ plainModelsUrl: "http://gw/v1/models", apiKey: "k" }));
		await gateway.read("http://gw/v1/models", "k");
		expect(gateway.supports).toBe(false);
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
		figures: parseFigures(held({ [OPENROUTER]: entry() })),
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

	it("the routes carry the entries and markers of the accounts, and the figures", async () => {
		const { emitted } = await announcer(true);
		const told = emitted.find(([channel]) => channel === UPSTREAMS_EVENT)?.[1] as {
			models: Record<string, unknown>;
			figures: { state: string; entries: Record<string, unknown> };
		};
		expect(told.models["claude-fable-5-2"]).toEqual({
			upstreams: [{ provider: "anthropic", subscription: true, accounts: ["a.cccccccccccccccccccc"] }],
			fallbacks: [
				{ provider: "openrouter", subscription: false, entry: OPENROUTER, accounts: ["a.dddddddddddddddddddd"] },
			],
		});
		expect(told.figures.state).toBe("held");
		expect(Object.keys(told.figures.entries)).toEqual([OPENROUTER]);
	});

	it("an answer's entry and account are told on their own, just before the answer, which is told as before", async () => {
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
			provimux_entry: LOGIN_ENTRY,
		});
		expect(emitted).toEqual([
			[
				ENTRY_EVENT,
				{ provider: "provimux", model: "claude-fable-5-2", entry: OPENROUTER, account: "a.dddddddddddddddddddd" },
			],
			[
				ANSWERED_EVENT,
				{
					provider: "provimux",
					model: "claude-fable-5-2",
					upstreams: [{ provider: "openrouter", subscription: false }],
				},
			],
			[
				ENTRY_EVENT,
				{ provider: "provimux", model: "claude-fable-5-2", entry: LOGIN_ENTRY, account: "a.cccccccccccccccccccc" },
			],
			[
				ANSWERED_EVENT,
				{
					provider: "provimux",
					model: "claude-fable-5-2",
					upstreams: [{ provider: "anthropic", subscription: true }],
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
		expect(emitted.filter(([channel]) => channel === ENTRY_EVENT).map(([, data]) => data)).toEqual([
			{ provider: "provimux", model: "claude-fable-5-2", entry: null, account: "a.eeeeeeeeeeeeeeeeeeee" },
			{ provider: "provimux", model: "claude-fable-5-2", entry: null, account: "a.eeeeeeeeeeeeeeeeeeee" },
		]);
	});

	it("from a gateway that names the account only (8.1.7-pmx.3), only the answer is told, as before", async () => {
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
