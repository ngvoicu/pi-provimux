/**
 * `/provimux-route` against a stand-in for Provimux's two session-route paths, answering with the contract's examples
 * (test/session-route-contract.ts). Every text the command prints is pinned here, case by case, with what it asked and
 * the order of what it did; the tests below the table check what it sends, that nothing is released before the cost
 * was said and answered yes unless Pi knows the cache is cold, the 409, "not seen" asked twice, and the Codex
 * WebSocket. The gateway's times are its answers' own (observed_at), written in UTC; Pi's clock and what it knows of the
 * cache are the harness's: nothing depends on this machine's clock or speed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetCacheUses, lastCacheUse, noteCacheUse } from "../extensions/last-use.ts";
import {
	cacheText,
	cacheViewOf,
	costText,
	durationWords,
	expectToken,
	knownCold,
	parseReleaseAnswer,
	parseShowAnswer,
	ROUTE_COMMAND,
} from "../extensions/route.ts";
import {
	cleanupRouteRuns,
	PI_NOW,
	RELEASE_URL,
	type RouteCase,
	runRoute,
	SESSION_ID,
	SHOW_URL,
	type StandInAnswer,
} from "./route-harness.ts";
import * as C from "./session-route-contract.ts";

afterEach(() => {
	vi.useRealTimers();
	cleanupRouteRuns();
	forgetCacheUses();
});

const ok = (body: unknown): StandInAnswer => ({ status: 200, body });
/** As this release answers: no rule in effect. */
const now = <T extends object>(answer: T) => ({ ...answer, rule: { in_effect: false, cold_after_s: null } });
const fb = now(C.FellBackCacheCold);
const cooling = C.FellBackFirstRouteCooling;
const two = now(C.OnFirstRoute);
/** Pi's last request 12 minutes ago, on a 5-minute cache: Pi knows it is cold. */
const cold = { noted: { agoMs: 12 * 60_000, ttlMs: 300_000 } };
/** Pi's last request 12 minutes ago, without a lifetime. */
const unknownTtl = { noted: { agoMs: 12 * 60_000 } };

type Expected = { notes: Array<[string, string]>; asked: Array<[string, string]>; order: string[] };
const CASES: Array<[string, string, RouteCase, Expected]> = [
	[
		"show fallback, first route free, Pi: may be warm",
		"",
		{ show: [ok(fb)] },
		{
			notes: [
				[
					"Route of this conversation on opus, as Provimux says now (this check sends nothing to a model and costs nothing):\n• Now on: Anthropic api, since 09:35 (40 minutes ago).\n• A fallback: Anthropic sub answered it before, until 09:35.\n• The first route, Anthropic sub, is free now.\n• Its cache: Pi knows this cache lasts 5 minutes; last answer 2 minutes ago: it may be warm for about 3 minutes more.\n• By itself: Provimux never moves it back; only a release does.\nTo move it back now: /provimux-route release (it asks first unless Pi knows the cache is cold).",
					"info",
				],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"show fallback, Pi: cold",
		"",
		{ ...cold, show: [ok(fb)] },
		{
			notes: [
				[
					"Route of this conversation on opus, as Provimux says now (this check sends nothing to a model and costs nothing):\n• Now on: Anthropic api, since 09:35 (40 minutes ago).\n• A fallback: Anthropic sub answered it before, until 09:35.\n• The first route, Anthropic sub, is free now.\n• Its cache: Pi knows this cache lasts 5 minutes; last answer 12 minutes ago: it is cold.\n• By itself: Provimux never moves it back; only a release does.\nTo move it back now: /provimux-route release (it asks first unless Pi knows the cache is cold).",
					"info",
				],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"show fallback, Pi: lifetime not known",
		"",
		{ ...unknownTtl, show: [ok(fb)] },
		{
			notes: [
				[
					"Route of this conversation on opus, as Provimux says now (this check sends nothing to a model and costs nothing):\n• Now on: Anthropic api, since 09:35 (40 minutes ago).\n• A fallback: Anthropic sub answered it before, until 09:35.\n• The first route, Anthropic sub, is free now.\n• Its cache: Pi does not know how long this cache lasts (last answer 12 minutes ago), so it may still be warm.\n• By itself: Provimux never moves it back; only a release does.\nTo move it back now: /provimux-route release (it asks first unless Pi knows the cache is cold).",
					"info",
				],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"show fallback, Pi: from the session's last answer and the model's promptCache",
		"",
		{ noted: null, lastAnswerAgoMs: 20 * 60_000, promptCache: { short: 300 }, show: [ok(fb)] },
		{
			notes: [
				[
					"Route of this conversation on opus, as Provimux says now (this check sends nothing to a model and costs nothing):\n• Now on: Anthropic api, since 09:35 (40 minutes ago).\n• A fallback: Anthropic sub answered it before, until 09:35.\n• The first route, Anthropic sub, is free now.\n• Its cache: Pi knows this cache lasts 5 minutes; last answer 20 minutes ago: it is cold.\n• By itself: Provimux never moves it back; only a release does.\nTo move it back now: /provimux-route release (it asks first unless Pi knows the cache is cold).",
					"info",
				],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"show fallback, Pi: nothing to go by",
		"",
		{ noted: null, show: [ok(fb)] },
		{
			notes: [
				[
					"Route of this conversation on opus, as Provimux says now (this check sends nothing to a model and costs nothing):\n• Now on: Anthropic api, since 09:35 (40 minutes ago).\n• A fallback: Anthropic sub answered it before, until 09:35.\n• The first route, Anthropic sub, is free now.\n• Its cache: Pi does not know how long this cache lasts, so it may still be warm.\n• By itself: Provimux never moves it back; only a release does.\nTo move it back now: /provimux-route release (it asks first unless Pi knows the cache is cold).",
					"info",
				],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"show fallback, with a rule in effect (a later release)",
		"",
		{ show: [ok(C.FellBackCacheCold)] },
		{
			notes: [
				[
					"Route of this conversation on opus, as Provimux says now (this check sends nothing to a model and costs nothing):\n• Now on: Anthropic api, since 09:35 (40 minutes ago).\n• A fallback: Anthropic sub answered it before, until 09:35.\n• The first route, Anthropic sub, is free now.\n• Its cache: Pi knows this cache lasts 5 minutes; last answer 2 minutes ago: it may be warm for about 3 minutes more.\n• By itself: Provimux moves it back at your next message once this conversation has been unused for 6 minutes, if a higher-priority route is free then.\nTo move it back now: /provimux-route release (it asks first unless Pi knows the cache is cold).",
					"info",
				],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"show first route cooling",
		"",
		{ show: [ok(cooling)] },
		{
			notes: [
				[
					"Route of this conversation on opus, as Provimux says now (this check sends nothing to a model and costs nothing):\n• Now on: Anthropic api, since 09:35 (40 minutes ago).\n• A fallback: Anthropic sub answered it before, until 09:35.\n• The first route, Anthropic sub, is not free yet: expected free at 10:40 (in 25 minutes).\n• Its cache: Pi knows this cache lasts 5 minutes; last answer 2 minutes ago: it may be warm for about 3 minutes more.\n• By itself: Provimux never moves it back; only a release does.\nTo check again later: /provimux-route (it asks Provimux afresh every time).",
					"info",
				],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"show first route cooling, when not known",
		"",
		{
			show: [
				ok({
					...cooling,
					position: { below_first: true, higher_priority_free: false, higher_priority_free_at: null },
				}),
			],
		},
		{
			notes: [
				[
					"Route of this conversation on opus, as Provimux says now (this check sends nothing to a model and costs nothing):\n• Now on: Anthropic api, since 09:35 (40 minutes ago).\n• A fallback: Anthropic sub answered it before, until 09:35.\n• The first route, Anthropic sub, is not free yet, and Provimux does not know when it will be.\n• Its cache: Pi knows this cache lasts 5 minutes; last answer 2 minutes ago: it may be warm for about 3 minutes more.\n• By itself: Provimux never moves it back; only a release does.\nTo check again later: /provimux-route (it asks Provimux afresh every time).",
					"info",
				],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"show on a first route shared with another",
		"",
		{ show: [ok(two)] },
		{
			notes: [
				[
					"Route of this conversation on opus, as Provimux says now (this check sends nothing to a model and costs nothing):\n• Now on: Anthropic sub, since 09:02 (1 hour 12 minutes ago).\n• Not a fallback: no other route has answered it.\n• It is on a first route: 2 routes share the top priority (2 Anthropic sub accounts). A release lets Provimux choose among them again, and it may choose the same one.\n• Its cache: Pi knows this cache lasts 5 minutes; last answer 2 minutes ago: it may be warm for about 3 minutes more.\n• By itself: Provimux never moves it back; only a release does.\nTo let Provimux choose again: /provimux-route release (it asks first unless Pi knows the cache is cold).",
					"info",
				],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"show bound to an unlisted account, asked as auto",
		"",
		{ show: [ok(C.BoundToUnlisted)] },
		{
			notes: [
				[
					"Route of this conversation on auto (routed to opus), as Provimux says now (this check sends nothing to a model and costs nothing):\n• Now on: an account that is no longer listed, since 09:02 (1 hour 12 minutes ago).\n• Not a fallback: no other route has answered it.\n• The first route now: Anthropic api. Provimux does not say where the account it is on stands.\n• Its cache: Pi knows this cache lasts 5 minutes; last answer 2 minutes ago: it may be warm for about 3 minutes more.\n• By itself: Provimux never moves it back; only a release does.\nTo move it to a listed route now: /provimux-route release (it asks first unless Pi knows the cache is cold).",
					"info",
				],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"show not seen, asked again after a moment",
		"",
		{ show: [ok(C.NotSeen), ok(C.NotSeen)] },
		{
			notes: [
				[
					"Route of this conversation on opus, as Provimux says now (this check sends nothing to a model and costs nothing):\nProvimux has no record of this conversation on opus from your key: it has seen no message of it since it started, or it has forgotten it since its binding expired. Send a message, then type /provimux-route again.",
					"info",
				],
			],
			asked: [],
			order: ["show", "sleep 1500", "show"],
		},
	],
	[
		"show not seen, then seen on the second look",
		"",
		{ show: [ok(C.NotSeen), ok(fb)] },
		{
			notes: [
				[
					"Route of this conversation on opus, as Provimux says now (this check sends nothing to a model and costs nothing):\n• Now on: Anthropic api, since 09:35 (40 minutes ago).\n• A fallback: Anthropic sub answered it before, until 09:35.\n• The first route, Anthropic sub, is free now.\n• Its cache: Pi knows this cache lasts 5 minutes; last answer 2 minutes ago: it may be warm for about 3 minutes more.\n• By itself: Provimux never moves it back; only a release does.\nTo move it back now: /provimux-route release (it asks first unless Pi knows the cache is cold).",
					"info",
				],
			],
			asked: [],
			order: ["show", "sleep 1500", "show"],
		},
	],
	[
		"show not seen, a session that sent nothing",
		"",
		{ noted: null, show: [ok(C.NotSeen)] },
		{
			notes: [
				[
					"Route of this conversation on opus, as Provimux says now (this check sends nothing to a model and costs nothing):\nProvimux has no record of this conversation on opus from your key: it has seen no message of it since it started, or it has forgotten it since its binding expired. Send a message, then type /provimux-route again.",
					"info",
				],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"show affinity off",
		"",
		{ show: [ok(C.AffinityOff)] },
		{
			notes: [
				[
					"Route of this conversation on opus, as Provimux says now (this check sends nothing to a model and costs nothing):\nProvimux does not bind conversations to a route (its session affinity is off): every request already goes to the first available route, so there is nothing to move.",
					"info",
				],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"show home",
		"",
		{ show: [ok({ ...C.AffinityOff, affinity: "home" })] },
		{
			notes: [
				[
					"Route of this conversation on opus, as Provimux says now (this check sends nothing to a model and costs nothing):\nProvimux runs in Home mode: Home chooses the route of every request, so there is no binding here to show or move.",
					"info",
				],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"show plugin",
		"",
		{ show: [ok({ ...C.AffinityOff, affinity: "not-supported" })] },
		{
			notes: [
				[
					"Route of this conversation on opus, as Provimux says now (this check sends nothing to a model and costs nothing):\nA plugin chooses the routes on this Provimux, so there is no binding here to show or move.",
					"info",
				],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"show not bound",
		"",
		{ show: [ok({ ...C.NotSeen, conversation: "not-bound" })] },
		{
			notes: [
				[
					"Route of this conversation on opus, as Provimux says now (this check sends nothing to a model and costs nothing):\nThis conversation is not bound to a route on opus right now (it was released, or its binding expired): its next message goes to the first available route.",
					"info",
				],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"show 404",
		"",
		{ show: [{ status: 404 }] },
		{
			notes: [
				[
					"This server has no conversation routes: /provimux-route needs Provimux <version> or newer (plain CLIProxyAPI has none). Update Provimux to use it; everything else works as before.",
					"error",
				],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"show 401",
		"",
		{ show: [{ status: 401, body: { error: "Invalid API key" } }] },
		{
			notes: [
				["The server refused the client key (HTTP 401). Type /login Provimux to enter the key again.", "error"],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"show 400",
		"",
		{ show: [{ status: 400, body: { error: { message: "the model opus is not served to this key" } } }] },
		{
			notes: [
				[
					"The server refused the request (HTTP 400): the model opus is not served to this key. If it says the model is not served, choose another in /model.",
					"error",
				],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"show 500",
		"",
		{ show: [{ status: 500, body: { error: { message: "boom" } } }] },
		{
			notes: [
				["The server answered HTTP 500: boom. Try again in a moment; if it persists, check the server.", "error"],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"show unreachable",
		"",
		{ show: [{ unreachable: "fetch failed" }] },
		{
			notes: [
				[
					"Could not reach your Provimux server at http://gateway.test:8400/v1/provimux/session-route: fetch failed. Check that it is running, or type /login Provimux to change its address.",
					"error",
				],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"show unreadable",
		"",
		{ show: [ok({ hello: 1 })] },
		{
			notes: [
				[
					"The server's answer could not be read as a conversation route: is it Provimux <version> or newer?",
					"error",
				],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"not set up",
		"",
		{ unconfigured: true },
		{
			notes: [
				[
					"Provimux is not set up yet, so there is no conversation route to show. Type /login Provimux (or /login provimux) and enter your server's address and key.",
					"error",
				],
			],
			asked: [],
			order: [],
		},
	],
	[
		"other model",
		"",
		{ model: { provider: "anthropic", id: "claude-opus-4-6" } },
		{
			notes: [
				[
					"/provimux-route shows the route of a Provimux model, and the current model is anthropic/claude-opus-4-6. Choose a Provimux model in /model, then type /provimux-route again.",
					"error",
				],
			],
			asked: [],
			order: [],
		},
	],
	[
		"no model",
		"",
		{ model: null },
		{
			notes: [
				[
					"/provimux-route shows the route of a Provimux model, and no model is selected. Choose a Provimux model in /model, then type /provimux-route again.",
					"error",
				],
			],
			asked: [],
			order: [],
		},
	],
	[
		"bad args",
		"foo",
		{},
		{
			notes: [
				[
					"/provimux-route takes nothing (show where this conversation is), or release (move it back to its first route).",
					"error",
				],
			],
			asked: [],
			order: [],
		},
	],
	[
		"release, first route cooling",
		"release",
		{ show: [ok(cooling)] },
		{
			notes: [
				[
					"Nothing was released: the first route, Anthropic sub, is not free yet, so the conversation stays on Anthropic api. It is expected free at 10:40 (in 25 minutes): type /provimux-route release again then.",
					"warning",
				],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"release, Pi knows the cache is cold",
		"release",
		{ ...cold, show: [ok(fb)], release: [ok(C.Released)] },
		{
			notes: [
				[
					"Released: this conversation is no longer bound to Anthropic api. Its next message goes to Anthropic sub. Pi knows the cache was cold, so the move costs nothing extra.",
					"info",
				],
			],
			asked: [],
			order: ["show", "release", "close"],
		},
	],
	[
		"release, may be warm, TUI yes",
		"release",
		{ show: [ok(fb)], release: [ok(C.Released)], confirm: [true] },
		{
			notes: [
				[
					"Released: this conversation is no longer bound to Anthropic api. Its next message goes to Anthropic sub. That message reads the whole conversation once without cache.",
					"info",
				],
			],
			asked: [
				[
					"Move this conversation from Anthropic api to Anthropic sub now?",
					"Moving now costs one read of the whole conversation without cache (about 182,000 tokens, about $0.55 at the list price; more where the vendor also charges for writing the new cache). Staying costs a cached read, about $0.05 a message, while the cache is warm. Pi knows this cache lasts 5 minutes; last answer 2 minutes ago: it may be warm for about 3 minutes more. On Anthropic sub this is quota of the subscription, not money: the amounts are at API list price, for comparison.",
				],
			],
			order: ["show", "ask", "release", "close"],
		},
	],
	[
		"release, may be warm, TUI no",
		"release",
		{ show: [ok(fb)], confirm: [false] },
		{
			notes: [["Nothing was released: the conversation stays on Anthropic api, with its cache.", "info"]],
			asked: [
				[
					"Move this conversation from Anthropic api to Anthropic sub now?",
					"Moving now costs one read of the whole conversation without cache (about 182,000 tokens, about $0.55 at the list price; more where the vendor also charges for writing the new cache). Staying costs a cached read, about $0.05 a message, while the cache is warm. Pi knows this cache lasts 5 minutes; last answer 2 minutes ago: it may be warm for about 3 minutes more. On Anthropic sub this is quota of the subscription, not money: the amounts are at API list price, for comparison.",
				],
			],
			order: ["show", "ask"],
		},
	],
	[
		"release, lifetime not known, TUI yes",
		"release",
		{ ...unknownTtl, show: [ok(fb)], release: [ok(C.Released)], confirm: [true] },
		{
			notes: [
				[
					"Released: this conversation is no longer bound to Anthropic api. Its next message goes to Anthropic sub. That message reads the whole conversation once without cache.",
					"info",
				],
			],
			asked: [
				[
					"Move this conversation from Anthropic api to Anthropic sub now?",
					"Moving now costs one read of the whole conversation without cache (about 182,000 tokens, about $0.55 at the list price; more where the vendor also charges for writing the new cache). Staying costs a cached read, about $0.05 a message, while the cache is warm. Pi does not know how long this cache lasts (last answer 12 minutes ago), so it may still be warm. On Anthropic sub this is quota of the subscription, not money: the amounts are at API list price, for comparison.",
				],
			],
			order: ["show", "ask", "release", "close"],
		},
	],
	[
		"release, may be warm, RPC",
		"release",
		{ mode: "rpc", show: [ok(fb)] },
		{
			notes: [
				[
					"Moving now costs one read of the whole conversation without cache (about 182,000 tokens, about $0.55 at the list price; more where the vendor also charges for writing the new cache). Staying costs a cached read, about $0.05 a message, while the cache is warm. Pi knows this cache lasts 5 minutes; last answer 2 minutes ago: it may be warm for about 3 minutes more. On Anthropic sub this is quota of the subscription, not money: the amounts are at API list price, for comparison.\nNothing was released. To move it from Anthropic api to Anthropic sub anyway, type /provimux-route release yes.",
					"warning",
				],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"release yes, may be warm, RPC",
		"release yes",
		{ mode: "rpc", show: [ok(fb)], release: [ok(C.Released)] },
		{
			notes: [
				[
					"Released: this conversation is no longer bound to Anthropic api. Its next message goes to Anthropic sub. That message reads the whole conversation once without cache.",
					"info",
				],
			],
			asked: [],
			order: ["show", "release", "close"],
		},
	],
	[
		"release, no size, no price, nothing to go by, RPC",
		"release",
		{
			mode: "rpc",
			noted: null,
			tokens: null,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			show: [ok(fb)],
		},
		{
			notes: [
				[
					"Moving now costs one read of the whole conversation without cache (its size is not known until its next answer; more where the vendor also charges for writing the new cache). Pi does not know how long this cache lasts, so it may still be warm. Pi has no price for this model, so no amount is given. On Anthropic sub this is quota of the subscription, not money.\nNothing was released. To move it from Anthropic api to Anthropic sub anyway, type /provimux-route release yes.",
					"warning",
				],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"release, two first routes",
		"release",
		{ show: [ok(two)], confirm: [true], release: [ok({ ...C.Released, was: two.bound.route, next: two.first })] },
		{
			notes: [
				[
					"Released: this conversation is no longer bound to Anthropic sub. Its next message goes to one of 2 Anthropic sub accounts. That message reads the whole conversation once without cache.",
					"info",
				],
			],
			asked: [
				[
					"Let Provimux choose this conversation's route again now?",
					"Moving now costs one read of the whole conversation without cache (about 182,000 tokens, about $0.55 at the list price; more where the vendor also charges for writing the new cache). Staying costs a cached read, about $0.05 a message, while the cache is warm. Pi knows this cache lasts 5 minutes; last answer 2 minutes ago: it may be warm for about 3 minutes more. On Anthropic sub this is quota of the subscription, not money: the amounts are at API list price, for comparison. It is already on a first route: Provimux chooses among the 2 routes of the top priority again, and may choose the same one.",
				],
			],
			order: ["show", "ask", "release", "close"],
		},
	],
	[
		"release, the only first route",
		"release",
		{ show: [ok({ ...two, first: [two.first[0]] })] },
		{
			notes: [
				[
					"Nothing was released: this conversation is already on the first route (Anthropic sub), and no other route shares its priority.",
					"info",
				],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"release, bound to an unlisted account",
		"release",
		{
			show: [ok(C.BoundToUnlisted)],
			confirm: [true],
			release: [
				ok({
					...C.Released,
					model: "auto",
					routed_model: "opus",
					was: { listed: false },
					next: C.BoundToUnlisted.first,
				}),
			],
		},
		{
			notes: [
				[
					"Released: this conversation is no longer bound to an account that is no longer listed. Its next message goes to Anthropic api. That message reads the whole conversation once without cache.",
					"info",
				],
			],
			asked: [
				[
					"Move this conversation from an account that is no longer listed to Anthropic api now?",
					"Moving now costs one read of the whole conversation without cache (about 182,000 tokens, about $0.55 at the list price; more where the vendor also charges for writing the new cache). Staying costs a cached read, about $0.05 a message, while the cache is warm. Pi knows this cache lasts 5 minutes; last answer 2 minutes ago: it may be warm for about 3 minutes more.",
				],
			],
			order: ["show", "ask", "release", "close"],
		},
	],
	[
		"release, 409 in the TUI",
		"release",
		{
			show: [ok(fb)],
			confirm: [true, true],
			release: [{ status: 409, body: { ...fb, binding: "b.n4w7q2mfx4ardn5w" } }, ok(C.Released)],
		},
		{
			notes: [
				[
					"The conversation's binding changed since the check, so nothing was released yet.\nRoute of this conversation on opus, as Provimux says now (this check sends nothing to a model and costs nothing):\n• Now on: Anthropic api, since 09:35 (40 minutes ago).\n• A fallback: Anthropic sub answered it before, until 09:35.\n• The first route, Anthropic sub, is free now.\n• Its cache: Pi knows this cache lasts 5 minutes; last answer 2 minutes ago: it may be warm for about 3 minutes more.\n• By itself: Provimux never moves it back; only a release does.",
					"info",
				],
				[
					"Released: this conversation is no longer bound to Anthropic api. Its next message goes to Anthropic sub. That message reads the whole conversation once without cache.",
					"info",
				],
			],
			asked: [
				[
					"Move this conversation from Anthropic api to Anthropic sub now?",
					"Moving now costs one read of the whole conversation without cache (about 182,000 tokens, about $0.55 at the list price; more where the vendor also charges for writing the new cache). Staying costs a cached read, about $0.05 a message, while the cache is warm. Pi knows this cache lasts 5 minutes; last answer 2 minutes ago: it may be warm for about 3 minutes more. On Anthropic sub this is quota of the subscription, not money: the amounts are at API list price, for comparison.",
				],
				[
					"Move this conversation from Anthropic api to Anthropic sub now?",
					"Moving now costs one read of the whole conversation without cache (about 182,000 tokens, about $0.55 at the list price; more where the vendor also charges for writing the new cache). Staying costs a cached read, about $0.05 a message, while the cache is warm. Pi knows this cache lasts 5 minutes; last answer 2 minutes ago: it may be warm for about 3 minutes more. On Anthropic sub this is quota of the subscription, not money: the amounts are at API list price, for comparison.",
				],
			],
			order: ["show", "ask", "release", "ask", "release", "close"],
		},
	],
	[
		"release yes, 409 in RPC",
		"release yes",
		{ mode: "rpc", show: [ok(fb)], release: [{ status: 409, body: { ...fb, binding: "b.n4w7q2mfx4ardn5w" } }] },
		{
			notes: [
				[
					"The conversation's binding changed since the check, so nothing was released yet.\nRoute of this conversation on opus, as Provimux says now (this check sends nothing to a model and costs nothing):\n• Now on: Anthropic api, since 09:35 (40 minutes ago).\n• A fallback: Anthropic sub answered it before, until 09:35.\n• The first route, Anthropic sub, is free now.\n• Its cache: Pi knows this cache lasts 5 minutes; last answer 2 minutes ago: it may be warm for about 3 minutes more.\n• By itself: Provimux never moves it back; only a release does.\nType /provimux-route release again to release it as it is now.",
					"warning",
				],
			],
			asked: [],
			order: ["show", "release"],
		},
	],
	[
		"release, nothing bound any more",
		"release",
		{ ...cold, show: [ok(fb)], release: [ok(C.NothingBound)] },
		{
			notes: [
				[
					"Nothing was released: the conversation was no longer bound (its binding expired or was released meanwhile). Its next message goes to the first available route.",
					"info",
				],
			],
			asked: [],
			order: ["show", "release"],
		},
	],
	[
		"release, the release answers not seen",
		"release",
		{ ...cold, show: [ok(fb)], release: [ok(C.ReleaseNotSeen)] },
		{
			notes: [
				[
					"Provimux has no record of this conversation on opus from your key: it has seen no message of it since it started, or it has forgotten it since its binding expired. Send a message, then type /provimux-route again. Nothing was released.",
					"info",
				],
			],
			asked: [],
			order: ["show", "release"],
		},
	],
	[
		"release, the release answers affinity off",
		"release",
		{ ...cold, show: [ok(fb)], release: [ok(C.ReleaseAffinityOff)] },
		{
			notes: [
				[
					"Provimux does not bind conversations to a route (its session affinity is off): every request already goes to the first available route, so there is nothing to move. Nothing was released.",
					"info",
				],
			],
			asked: [],
			order: ["show", "release"],
		},
	],
	[
		"release, the show answers not seen",
		"release",
		{ show: [ok(C.NotSeen), ok(C.NotSeen)] },
		{
			notes: [
				[
					"Provimux has no record of this conversation on opus from your key: it has seen no message of it since it started, or it has forgotten it since its binding expired. Send a message, then type /provimux-route again. Nothing was released.",
					"info",
				],
			],
			asked: [],
			order: ["show", "sleep 1500", "show"],
		},
	],
	[
		"release, the show answers affinity off",
		"release",
		{ show: [ok(C.AffinityOff)] },
		{
			notes: [
				[
					"Provimux does not bind conversations to a route (its session affinity is off): every request already goes to the first available route, so there is nothing to move. Nothing was released.",
					"info",
				],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"release, show 404",
		"release",
		{ show: [{ status: 404 }] },
		{
			notes: [
				[
					"This server has no conversation routes: /provimux-route needs Provimux <version> or newer (plain CLIProxyAPI has none). Nothing was released. Update Provimux to use it; everything else works as before.",
					"error",
				],
			],
			asked: [],
			order: ["show"],
		},
	],
	[
		"release, release 404",
		"release",
		{ ...cold, show: [ok(fb)], release: [{ status: 404 }] },
		{
			notes: [
				[
					"This server has no conversation routes: /provimux-route needs Provimux <version> or newer (plain CLIProxyAPI has none). Nothing was released. Update Provimux to use it; everything else works as before.",
					"error",
				],
			],
			asked: [],
			order: ["show", "release"],
		},
	],
	[
		"release, Codex WebSocket",
		"release",
		{
			...cold,
			format: "codex",
			show: [
				ok({ ...fb, model: "gpt-main", websocket_may_hold: true }),
				ok({ ...C.NotSeen, model: "gpt-main", conversation: "not-bound" }),
			],
			release: [ok({ ...C.Released, model: "gpt-main", websocket_may_hold: true })],
		},
		{
			notes: [
				[
					"Released: this conversation is no longer bound to Anthropic api. Its next message goes to Anthropic sub. Pi knows the cache was cold, so the move costs nothing extra. Its Codex WebSocket, if one was open, was closed, so that the release holds.",
					"info",
				],
			],
			asked: [],
			order: ["show", "release", "close", "show"],
		},
	],
	[
		"release, Codex WebSocket, a turn slipped in first",
		"release",
		{
			...cold,
			format: "codex",
			show: [
				ok({ ...fb, model: "gpt-main", websocket_may_hold: true }),
				ok({ ...fb, model: "gpt-main", binding: "b.r2x7q2mfx4ardn5w", websocket_may_hold: true }),
			],
			release: [
				ok({ ...C.Released, model: "gpt-main", websocket_may_hold: true }),
				ok({ ...C.Released, model: "gpt-main", websocket_may_hold: true }),
			],
		},
		{
			notes: [
				[
					"Released: this conversation is no longer bound to Anthropic api. Its next message goes to Anthropic sub. Pi knows the cache was cold, so the move costs nothing extra. Its Codex WebSocket, if one was open, was closed, so that the release holds. A turn had bound it to the old account again on the open socket: it was released again.",
					"info",
				],
			],
			asked: [],
			order: ["show", "release", "close", "show", "release", "close"],
		},
	],
];

describe("/provimux-route: every text, per case", () => {
	for (const [name, args, setup, expected] of CASES) {
		it(`${name} (/${ROUTE_COMMAND}${args ? ` ${args}` : ""})`, async () => {
			const run = await runRoute(args, setup);
			expect(run.notes).toEqual(expected.notes);
			expect(run.asked).toEqual(expected.asked);
			expect(run.order).toEqual(expected.order);
		});
	}
});

describe("/provimux-route: what it sends", () => {
	it("a Claude-format model: the show names the conversation by x-session-affinity, as its turns do, and sends only the name", async () => {
		const run = await runRoute("", { show: [ok(fb)] });
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

	it("a Codex-format model: by session-id, as its turns do", async () => {
		const run = await runRoute("", { format: "codex", noted: null, show: [ok(C.NotSeen)] });
		expect(run.sent[0]!.headers["session-id"]).toBe(SESSION_ID);
		expect(run.sent[0]!.headers).not.toHaveProperty("x-session-affinity");
		expect(run.sent[0]!.body).toEqual({ model: "gpt-main" });
	});

	it("every call asks the server afresh: nothing is kept between two checks", async () => {
		const first = await runRoute("", { show: [ok(cooling)] });
		const second = await runRoute("", { show: [ok(fb)] });
		expect(first.order).toEqual(["show"]);
		expect(second.order).toEqual(["show"]);
		expect(first.notes[0]![0]).toContain("is not free yet: expected free at 10:40");
		expect(second.notes[0]![0]).toContain("is free now");
	});

	it("expect is the show's binding; after a 409, the 409's; without a well-formed one it is left out, never empty or null", async () => {
		const run = await runRoute("release", {
			show: [ok(fb)],
			confirm: [true, true],
			release: [{ status: 409, body: { ...fb, binding: "b.n4w7q2mfx4ardn5w" } }, ok(C.Released)],
		});
		expect(run.sent.map((sent) => [sent.url, sent.body])).toEqual([
			[SHOW_URL, { model: "opus" }],
			[RELEASE_URL, { model: "opus", expect: "b.k3v7q2mfx4ardn5w" }],
			[RELEASE_URL, { model: "opus", expect: "b.n4w7q2mfx4ardn5w" }],
		]);
		expect(run.sent[1]!.headers["x-session-affinity"]).toBe(SESSION_ID);
		for (const binding of [null, "", " ", "b. x"]) {
			const without = await runRoute("release", {
				...cold,
				show: [ok({ ...fb, binding })],
				release: [ok(C.Released)],
			});
			expect(without.sent[1]!.body).toEqual({ model: "opus" });
		}
		expect(expectToken("b.k3v7q2mfx4ardn5w")).toBe("b.k3v7q2mfx4ardn5w");
	});
});

describe("/provimux-route release: a yes unless Pi knows the cache is cold", () => {
	it("may be warm, in the TUI: the dialog says the cost before anything is released, and no releases nothing", async () => {
		const declined = await runRoute("release", { show: [ok(fb)], confirm: [false] });
		expect(declined.order).toEqual(["show", "ask"]);
		expect(declined.sent.map((sent) => sent.url)).toEqual([SHOW_URL]);
		expect(declined.asked[0]![1]).toContain("about 182,000 tokens, about $0.55 at the list price");
		const accepted = await runRoute("release", { show: [ok(fb)], confirm: [true], release: [ok(C.Released)] });
		expect(accepted.order).toEqual(["show", "ask", "release", "close"]);
	});

	it("whatever Pi does not know is taken as possibly warm: no lifetime, no last answer, or both", async () => {
		for (const setup of [unknownTtl, { noted: null }, { noted: null, promptCache: { short: 300 } }] as RouteCase[]) {
			const run = await runRoute("release", { ...setup, show: [ok(fb)], confirm: [false] });
			expect(run.order).toEqual(["show", "ask"]);
		}
	});

	it("Pi knows it is cold, from a noted request or from the session's last answer and the model's lifetime: no question", async () => {
		for (const setup of [
			cold,
			{ noted: null, lastAnswerAgoMs: 20 * 60_000, promptCache: { short: 300 } },
		] as RouteCase[]) {
			const run = await runRoute("release", { ...setup, show: [ok(fb)], release: [ok(C.Released)] });
			expect(run.asked).toEqual([]);
			expect(run.order).toEqual(["show", "release", "close"]);
		}
	});

	it("in the TUI, release yes still asks: the yes is given to the cost shown", async () => {
		const run = await runRoute("release yes", { show: [ok(fb)], confirm: [false] });
		expect(run.order).toEqual(["show", "ask"]);
	});

	it("outside the TUI (RPC, print): the cost is printed and only release yes releases", async () => {
		for (const mode of ["rpc", "print"] as const) {
			const shown = await runRoute("release", { mode, show: [ok(fb)] });
			expect(shown.order).toEqual(["show"]);
			const released = await runRoute("release yes", { mode, show: [ok(fb)], release: [ok(C.Released)] });
			expect(released.order).toEqual(["show", "release", "close"]);
			expect(released.asked).toEqual([]);
		}
	});

	it("the first route not free: nothing is sent but the check", async () => {
		const run = await runRoute("release yes", { mode: "rpc", show: [ok(cooling)] });
		expect(run.sent.map((sent) => sent.url)).toEqual([SHOW_URL]);
	});

	it("a binding that keeps changing: the TUI asks again at most twice more, then stops", async () => {
		const changed = { status: 409, body: { ...fb, binding: "b.n4w7q2mfx4ardn5w" } };
		const run = await runRoute("release", {
			show: [ok(fb)],
			confirm: [true, true, true, true],
			release: [changed, changed, changed],
		});
		expect(run.order).toEqual(["show", "ask", "release", "ask", "release", "ask", "release"]);
		expect(run.notes.at(-1)![0]).toContain("Type /provimux-route release again to release it as it is now.");
	});
});

describe("/provimux-route: not seen", () => {
	it("a session that has sent requests: asked once more after a moment, then said", async () => {
		const run = await runRoute("", { show: [ok(C.NotSeen), ok(C.NotSeen)] });
		expect(run.order).toEqual(["show", "sleep 1500", "show"]);
	});

	it("a session Pi knows sent nothing, and a not-seen show that is not the first: no second look", async () => {
		expect((await runRoute("", { noted: null, show: [ok(C.NotSeen)] })).order).toEqual(["show"]);
	});
});

describe("/provimux-route release: the Codex WebSocket", () => {
	const codex = (over: object = {}) => ({ ...fb, model: "gpt-main", websocket_may_hold: true, ...over });
	it("closed right after a successful release, before anything else; then checked once", async () => {
		const run = await runRoute("release", {
			...cold,
			format: "codex",
			show: [ok(codex()), ok({ ...C.NotSeen, conversation: "not-bound" })],
			release: [ok({ ...C.Released, websocket_may_hold: true })],
		});
		expect(run.closed).toEqual([SESSION_ID]);
		expect(run.order).toEqual(["show", "release", "close", "show"]);
	});

	it("a turn that slipped in on the old socket and bound it again: released again, then closed again", async () => {
		const run = await runRoute("release", {
			...cold,
			format: "codex",
			show: [ok(codex()), ok(codex({ binding: "b.r2x7q2mfx4ardn5w" }))],
			release: [ok({ ...C.Released, websocket_may_hold: true }), ok({ ...C.Released, websocket_may_hold: true })],
		});
		expect(run.order).toEqual(["show", "release", "close", "show", "release", "close"]);
		expect(run.sent[3]!.body).toEqual({ model: "gpt-main", expect: "b.r2x7q2mfx4ardn5w" });
	});

	it("whatever header named the conversation: a Claude-format one that says websocket_may_hold is closed and checked too", async () => {
		const run = await runRoute("release", {
			...cold,
			show: [ok({ ...fb, websocket_may_hold: true }), ok({ ...C.NotSeen, conversation: "not-bound" })],
			release: [ok({ ...C.Released, websocket_may_hold: true })],
		});
		expect(run.order).toEqual(["show", "release", "close", "show"]);
		expect(run.notes[0]![0]).toContain("Its Codex WebSocket, if one was open, was closed");
	});

	it("nothing released: nothing closed", async () => {
		const none = await runRoute("release", {
			...cold,
			format: "codex",
			show: [ok(codex())],
			release: [ok({ ...C.NothingBound, websocket_may_hold: true })],
		});
		expect(none.closed).toEqual([]);
	});
});

describe("/provimux-route: what Pi knows of the cache", () => {
	it("the later of a noted request and the session's last answer; the lifetime noted with it, else the model's", () => {
		expect(
			cacheViewOf({ noted: { at: 1000, ttlMs: 300_000 }, lastAnswerAt: 500, modelTtlMs: 3_600_000, now: 61_000 }),
		).toEqual({
			ttlMs: 300_000,
			sinceMs: 60_000,
		});
		expect(cacheViewOf({ noted: { at: 500 }, lastAnswerAt: 1000, modelTtlMs: 3_600_000, now: 61_000 })).toEqual({
			ttlMs: 3_600_000,
			sinceMs: 60_000,
		});
		expect(cacheViewOf({ noted: undefined, lastAnswerAt: undefined, modelTtlMs: undefined, now: 1 })).toEqual({});
	});

	it("cold only past the lifetime and a minute", () => {
		expect(knownCold({ ttlMs: 300_000, sinceMs: 360_000 })).toBe(false);
		expect(knownCold({ ttlMs: 300_000, sinceMs: 360_001 })).toBe(true);
		expect(knownCold({ sinceMs: 99_999_999 })).toBe(false);
		expect(cacheText({ ttlMs: 300_000, sinceMs: 330_000 })).toBe(
			"Pi knows this cache lasts 5 minutes; last answer 6 minutes ago: it is about to go cold.",
		);
		expect(cacheText({ ttlMs: 3_600_000 })).toBe(
			"Pi knows this cache lasts 1 hour, but has no answer of this session to go by, so it may still be warm.",
		);
	});

	it("a request is noted with its session and the lifetime Pi takes for it; one without caching, or without a session, is not", () => {
		const model = { api: "anthropic-messages", promptCache: { short: 300, long: 3600 } };
		noteCacheUse(model, { sessionId: "s-1" }, 1000);
		noteCacheUse(model, { sessionId: "s-2", cacheRetention: "long" }, 2000);
		noteCacheUse(model, { sessionId: "s-3", cacheRetention: "none" }, 3000);
		noteCacheUse({ api: "anthropic-messages" }, { sessionId: "s-4" }, 4000);
		noteCacheUse(model, {}, 5000);
		expect(lastCacheUse("s-1")).toEqual({ at: 1000, ttlMs: 300_000 });
		expect(lastCacheUse("s-2")).toEqual({ at: 2000, ttlMs: 3_600_000 });
		expect(lastCacheUse("s-3")).toBeUndefined();
		expect(lastCacheUse("s-4")).toEqual({ at: 4000 });
	});
});

describe("/provimux-route: reading the contract", () => {
	it("the gateway's times are its answer's own: the same text whatever this machine's clock says", async () => {
		const before = await runRoute("", { show: [ok(cooling)] });
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2031-03-04T23:59:00Z"));
		const later = await runRoute("", { show: [ok(cooling)] });
		expect(later.notes).toEqual(before.notes);
		expect(PI_NOW).toBe(Date.parse("2026-11-27T10:15:30Z"));
	});

	it("fields and values it does not know are ignored; a kind may be empty; an unlisted route; an old cache object is not read", () => {
		const shown = parseShowAnswer({
			...C.FellBackCacheCold,
			something_new: { a: 1 },
			cache: { lifetime_s: 300, cold: true },
			bound: { ...C.FellBackCacheCold.bound, route: { provider: "claude", kind: "", priority: 5 } },
		});
		expect(shown?.bound?.route).toEqual({ provider: "claude", kind: "", priority: 5 });
		expect(shown).not.toHaveProperty("cache");
		expect(shown?.rule).toEqual({ inEffect: true, coldAfterS: 360 });
		expect(parseShowAnswer(C.BoundToUnlisted)?.bound?.route).toBe("unlisted");
		expect(parseShowAnswer(C.BoundToUnlisted)?.routedModel).toBe("opus");
		expect(parseShowAnswer({ ...C.NotSeen, rule: { in_effect: "maybe" } })?.rule).toEqual({
			inEffect: false,
			coldAfterS: null,
		});
		expect(parseReleaseAnswer({ ...C.Released, extra: true })?.released).toBe(true);
		expect(parseReleaseAnswer({ ...C.Released, was: { listed: false } })?.was).toBe("unlisted");
		expect(parseShowAnswer({ hello: 1 })).toBeUndefined();
	});

	it("a route of an empty kind is named by its service alone", async () => {
		const answer = { ...fb, bound: { ...fb.bound, route: { provider: "claude", kind: "", priority: 5 } } };
		const run = await runRoute("", { show: [ok(answer)] });
		expect(run.notes[0]![0]).toContain("• Now on: Anthropic, since 09:35 (40 minutes ago).");
	});

	it('a small amount reads "less than $0.01", never "about less than" (seen against the real gateway)', () => {
		const text = costText({ tokens: 15, price: { input: 5, cacheRead: 0.5 }, cache: {}, to: [] });
		expect(text).toContain("(about 15 tokens, less than $0.01 at the list price;");
		expect(text).toContain("Staying costs a cached read, less than $0.01 a message");
		expect(text).not.toContain("about less");
	});

	it("lengths of time in words", () => {
		expect([0, 29, 60, 300, 3600, 3900, 7260].map(durationWords)).toEqual([
			"under a minute",
			"under a minute",
			"1 minute",
			"5 minutes",
			"1 hour",
			"1 hour 5 minutes",
			"2 hours 1 minute",
		]);
	});
});
