/**
 * `/provimux-route` against a stand-in for Provimux's two session-route paths (test/session-route-contract.ts). One
 * show and one cost-and-decline are pinned whole; every other case checks what distinguishes it, and whether a release
 * was sent. The gateway's times are its answers' own (observed_at), written in UTC.
 */
import { describe, expect, it } from "vitest";
import { costText, parseReleaseAnswer, parseShowAnswer } from "../extensions/route.ts";
import {
	RELEASE_URL,
	type RouteCase,
	routeCommand,
	runRoute,
	SESSION_ID,
	SHOW_URL,
	type StandInAnswer,
} from "./route-harness.ts";
import * as C from "./session-route-contract.ts";

const ok = (body: unknown): StandInAnswer => ({ status: 200, body });
const releases = (run: { order: string[] }) => run.order.filter((step) => step === "release").length;
const shown = async (answer: unknown, setup: RouteCase = {}) =>
	(await runRoute("", { ...setup, show: [ok(answer)] })).notes[0]![0];

describe("/provimux-route: the show", () => {
	it("a fallback whose first route is free again, whole", async () => {
		const run = await runRoute("", { show: [ok(C.FellBack)] });
		expect(run.notes).toEqual([
			[
				"Route of this conversation on opus, as Provimux says now (this check sends nothing to a model and costs nothing):\n• Now on: Anthropic api, since 09:35 (40 minutes ago).\n• A fallback: it was on Anthropic sub until 09:35.\n• A higher-priority route is free now: Anthropic sub.\n• Automatic return: off on this server.\nTo move it now: /provimux-route release (it says what that may cost and asks first).",
				"info",
			],
		]);
		expect(run.order).toEqual(["show"]);
	});

	it("still cooling: one time for any higher-priority route, never one account's, and a hint to check again", async () => {
		const text = await shown(C.Cooling);
		expect(text).toContain(
			"\n• No higher-priority route is free yet: one is expected free at 10:40 (in 25 minutes).\n",
		);
		expect(text).toMatch(/\nTo check again later: \/provimux-route\.$/);
		const unknown = await shown({ ...C.Cooling, position: { ...C.Cooling.position, higher_priority_free_at: null } });
		expect(unknown).toContain("• No higher-priority route is free yet, and Provimux does not know when one will be.");
	});

	it("the current binding only: no fallback recorded after a return; no history, without a guessed cause", async () => {
		const returned = { ...C.FellBack, bound: { ...C.OnFirstRoute.bound } };
		expect(await shown(returned)).toContain("\n• No fallback recorded for this binding.\n");
		const unknown = {
			...C.FellBack,
			bound: { ...C.FellBack.bound, since: null, origin: "not-known", fell_back_from: null, fell_back_at: null },
		};
		const text = await shown(unknown);
		expect(text).toContain("\n• Now on: Anthropic api.\n• No history recorded for this binding.\n");
		expect(text).not.toMatch(/restart/);
	});

	it("on a first route: says so, with the count of available routes at the top, and offers no release", async () => {
		const text = await shown(C.OnFirstRoute);
		expect(text).toContain(
			"\n• It is on a first route: no available route has a higher priority (2 available at the top: 2 Anthropic sub accounts).\n",
		);
		expect(text).not.toContain("release");
	});

	it("an unlisted account asked as auto: its rank is not known, the first route now, and a release offered", async () => {
		const text = await shown(C.BoundToUnlisted);
		expect(text).toMatch(/^Route of this conversation on auto \(routed to opus\), /);
		expect(text).toContain(
			"\n• Now on: an account that is no longer listed, since 09:02 (1 hour 12 minutes ago).\n• No fallback recorded for this binding.\n• Provimux does not say where this account ranks. The first route now: Anthropic api.\n",
		);
		expect(text).toContain("To move it now: /provimux-route release");
		const nowhere = await shown({ ...C.BoundToUnlisted, first: [] });
		expect(nowhere).toContain("• Provimux does not say where this account ranks.\n");
		expect(nowhere).not.toContain("To move it");
	});

	it("automatic return: the server's policy, its setting exactly, never a prediction", async () => {
		const on = (cold_after_s: number | null) => ({ in_effect: true, cold_after_s });
		const policy = (after: string) =>
			`• Automatic return: on. Once no request of this conversation has been routed${after} (a keep-warm request counts), Provimux can send its next request to a free higher-priority route; a pinned Codex follow-up stays on its account.`;
		expect(await shown({ ...C.FellBack, rule: on(360) })).toContain(policy(" for 6 minutes"));
		expect(await shown({ ...C.FellBack, rule: on(90) })).toContain(policy(" for 90 seconds"));
		expect(await shown({ ...C.FellBack, rule: on(3600) })).toContain(policy(" for 1 hour"));
		// Pinned (a Codex WebSocket) and unlisted: the same one line, and no claim of a first route.
		const pinned = await shown({ ...C.FellBack, rule: on(360), websocket_may_hold: true }, { format: "codex" });
		expect(pinned).toContain(policy(" for 6 minutes"));
		const unlisted = await shown({ ...C.BoundToUnlisted, rule: on(360) });
		expect(unlisted).toContain(policy(" for 6 minutes"));
		expect(unlisted).not.toContain("on a first route");
		expect(await shown(C.FellBack)).toContain("\n• Automatic return: off on this server.\n");
	});

	it("a route of an empty kind is named by its service alone; a sub-agent is said", async () => {
		const plain = {
			...C.FellBack,
			bound: { ...C.FellBack.bound, route: { provider: "claude", kind: "", priority: 5 } },
		};
		expect(await shown(plain)).toContain("• Now on: Anthropic, since 09:35");
		expect(await shown({ ...C.FellBack, subagent: true })).toContain(
			"• This is a sub-agent's conversation: a release of its main conversation does not move it.",
		);
	});

	it("nothing bound, in each of the gateway's words", async () => {
		const cases: Array<[unknown, string]> = [
			[
				C.NotSeen,
				"Provimux has no record of this conversation on opus from your key. Send a message, then type /provimux-route again.",
			],
			[
				{ ...C.NotSeen, conversation: "not-bound" },
				"This conversation is not bound to a route on opus right now: its next message goes to the first available route.",
			],
			[
				C.AffinityOff,
				"Provimux does not bind conversations to a route (its session affinity is off): every request already goes to the first available route, so there is nothing to move.",
			],
			[
				{ ...C.AffinityOff, affinity: "home" },
				"Provimux runs in Home mode: Home chooses the route of every request, so there is no binding here to show or move.",
			],
			[
				{ ...C.AffinityOff, affinity: "not-supported" },
				"A plugin chooses the routes on this Provimux, so there is no binding here to show or move.",
			],
		];
		for (const [answer, said] of cases) expect((await shown(answer)).split("\n")[1]).toBe(said);
	});

	it("one request per call: the same command, typed again, asks afresh and sees the change", async () => {
		const route = routeCommand({ show: [ok(C.NotSeen), ok(C.FellBack)] });
		const first = await route("");
		const second = await route("");
		expect([first.order, second.order]).toEqual([["show"], ["show"]]);
		expect(first.notes[0]![0]).toContain("has no record of this conversation");
		expect(second.notes[0]![0]).toContain("• A higher-priority route is free now: Anthropic sub.");
	});

	it("offers the release only where it would go ahead: the TUI, a binding with a token, a free higher route", async () => {
		const hint = "To move it now: /provimux-route release (it says what that may cost and asks first).";
		expect(await shown(C.FellBack)).toMatch(new RegExp(`\\n${hint.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`));
		expect(await shown(C.FellBack, { mode: "rpc" })).not.toContain("To move it");
		expect(await shown({ ...C.FellBack, binding: null })).not.toContain("To move it");
		expect(await shown(C.Cooling)).not.toContain("To move it");
	});

	it("works while Pi is answering", async () => {
		const run = await runRoute("", { idle: [false, false], show: [ok(C.FellBack)] });
		expect(run.order).toEqual(["show"]);
	});
});

describe("/provimux-route: what it sends, and where", () => {
	it("a Claude-format model: x-session-affinity, as its turns carry it, and only the model's name", async () => {
		const run = await runRoute("", { show: [ok(C.FellBack)] });
		expect(run.sent).toEqual([
			{
				url: SHOW_URL,
				headers: {
					authorization: "Bearer sk-fixture-client",
					"content-type": "application/json",
					accept: "application/json",
					"x-session-affinity": SESSION_ID,
				},
				body: { model: "opus" },
			},
		]);
	});

	it("a Codex-format model: session-id, at the root of the server its turns go to", async () => {
		const run = await runRoute("", { format: "codex", show: [ok(C.NotSeen)] });
		expect(run.sent[0]!.url).toBe(SHOW_URL);
		expect(run.sent[0]!.headers["session-id"]).toBe(SESSION_ID);
		expect(run.sent[0]!.headers).not.toHaveProperty("x-session-affinity");
		expect(run.sent[0]!.body).toEqual({ model: "gpt-main" });
	});

	it("the key and the server of the model's own requests: a key from the command line, a stored login's address", async () => {
		const run = await runRoute("", {
			auth: { ok: true, apiKey: "sk-from-the-command-line", baseUrl: "http://login.test:9400/v1" },
			show: [ok(C.FellBack)],
		});
		expect(run.sent[0]!.url).toBe("http://login.test:9400/v1/provimux/session-route");
		expect(run.sent[0]!.headers.authorization).toBe("Bearer sk-from-the-command-line");
	});

	it("before anything is sent: no key, another provider's model, no model, a wrong argument", async () => {
		const cases: Array<[string, RouteCase, string]> = [
			[
				"",
				{ auth: { ok: false } },
				"Provimux has no key set up, so there is no conversation route to show. Type /login Provimux (or /login provimux) and enter your server's address and key.",
			],
			[
				"",
				{ model: { provider: "anthropic", id: "claude-opus-4-6" } },
				"/provimux-route shows the route of a Provimux model, and the current model is anthropic/claude-opus-4-6. Choose a Provimux model in /model, then type /provimux-route again.",
			],
			[
				"",
				{ model: null },
				"/provimux-route shows the route of a Provimux model, and no model is selected. Choose a Provimux model in /model, then type /provimux-route again.",
			],
			[
				"release yes",
				{},
				"/provimux-route takes nothing (show where this conversation is), or release (move it back to a free higher-priority route).",
			],
		];
		for (const [args, setup, said] of cases) {
			const run = await runRoute(args, setup);
			expect(run.notes).toEqual([[said, "error"]]);
			expect(run.sent).toEqual([]);
		}
	});

	it("a failed show changes nothing and says what to do", async () => {
		const cases: Array<[StandInAnswer, string]> = [
			[
				{ status: 404 },
				"This server has no conversation routes: /provimux-route needs Provimux 8.1.7-pmx.4 or newer (plain CLIProxyAPI has none). Update Provimux to use it; everything else works as before.",
			],
			[
				{ status: 401, body: { error: "Invalid API key" } },
				"The server refused the client key (HTTP 401). Type /login Provimux to enter the key again.",
			],
			[
				{ status: 400, body: { error: { message: "the model opus is not served to this key" } } },
				"The server refused the request (HTTP 400): the model opus is not served to this key. If it says the model is not served, choose another in /model.",
			],
			[
				{ status: 500, body: { error: { message: "boom" } } },
				"The server answered HTTP 500: boom. Try again in a moment; if it persists, check the server.",
			],
			[
				{ unreachable: "fetch failed" },
				`Could not reach your Provimux server at ${SHOW_URL}: fetch failed. Check that it is running, or type /login Provimux to change its address.`,
			],
			[
				ok({ hello: 1 }),
				"The server's answer could not be read as a conversation route: is it Provimux 8.1.7-pmx.4 or newer?",
			],
		];
		for (const [answer, said] of cases)
			expect((await runRoute("", { show: [answer] })).notes).toEqual([[said, "error"]]);
		const release = await runRoute("release", { show: [{ status: 404 }] });
		expect(release.notes[0]![0]).toContain("(plain CLIProxyAPI has none). Nothing was released.");
	});
});

describe("/provimux-route release", () => {
	it("says the cost and asks; no releases nothing, whole", async () => {
		const run = await runRoute("release", { show: [ok(C.FellBack)], confirm: [false] });
		expect(run.asked).toEqual([
			[
				"Move this conversation from Anthropic api to Anthropic sub now?",
				"Its next message may read the whole conversation once without cache (about 182,000 tokens, about $0.55 at the list price; more where the vendor also charges for writing the new cache). Staying costs a cached read, about $0.05 a message, while the cache is warm. On Anthropic sub this is quota of the subscription, not money: the amounts are at API list price, for comparison.",
			],
		]);
		expect(run.notes).toEqual([["Nothing was released.", "info"]]);
		expect(run.order).toEqual(["show", "ask"]);
	});

	it("yes: one release, naming the binding it saw; the destination as the server lists it now", async () => {
		const run = await runRoute("release", { show: [ok(C.FellBack)], confirm: [true], release: [ok(C.Released)] });
		expect(run.order).toEqual(["show", "ask", "release"]);
		expect(run.sent[1]).toMatchObject({
			url: RELEASE_URL,
			headers: { "x-session-affinity": SESSION_ID },
			body: { model: "opus", expect: "b.k3v7q2mfx4ardn5w" },
		});
		expect(run.notes).toEqual([
			[
				"Released: this conversation is no longer bound to Anthropic api. Its next message goes to the first available route (now: Anthropic sub), and may read the whole conversation once without cache.",
				"info",
			],
		]);
	});

	it("a release that lists no next route says so, and names no route the show had", async () => {
		const run = await runRoute("release", {
			show: [ok(C.FellBack)],
			confirm: [true],
			release: [ok({ ...C.Released, next: [] })],
		});
		expect(run.notes[0]![0]).toBe(
			"Released: this conversation is no longer bound to Anthropic api. Provimux lists no route for its next message right now.",
		);
	});

	it("no release where it leads nowhere better: cooling, already on a first route (a tied peer cooling too), nowhere listed", async () => {
		const tiedPeerCooling = { ...C.OnFirstRoute, first: [C.OnFirstRoute.first[0]] };
		const cases: Array<[unknown, string]> = [
			[
				C.Cooling,
				"Nothing was released: no higher-priority route is free yet, so the conversation stays on Anthropic api. One is expected free at 10:40 (in 25 minutes): type /provimux-route release again then.",
			],
			[
				{ ...C.Cooling, position: { ...C.Cooling.position, higher_priority_free_at: null } },
				"Nothing was released: no higher-priority route is free yet, so the conversation stays on Anthropic api. Provimux does not know when one will be: check again later with /provimux-route.",
			],
			[C.OnFirstRoute, "Nothing was released: this conversation is already on a first route (Anthropic sub)."],
			[tiedPeerCooling, "Nothing was released: this conversation is already on a first route (Anthropic sub)."],
			[
				{ ...C.BoundToUnlisted, first: [] },
				"Nothing was released: this conversation is on an account that is no longer listed, and Provimux lists no route to move it to now. Check again later with /provimux-route.",
			],
			[
				C.NotSeen,
				"Provimux has no record of this conversation on opus from your key. Send a message, then type /provimux-route again. Nothing was released.",
			],
			[
				C.AffinityOff,
				"Provimux does not bind conversations to a route (its session affinity is off): every request already goes to the first available route, so there is nothing to move. Nothing was released.",
			],
		];
		for (const [answer, said] of cases) {
			const run = await runRoute("release", { show: [ok(answer)], confirm: [true] });
			expect(run.notes).toEqual([[said, "info"]]);
			expect(run.order).toEqual(["show"]);
		}
	});

	it("an unlisted account with a listed route: the ordinary confirmed release", async () => {
		const run = await runRoute("release", {
			show: [ok(C.BoundToUnlisted)],
			confirm: [true],
			release: [ok({ ...C.Released, was: { listed: false }, next: C.BoundToUnlisted.first })],
		});
		expect(run.asked[0]![0]).toBe(
			"Move this conversation from an account that is no longer listed to Anthropic api now?",
		);
		expect(run.order).toEqual(["show", "ask", "release"]);
		expect(run.sent[1]!.body).toEqual({ model: "opus", expect: "b.p4nq7tz2wk5xmh3d" });
	});

	it("a bound show without a token: nothing is released, and nothing is asked", async () => {
		const run = await runRoute("release", { show: [ok({ ...C.FellBack, binding: null })], confirm: [true] });
		expect(run.order).toEqual(["show"]);
		expect(run.notes[0]![0]).toBe(
			"Nothing was released: Provimux could not identify this conversation's binding just now. Check again with /provimux-route.",
		);
	});

	it("the binding changed since the show (409): its new state, and no second release", async () => {
		const run = await runRoute("release", {
			show: [ok(C.FellBack)],
			confirm: [true, true],
			release: [{ status: 409, body: { ...C.FellBack, binding: "b.n4w7q2mfx4ardn5w" } }, ok(C.Released)],
		});
		expect(releases(run)).toBe(1);
		expect(run.notes).toHaveLength(1);
		expect(run.notes[0]![0]).toMatch(
			/^Nothing was released: this conversation's binding changed since the check\.\nRoute of this conversation on opus, .*\nTo move it now: \/provimux-route release/s,
		);
	});

	it("only while Pi is idle: busy at the start sends nothing; busy after the yes releases nothing", async () => {
		const said = "Nothing was released: Pi is answering. Type /provimux-route release again when the answer is done.";
		const start = await runRoute("release", { idle: [false, false], show: [ok(C.FellBack)], confirm: [true] });
		expect(start.sent).toEqual([]);
		expect(start.notes).toEqual([[said, "warning"]]);
		const after = await runRoute("release", {
			idle: [true, false],
			format: "codex",
			show: [ok(C.FellBack)],
			confirm: [true],
		});
		expect(after.order).toEqual(["show", "ask"]);
		expect(after.notes).toEqual([[said, "warning"]]);
	});

	it("only in the TUI: RPC says so and sends nothing; print and JSON say so on stderr and send nothing", async () => {
		const rpc = await runRoute("release", { mode: "rpc", show: [ok(C.FellBack)], release: [ok(C.Released)] });
		expect(rpc.sent).toEqual([]);
		expect(rpc.notes).toEqual([
			[
				"Nothing was released: /provimux-route release asks before it moves the conversation, and it can ask only in Pi's interactive terminal. Here, /provimux-route shows the route.",
				"warning",
			],
		]);
		expect((await runRoute("", { mode: "rpc", show: [ok(C.FellBack)] })).notes[0]![0]).toContain(
			"• Now on: Anthropic api",
		);
		for (const mode of ["print", "json"] as const) {
			for (const args of ["", "release"]) {
				const run = await runRoute(args, { mode, show: [ok(C.FellBack)], release: [ok(C.Released)] });
				expect(run.sent).toEqual([]);
				expect(run.reported).toEqual([
					"/provimux-route works in Pi's interactive terminal (and shows the route in RPC mode): nothing was sent.",
				]);
			}
		}
	});

	it("the Codex WebSocket: closed once after a release, never when nothing was released", async () => {
		const codex = {
			format: "codex" as const,
			show: [ok({ ...C.FellBack, websocket_may_hold: true })],
			confirm: [true],
		};
		const done = await runRoute("release", { ...codex, release: [ok({ ...C.Released, websocket_may_hold: true })] });
		expect(done.order).toEqual(["show", "ask", "release", "close session"]);
		expect(done.notes[0]![0]).toMatch(
			/ Its Codex WebSocket, if one was open, was closed, so that message is routed afresh\.$/,
		);
		for (const release of [ok(C.NothingBound), { status: 409, body: C.FellBack }, { status: 502 }]) {
			expect((await runRoute("release", { ...codex, release: [release] })).order).toEqual([
				"show",
				"ask",
				"release",
			]);
		}
		// A Claude-format conversation the server says is on no socket: nothing to close.
		const claude = await runRoute("release", { show: [ok(C.FellBack)], confirm: [true], release: [ok(C.Released)] });
		expect(claude.order).not.toContain("close session");
	});

	it("the release's answer lost or unreadable: the outcome is not known, and the way to check", async () => {
		const cases: Array<[StandInAnswer, string]> = [
			[
				{ unreachable: "The operation was aborted due to timeout" },
				"the server's answer did not come (The operation was aborted due to timeout)",
			],
			[{ status: 503 }, "the server could not confirm the release (HTTP 503)"],
			[ok({ hello: 1 }), "the server's answer could not be read"],
		];
		for (const [answer, why] of cases) {
			const run = await runRoute("release", { show: [ok(C.FellBack)], confirm: [true], release: [answer] });
			expect(run.notes).toEqual([
				[
					`The release was sent, but ${why}, so whether this conversation was released is not known. Check with /provimux-route.`,
					"error",
				],
			]);
		}
		const refused = await runRoute("release", {
			show: [ok(C.FellBack)],
			confirm: [true],
			release: [{ status: 404 }],
		});
		expect(refused.notes[0]![0]).toContain("Nothing was released.");
	});

	it("the release finds nothing bound any more", async () => {
		const run = await runRoute("release", { show: [ok(C.FellBack)], confirm: [true], release: [ok(C.NothingBound)] });
		expect(run.notes).toEqual([
			[
				"Nothing was released: the conversation was no longer bound (its binding expired or was released meanwhile). Its next message goes to the first available route.",
				"info",
			],
		]);
	});
});

describe("/provimux-route: what a move may cost", () => {
	const model = (cost: object) => ({ cost }) as Parameters<typeof costText>[0]["model"];

	it("at Pi's price for that many tokens: a long conversation at its tier", () => {
		const tiered = model({
			input: 5,
			output: 30,
			cacheRead: 0.5,
			cacheWrite: 6.25,
			tiers: [{ input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5, inputTokensAbove: 272000 }],
		});
		const text = costText({ tokens: 300_000, model: tiered, to: [] });
		expect(text).toContain("(about 300,000 tokens, about $3.00 at the list price;");
		expect(text).toContain("Staying costs a cached read, about $0.30 a message");
	});

	it("a small positive amount is not shown as nothing", () => {
		expect(
			costText({ tokens: 15, model: model({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }), to: [] }),
		).toContain("(about 15 tokens, less than $0.01 at the list price;");
	});

	it("without a price: the size alone; without a size: what the move may read", () => {
		expect(
			costText({ tokens: 1_000, model: model({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), to: [] }),
		).toBe(
			"Its next message may read the whole conversation once without cache (about 1,000 tokens; more where the vendor also charges for writing the new cache). Pi has no price for this model, so no amount is given.",
		);
		expect(
			costText({ tokens: null, model: model({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }), to: [] }),
		).toBe(
			"Its next message may read the whole conversation once without cache (its size is not known until its next answer; more where the vendor also charges for writing the new cache).",
		);
	});
});

describe("/provimux-route: reading the answers", () => {
	it("fields it does not know are ignored; something else is no answer", () => {
		expect(parseShowAnswer({ ...C.FellBack, something_new: { a: 1 } })?.binding).toBe("b.k3v7q2mfx4ardn5w");
		expect(parseReleaseAnswer({ ...C.Released, extra: true })?.released).toBe(true);
		expect(parseShowAnswer({ hello: 1 })).toBeUndefined();
		expect(parseShowAnswer({ ...C.FellBack, bound: { route: 7 } })).toBeUndefined();
		expect(parseReleaseAnswer({ hello: 1 })).toBeUndefined();
	});
});
