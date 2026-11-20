import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type Account,
	ANSWERED_EVENT,
	answeredUpstreams,
	fetchModelAccounts,
	likelyAccounts,
	type ModelAccounts,
	REQUEST_EVENT,
	routeOf,
	UPSTREAMS_EVENT,
	UpstreamsAnnouncer,
	upstreamOf,
} from "../extensions/upstreams.ts";

const login: Account = { provider: "claude", kind: "oauth", priority: -15 };
const key: Account = { provider: "claude", kind: "apikey", priority: -25 };
const at = (host: string, provider = "openai-compatible-mine"): Account => ({
	provider,
	kind: "apikey",
	priority: 0,
	host,
});
const listed = (accounts: Record<string, Account[]>, owners: Record<string, string> = {}): ModelAccounts => ({
	owners,
	accounts,
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("where a credential leads", () => {
	it("by CLIProxyAPI's provider and the kind of credential", () => {
		expect(upstreamOf(login, "claude-opus-5-5")).toEqual({ provider: "anthropic", subscription: true });
		expect(upstreamOf(key, "claude-opus-5-5")).toEqual({ provider: "anthropic", subscription: false });
		expect(upstreamOf({ provider: "codex", kind: "oauth", priority: 0 }, "gpt-6.1-sol")).toEqual({
			provider: "openai-codex",
			subscription: true,
		});
		expect(upstreamOf({ provider: "codex", kind: "apikey", priority: 0 }, "gpt-6.1-sol")).toEqual({
			provider: "openai",
			subscription: false,
		});
		expect(upstreamOf({ provider: "meta", kind: "oauth", priority: 0 }, "muse-ember-1.0")?.provider).toBe("meta");
		expect(upstreamOf({ provider: "antigravity", kind: "oauth", priority: 0 }, "gemini-3.8-flash")?.provider).toBe(
			"antigravity",
		);
		expect(upstreamOf({ provider: "something-new", kind: "oauth", priority: 0 }, "x")).toBeUndefined();
	});

	it("drops a prefix the proxy puts before a credential's models, but keeps OpenRouter's lab/model names", () => {
		expect(upstreamOf({ provider: "devin", kind: "oauth", priority: 0 }, "devin/swe-2")).toEqual({
			provider: "devin",
			model: "swe-2",
			subscription: true,
		});
		expect(upstreamOf(login, "team/claude-opus-5-5")).toEqual({
			provider: "anthropic",
			model: "claude-opus-5-5",
			subscription: true,
		});
		const openrouter = { provider: "openai-compatible-openrouter", kind: "apikey", priority: 0 };
		expect(upstreamOf(openrouter, "openai/gpt-6.1-sol")).toEqual({ provider: "openrouter", subscription: false });
	});

	it("an API key goes by the host it is sent to, whatever its entry is called", () => {
		expect(upstreamOf(at("openrouter.ai"), "openai/gpt-6.1-sol")?.provider).toBe("openrouter");
		expect(upstreamOf(at("api.openai.com", "codex"), "gpt-6.1-sol")?.provider).toBe("openai");
		expect(upstreamOf(at("api.anthropic.com", "claude"), "claude-opus-5-5")?.provider).toBe("anthropic");
		// A Claude key sent elsewhere, or an entry named openrouter on another host: not what the name says.
		expect(upstreamOf(at("llm.example.com", "claude"), "claude-opus-5-5")).toBeUndefined();
		expect(upstreamOf(at("llm.example.com", "openai-compatible-openrouter"), "openai/gpt-6.1-sol")).toBeUndefined();
	});
});

describe("a model's route", () => {
	it("the credentials at the highest priority may answer; the others are fallbacks", () => {
		expect(likelyAccounts([login, { ...login, priority: -17 }, key])).toEqual([login]);
		expect(likelyAccounts([login, key], "apikey")).toEqual([key]);
		expect(likelyAccounts([])).toEqual([]);
		expect(
			routeOf("claude-opus-5-5", listed({ "claude-opus-5-5": [login, { ...login, priority: -17 }, key, key] })),
		).toEqual({
			upstreams: [{ provider: "anthropic", subscription: true }],
			fallbacks: [{ provider: "anthropic", subscription: false }],
		});
	});

	it("with no priority set a login and a key take turns, so either may answer", () => {
		const route = routeOf(
			"claude-opus-5-5",
			listed({
				"claude-opus-5-5": [
					{ ...login, priority: 0 },
					{ ...key, priority: 0 },
				],
			}),
		);
		expect(route).toEqual({
			upstreams: [
				{ provider: "anthropic", subscription: true },
				{ provider: "anthropic", subscription: false },
			],
		});
	});

	it("a credential at the top that leads somewhere not known may answer, so the route is not known", () => {
		const mine = { provider: "openai-compatible-mine", kind: "apikey", priority: -15 };
		expect(routeOf("claude-opus-5-5", listed({ "claude-opus-5-5": [login, mine, key] }))).toEqual({
			upstreams: [],
			fallbacks: [{ provider: "anthropic", subscription: false }],
		});
	});

	it("without the credential list: the owner's lab by login or key; Devin by its prefix; other slash names not known", () => {
		const owners = {
			"claude-opus-5-5": "anthropic",
			"gpt-6.1-sol": "openai",
			"openai/gpt-6.1-sol": "openai",
			x: "antigravity",
		};
		const plain = listed({}, owners);
		expect(routeOf("claude-opus-5-5", plain)).toEqual({ upstreams: [{ provider: "anthropic" }] });
		expect(routeOf("gpt-6.1-sol", plain)).toEqual({
			upstreams: [
				{ provider: "openai-codex", subscription: true },
				{ provider: "openai", subscription: false },
			],
		});
		expect(routeOf("x", plain)).toEqual({ upstreams: [{ provider: "antigravity" }] });
		expect(routeOf("devin/swe-2", plain)).toEqual({ upstreams: [{ provider: "devin", model: "swe-2" }] });
		expect(routeOf("openai/gpt-6.1-sol", plain)).toEqual({ upstreams: [] });
		expect(routeOf("mystery", plain)).toEqual({ upstreams: [] });
	});

	it("what answered: the credentials of that kind at their highest priority", () => {
		const accounts = listed({ "claude-opus-5-5": [login, key] });
		expect(answeredUpstreams("claude-opus-5-5", "apikey", accounts)).toEqual([
			{ provider: "anthropic", subscription: false },
		]);
		expect(answeredUpstreams("claude-opus-5-5", "oauth", accounts)).toEqual([
			{ provider: "anthropic", subscription: true },
		]);
		expect(answeredUpstreams("other", "oauth", accounts)).toBeUndefined();
	});

	it("what answered, when CLIProxyAPI names the provider: that credential, whatever its priority", () => {
		const devin: Account = { provider: "devin", kind: "oauth", priority: -15 };
		const both = listed({ "claude-opus-5-5": [login, devin, key] });
		// The kind alone can't tell a Claude login from a Devin login at the same priority.
		expect(answeredUpstreams("claude-opus-5-5", "oauth", both)).toEqual([
			{ provider: "anthropic", subscription: true },
			{ provider: "devin", subscription: true },
		]);
		expect(answeredUpstreams("claude-opus-5-5", "oauth", both, { provider: "claude" })).toEqual([
			{ provider: "anthropic", subscription: true },
		]);
		expect(answeredUpstreams("claude-opus-5-5", "oauth", both, { provider: "devin" })).toEqual([
			{ provider: "devin", subscription: true },
		]);
		// Not narrowed by priority: a fallback that answered is what answered.
		const fallback = listed({ "claude-opus-5-5": [login, { ...devin, priority: -40 }] });
		expect(answeredUpstreams("claude-opus-5-5", "oauth", fallback, { provider: "devin" })).toEqual([
			{ provider: "devin", subscription: true },
		]);
	});

	it("the one listed credential that matches fills in what the response does not say", () => {
		const mine = { ...at("openrouter.ai"), priority: -30 };
		const accounts = listed({ "openai/gpt-6.1-sol": [at("llm.example.com", "openai-compatible-other"), mine] });
		// No host in the response: the listed entry's host says it is OpenRouter.
		expect(
			answeredUpstreams("openai/gpt-6.1-sol", "apikey", accounts, { provider: "openai-compatible-mine" }),
		).toEqual([{ provider: "openrouter", subscription: false }]);
		expect(
			answeredUpstreams("openai/gpt-6.1-sol", "apikey", accounts, {
				provider: "openai-compatible-mine",
				host: "openrouter.ai",
			}),
		).toEqual([{ provider: "openrouter", subscription: false }]);
	});

	it("a credential the list does not have (older than the proxy's state): what the response says stands alone", () => {
		const accounts = listed({ "claude-opus-5-5": [login], "openai/gpt-6.1-sol": [at("llm.example.com")] });
		expect(answeredUpstreams("claude-opus-5-5", "oauth", accounts, { provider: "devin" })).toEqual([
			{ provider: "devin", subscription: true },
		]);
		expect(answeredUpstreams("claude-opus-5-5", "apikey", accounts, { provider: "claude" })).toEqual([
			{ provider: "anthropic", subscription: false },
		]);
		// A model not listed at all, and a listed entry now sent to another host.
		expect(answeredUpstreams("devin/swe-2", "oauth", accounts, { provider: "devin" })).toEqual([
			{ provider: "devin", model: "swe-2", subscription: true },
		]);
		expect(
			answeredUpstreams("openai/gpt-6.1-sol", "apikey", accounts, {
				provider: "openai-compatible-mine",
				host: "openrouter.ai",
			}),
		).toEqual([{ provider: "openrouter", subscription: false }]);
		// Named, but leading somewhere not known: not known, and no guess from the kind.
		expect(answeredUpstreams("claude-opus-5-5", "oauth", accounts, { provider: "something-new" })).toBeUndefined();
		expect(
			answeredUpstreams("openai/gpt-6.1-sol", "apikey", accounts, { provider: "openai-compatible-mine" }),
		).toBeUndefined();
	});
});

describe("CLIProxyAPI's credential list", () => {
	it("is asked with the proxy's key, next to the base path, and read leniently", async () => {
		const fetchMock = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
			expect(url).toBe("http://127.0.0.1:8317/v1/models?include=accounts");
			expect(init.headers.Authorization).toBe("Bearer k");
			return new Response(
				JSON.stringify({
					data: [
						{ id: "claude-opus-5-5", owned_by: "Anthropic", accounts: [login, key, { kind: "oauth" }] },
						{
							id: "openai/gpt-6.1-sol",
							owned_by: "openai",
							accounts: [{ ...at("OpenRouter.ai"), priority: -25 }],
						},
						{ id: "claude-sonnet-4-6", owned_by: "antigravity", accounts: [] },
						{ id: "nameless" },
						"junk",
					],
				}),
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		expect(await fetchModelAccounts("http://127.0.0.1:8317/v1", "k")).toEqual({
			owners: { "claude-opus-5-5": "anthropic", "openai/gpt-6.1-sol": "openai", "claude-sonnet-4-6": "antigravity" },
			accounts: {
				"claude-opus-5-5": [login, key],
				"openai/gpt-6.1-sol": [{ ...at("openrouter.ai"), priority: -25 }],
			},
		});
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ models: [] })));
		await expect(fetchModelAccounts("http://127.0.0.1:8317", "k")).rejects.toThrow(/without a list/);
	});
});

describe("the events", () => {
	function fakePi() {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const listeners = new Map<string, (data: unknown) => void>();
		const emitted: Array<[string, unknown]> = [];
		const pi = {
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
			events: {
				emit: (channel: string, data: unknown) => emitted.push([channel, data]),
				on: (channel: string, handler: (data: unknown) => void) => {
					listeners.set(channel, handler);
					return () => {};
				},
			},
		} as unknown as ExtensionAPI;
		return { pi, handlers, listeners, emitted };
	}
	const accounts = listed({ "claude-opus-5-5": [login, key] }, { "claude-opus-5-5": "anthropic" });

	it("every model's route when an extension asks, again after a refresh, and what answered a request", async () => {
		const { pi, handlers, listeners, emitted } = fakePi();
		const fetchAccounts = vi.fn(async () => accounts);
		const announcer = new UpstreamsAnnouncer(
			pi,
			"cliproxyapi",
			() => ({ baseUrlInput: "x", apiKey: "k" }),
			fetchAccounts,
		);
		announcer.register();
		// Nobody asked: nothing fetched, nothing said, not even after a refresh or a response.
		await announcer.refreshed();
		handlers.get("after_provider_response")!(
			{ status: 200, headers: { "x-cpa-auth-kind": "apikey" } },
			{ model: { provider: "cliproxyapi", id: "claude-opus-5-5" } },
		);
		expect(fetchAccounts).not.toHaveBeenCalled();
		expect(emitted).toEqual([]);

		listeners.get(REQUEST_EVENT)!({});
		await announcer.announce(); // the request's fetch, still running: joined
		await announcer.refreshed();
		expect(fetchAccounts).toHaveBeenCalledTimes(2);
		expect(emitted).toHaveLength(2);
		expect(emitted[0]).toEqual([
			UPSTREAMS_EVENT,
			{
				provider: "cliproxyapi",
				models: {
					"claude-opus-5-5": {
						upstreams: [{ provider: "anthropic", subscription: true }],
						fallbacks: [{ provider: "anthropic", subscription: false }],
					},
				},
			},
		]);

		emitted.length = 0;
		const respond = (headers: Record<string, string>, model = { provider: "cliproxyapi", id: "claude-opus-5-5" }) =>
			handlers.get("after_provider_response")!({ status: 200, headers }, { model });
		respond({ "X-CPA-Auth-Kind": "apikey" });
		expect(emitted).toEqual([
			[
				ANSWERED_EVENT,
				{
					provider: "cliproxyapi",
					model: "claude-opus-5-5",
					upstreams: [{ provider: "anthropic", subscription: false }],
				},
			],
		]);
		// No header, another value, or another provider's model: nothing said.
		emitted.length = 0;
		respond({});
		respond({ "x-cpa-auth-kind": "other" });
		respond({ "x-cpa-auth-kind": "apikey" }, { provider: "anthropic", id: "claude-opus-5-5" });
		expect(emitted).toEqual([]);
	});

	it("over the Codex WebSocket, what answered comes from response.created, which has no headers", async () => {
		const { pi, handlers, listeners, emitted } = fakePi();
		const announcer = new UpstreamsAnnouncer(
			pi,
			"cliproxyapi",
			() => ({ baseUrlInput: "x", apiKey: "k" }),
			async () => accounts,
		);
		announcer.register();
		listeners.get(REQUEST_EVENT)!({});
		await announcer.announce();
		emitted.length = 0;
		const streamEvent = (data: unknown, provider = "cliproxyapi") =>
			handlers.get("provider_stream_event")!(
				{ type: "provider_stream_event", provider, api: "x", model: "claude-opus-5-5", data },
				{},
			);
		streamEvent({ type: "response.created", cpa_auth_kind: "apikey", response: { id: "r" } });
		expect(emitted).toEqual([
			[
				ANSWERED_EVENT,
				{
					provider: "cliproxyapi",
					model: "claude-opus-5-5",
					upstreams: [{ provider: "anthropic", subscription: false }],
				},
			],
		]);
		// Other events, a response.created without the field (an older CLIProxyAPI), or another provider: nothing.
		emitted.length = 0;
		streamEvent({ type: "response.output_text.delta", cpa_auth_kind: "apikey" });
		streamEvent({ type: "response.created", response: { id: "r" } });
		streamEvent({ type: "response.created", cpa_auth_kind: "apikey" }, "openai");
		streamEvent("junk");
		expect(emitted).toEqual([]);
	});

	it("a Claude login and a Devin login of the same kind and priority: each answer names its own service", async () => {
		const devin: Account = { provider: "devin", kind: "oauth", priority: -15 };
		const shared = listed({ "claude-opus-5-5": [login, devin, key] }, { "claude-opus-5-5": "anthropic" });
		const { pi, handlers, listeners, emitted } = fakePi();
		const announcer = new UpstreamsAnnouncer(
			pi,
			"cliproxyapi",
			() => ({ baseUrlInput: "x", apiKey: "k" }),
			async () => shared,
		);
		announcer.register();
		listeners.get(REQUEST_EVENT)!({});
		await announcer.announce();
		const answered = (upstreams: unknown) => [
			ANSWERED_EVENT,
			{ provider: "cliproxyapi", model: "claude-opus-5-5", upstreams },
		];
		const claude = [{ provider: "anthropic", subscription: true }];
		const devinOnly = [{ provider: "devin", subscription: true }];

		const respond = (headers: Record<string, string>) =>
			handlers.get("after_provider_response")!(
				{ status: 200, headers },
				{ model: { provider: "cliproxyapi", id: "claude-opus-5-5" } },
			);
		emitted.length = 0;
		respond({ "x-cpa-auth-kind": "oauth", "x-cpa-auth-provider": "claude" });
		respond({ "X-CPA-AUTH-KIND": "oauth", "X-CPA-AUTH-PROVIDER": "devin" });
		// An API key with a base URL names its host too.
		respond({ "x-cpa-auth-kind": "apikey", "x-cpa-auth-provider": "claude", "x-cpa-auth-host": "API.Anthropic.com" });
		// A proxy that names only the kind: the guess as before, both logins.
		respond({ "x-cpa-auth-kind": "oauth" });
		// An empty provider is no provider; a provider without a kind says nothing.
		respond({ "x-cpa-auth-kind": "oauth", "x-cpa-auth-provider": " " });
		respond({ "x-cpa-auth-provider": "devin" });
		expect(emitted).toEqual([
			answered(claude),
			answered(devinOnly),
			answered([{ provider: "anthropic", subscription: false }]),
			answered([...claude, ...devinOnly]),
			answered([...claude, ...devinOnly]),
		]);

		const streamEvent = (data: unknown) =>
			handlers.get("provider_stream_event")!(
				{ type: "provider_stream_event", provider: "cliproxyapi", api: "x", model: "claude-opus-5-5", data },
				{},
			);
		emitted.length = 0;
		streamEvent({ type: "response.created", cpa_auth_kind: "oauth", cpa_auth_provider: "devin", response: {} });
		streamEvent({ type: "response.created", cpa_auth_kind: "oauth", cpa_auth_provider: "claude", response: {} });
		streamEvent({
			type: "response.created",
			cpa_auth_kind: "apikey",
			cpa_auth_provider: "claude",
			cpa_auth_host: "api.anthropic.com",
		});
		streamEvent({ type: "response.created", cpa_auth_kind: "oauth", response: {} });
		streamEvent({ type: "response.created", cpa_auth_kind: "oauth", cpa_auth_provider: 7 });
		expect(emitted).toEqual([
			answered(devinOnly),
			answered(claude),
			answered([{ provider: "anthropic", subscription: false }]),
			answered([...claude, ...devinOnly]),
			answered([...claude, ...devinOnly]),
		]);
	});

	it("nothing is said when CLIProxyAPI does not answer or no connection is set up", async () => {
		const { pi, emitted } = fakePi();
		await new UpstreamsAnnouncer(
			pi,
			"cliproxyapi",
			() => ({ baseUrlInput: "x", apiKey: "k" }),
			async () => {
				throw new Error("down");
			},
		).announce();
		await new UpstreamsAnnouncer(
			pi,
			"cliproxyapi",
			() => null,
			async () => accounts,
		).announce();
		expect(emitted).toEqual([]);
	});
});
