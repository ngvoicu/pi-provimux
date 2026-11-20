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
	statedUpstream,
	UPSTREAMS_EVENT,
	type Upstream,
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

	it("what answered, when CLIProxyAPI names the provider: that credential, from the response alone", () => {
		expect(statedUpstream("claude-opus-5-5", { provider: "claude", kind: "oauth" })).toEqual({
			provider: "anthropic",
			subscription: true,
		});
		expect(statedUpstream("claude-opus-5-5", { provider: "devin", kind: "oauth" })).toEqual({
			provider: "devin",
			subscription: true,
		});
		// No host: the credential has none, so a Claude key is Anthropic's own; with one, it goes by the host.
		expect(statedUpstream("claude-opus-5-5", { provider: "claude", kind: "apikey" })).toEqual({
			provider: "anthropic",
			subscription: false,
		});
		expect(statedUpstream("claude-opus-5-5", { provider: "claude", kind: "apikey", host: "OpenRouter.ai" })).toEqual({
			provider: "openrouter",
			subscription: false,
		});
		// A prefix the proxy puts before a credential's models is left out, as for the routes.
		expect(statedUpstream("devin/swe-2", { provider: "devin", kind: "oauth" })).toEqual({
			provider: "devin",
			model: "swe-2",
			subscription: true,
		});
	});

	it("a named provider is matched without regard to letter case", () => {
		expect(statedUpstream("claude-opus-5-5", { provider: "DeViN", kind: "oauth" })).toEqual({
			provider: "devin",
			subscription: true,
		});
		expect(statedUpstream("gpt-6.1-sol", { provider: "Codex", kind: "apikey" })).toEqual({
			provider: "openai",
			subscription: false,
		});
	});

	it("a named credential that leads to a service not known is still named: by its host, else its provider", () => {
		expect(
			statedUpstream("claude-opus-5-5", {
				provider: "openai-compatible-lab",
				kind: "apikey",
				host: "api.example.test",
			}),
		).toEqual({ provider: "api.example.test", subscription: false });
		expect(
			statedUpstream("claude-opus-5-5", { provider: "claude", kind: "apikey", host: "LLM.Example.com" }),
		).toEqual({
			provider: "llm.example.com",
			subscription: false,
		});
		expect(statedUpstream("claude-opus-5-5", { provider: "openai-compatible-mine", kind: "apikey" })).toEqual({
			provider: "openai-compatible-mine",
			subscription: false,
		});
		expect(statedUpstream("muse-ember-1.0", { provider: "SomeLab", kind: "oauth" })).toEqual({
			provider: "SomeLab",
			subscription: true,
		});
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
	const answered = (upstreams: Upstream[]) => [
		ANSWERED_EVENT,
		{ provider: "cliproxyapi", model: "claude-opus-5-5", upstreams },
	];
	/** An announcer an extension asked for routes, with what its lookup gives; `settle`: wait for the lookup. */
	async function asked(fetchAccounts: () => Promise<ModelAccounts>, settle = true) {
		const { pi, handlers, listeners, emitted } = fakePi();
		const announcer = new UpstreamsAnnouncer(
			pi,
			"cliproxyapi",
			() => ({ baseUrlInput: "x", apiKey: "k" }),
			fetchAccounts,
		);
		announcer.register();
		listeners.get(REQUEST_EVENT)!({});
		if (settle) await announcer.announce();
		emitted.length = 0;
		const respond = (headers: Record<string, string>) =>
			handlers.get("after_provider_response")!(
				{ status: 200, headers },
				{ model: { provider: "cliproxyapi", id: "claude-opus-5-5" } },
			);
		const streamEvent = (data: unknown) =>
			handlers.get("provider_stream_event")!(
				{ type: "provider_stream_event", provider: "cliproxyapi", api: "x", model: "claude-opus-5-5", data },
				{},
			);
		return { announcer, emitted, respond, streamEvent };
	}

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

	it("a named response is built from the response alone, never from a list older than the proxy", async () => {
		// The list still has a Claude key sent to OpenRouter; the proxy now answers with one on Anthropic's own address.
		const hosted = listed(
			{ "claude-opus-5-5": [{ provider: "claude", kind: "apikey", priority: 10, host: "openrouter.ai" }] },
			{ "claude-opus-5-5": "anthropic" },
		);
		const { emitted, respond, streamEvent } = await asked(async () => hosted);
		respond({ "X-Cpa-Auth-Kind": "apikey", "X-Cpa-Auth-Provider": "claude" });
		streamEvent({
			type: "response.created",
			response: { id: "r" },
			cpa_auth_kind: "apikey",
			cpa_auth_provider: "claude",
		});
		streamEvent({
			type: "response.created",
			cpa_auth_kind: "apikey",
			cpa_auth_provider: "claude",
			cpa_auth_host: "",
		});
		// And the other way round: a host the list does not have.
		respond({ "X-Cpa-Auth-Kind": "apikey", "X-Cpa-Auth-Provider": "claude", "X-Cpa-Auth-Host": "api.anthropic.com" });
		const native = [{ provider: "anthropic", subscription: false }];
		expect(emitted).toEqual([answered(native), answered(native), answered(native), answered(native)]);

		const { emitted: again, respond: respondAgain } = await asked(async () => accounts);
		respondAgain({
			"X-Cpa-Auth-Kind": "apikey",
			"X-Cpa-Auth-Provider": "claude",
			"X-Cpa-Auth-Host": "openrouter.ai",
		});
		expect(again).toEqual([answered([{ provider: "openrouter", subscription: false }])]);
	});

	it("a named response does not wait for the credential list, but only once an extension asked", async () => {
		const devinFrame = { type: "response.created", cpa_auth_kind: "oauth", cpa_auth_provider: "devin" };
		const devinHeaders = { "x-cpa-auth-kind": "oauth", "x-cpa-auth-provider": "devin" };
		const devin = answered([{ provider: "devin", subscription: true }]);

		// Nobody asked: nothing.
		const quiet = fakePi();
		new UpstreamsAnnouncer(
			quiet.pi,
			"cliproxyapi",
			() => ({ baseUrlInput: "x", apiKey: "k" }),
			async () => accounts,
		).register();
		quiet.handlers.get("after_provider_response")!(
			{ status: 200, headers: devinHeaders },
			{ model: { provider: "cliproxyapi", id: "claude-opus-5-5" } },
		);
		expect(quiet.emitted).toEqual([]);

		// The lookup still pending: the named answer is said, the kind alone still waits for the list.
		let release: (value: ModelAccounts) => void = () => {};
		const pending = await asked(() => new Promise<ModelAccounts>((resolve) => (release = resolve)), false);
		pending.streamEvent(devinFrame);
		pending.respond(devinHeaders);
		pending.respond({ "x-cpa-auth-kind": "oauth" });
		expect(pending.emitted).toEqual([devin, devin]);
		release(accounts);
		await pending.announcer.announce();
		pending.emitted.length = 0;
		pending.streamEvent(devinFrame);
		expect(pending.emitted).toEqual([devin]);

		// The lookup failed: the same.
		const failed = await asked(async () => {
			throw new Error("503");
		});
		failed.respond(devinHeaders);
		failed.streamEvent(devinFrame);
		failed.respond({ "x-cpa-auth-kind": "oauth" });
		expect(failed.emitted).toEqual([devin, devin]);
	});

	it("a route through a service not known is still told, so a change of route is seen", async () => {
		const { emitted, respond, streamEvent } = await asked(async () => accounts);
		const claudeLogin = { "X-Cpa-Auth-Kind": "oauth", "X-Cpa-Auth-Provider": "claude" };
		respond(claudeLogin);
		respond({
			"X-Cpa-Auth-Host": "api.example.test",
			"X-Cpa-Auth-Kind": "apikey",
			"X-Cpa-Auth-Provider": "openai-compatible-lab",
		});
		respond(claudeLogin);
		streamEvent({
			type: "response.created",
			response: { id: "resp-u" },
			cpa_auth_kind: "apikey",
			cpa_auth_provider: "openai-compatible-lab",
			cpa_auth_host: "api.example.test",
		});
		// A known service stored with another letter case.
		respond({ "X-Cpa-Auth-Kind": "oauth", "X-Cpa-Auth-Provider": "DeViN" });
		streamEvent({ type: "response.created", cpa_auth_kind: "oauth", cpa_auth_provider: "DeViN" });
		const claude = answered([{ provider: "anthropic", subscription: true }]);
		const gateway = answered([{ provider: "api.example.test", subscription: false }]);
		const devin = answered([{ provider: "devin", subscription: true }]);
		expect(emitted).toEqual([claude, gateway, claude, gateway, devin, devin]);
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
