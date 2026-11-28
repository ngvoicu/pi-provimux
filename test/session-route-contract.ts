/**
 * Answers of Provimux's session-route contract, in the shapes the gateway sends: one example of each, the others as
 * small changes to it.
 */

const SUB = { provider: "claude", kind: "oauth", priority: 10, account: "a.b2hw7ynq4rkx6mdz3tcv" };
const API = {
	provider: "claude",
	kind: "apikey",
	priority: 5,
	host: "api.anthropic.com",
	account: "a.f6zq3m2hx7kd4vwn5tyb",
};
const RULE_OFF = { in_effect: false, cold_after_s: null };

/** Fell back to a paid key 40 minutes ago; the first route is free again. */
export const FellBack = {
	observed_at: "2026-11-27T10:15:00Z",
	affinity: "on",
	conversation: "bound",
	model: "opus",
	routed_model: null,
	binding: "b.k3v7q2mfx4ardn5w",
	bound: {
		route: API,
		since: "2026-11-27T09:35:12Z",
		origin: "fallback",
		fell_back_from: SUB,
		fell_back_at: "2026-11-27T09:35:12Z",
	},
	position: { below_first: true, higher_priority_free: true, higher_priority_free_at: null },
	first: [SUB],
	rule: RULE_OFF,
	websocket_may_hold: false,
	subagent: false,
};

/** The same, the first route still cooling: a higher-priority route is expected free at 10:40. */
export const Cooling = {
	...FellBack,
	position: { below_first: true, higher_priority_free: false, higher_priority_free_at: "2026-11-27T10:40:00Z" },
	first: [API],
};

/** Bound to an account the list no longer shows (disabled since); asked as auto. */
export const BoundToUnlisted = {
	...FellBack,
	model: "auto",
	routed_model: "opus",
	binding: "b.p4nq7tz2wk5xmh3d",
	bound: {
		route: { listed: false },
		since: "2026-11-27T09:02:44Z",
		origin: "first",
		fell_back_from: null,
		fell_back_at: null,
	},
	position: null,
	first: [API],
};

/** On a first route; two accounts of the top priority are available. */
export const OnFirstRoute = {
	...FellBack,
	binding: "b.w6n2tq5hz3xkm7vd",
	bound: { route: SUB, since: "2026-11-27T09:02:44Z", origin: "first", fell_back_from: null, fell_back_at: null },
	position: { below_first: false, higher_priority_free: false, higher_priority_free_at: null },
	first: [SUB, { ...SUB, account: "a.q5tm3xw7n2hkz4vd6byc" }],
};

/** Another key's conversation, one that does not exist, or one whose binding was forgotten. */
export const NotSeen = {
	...FellBack,
	conversation: "not-seen",
	binding: null,
	bound: null,
	position: null,
	first: [],
};

/** routing.session-affinity is false. */
export const AffinityOff = { ...NotSeen, affinity: "off", conversation: "not-bound" };

export const Released = {
	observed_at: "2026-11-27T10:15:02Z",
	affinity: "on",
	released: true,
	conversation: "not-bound",
	model: "opus",
	routed_model: null,
	was: API,
	next: [SUB],
	websocket_may_hold: false,
};

export const NothingBound = { ...Released, released: false, was: null, next: [] };
