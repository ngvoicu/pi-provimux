/**
 * The examples of Provimux's session-route contract (`.github/provimux/design/session-route/openapi.yaml`), copied
 * as they are. The tests' stand-in for the two paths answers with these, or with one of them changed in one field.
 */

/** FellBackCacheCold: Fell back to a paid key 40 minutes ago, the first route is free (rule as with the rule, not in this release). */
export const FellBackCacheCold = {
	observed_at: "2026-11-27T10:15:00Z",
	affinity: "on",
	conversation: "bound",
	model: "opus",
	routed_model: null,
	binding: "b.k3v7q2mfx4ardn5w",
	bound: {
		route: {
			provider: "claude",
			kind: "apikey",
			priority: 5,
			host: "api.anthropic.com",
			account: "a.f6zq3m2hx7kd4vwn5tyb",
		},
		since: "2026-11-27T09:35:12Z",
		origin: "fallback",
		fell_back_from: {
			provider: "claude",
			kind: "oauth",
			priority: 10,
			account: "a.b2hw7ynq4rkx6mdz3tcv",
		},
		fell_back_at: "2026-11-27T09:35:12Z",
	},
	position: {
		below_first: true,
		higher_priority_free: true,
		higher_priority_free_at: null,
	},
	first: [
		{
			provider: "claude",
			kind: "oauth",
			priority: 10,
			account: "a.b2hw7ynq4rkx6mdz3tcv",
		},
	],
	rule: {
		in_effect: true,
		cold_after_s: 360,
	},
	websocket_may_hold: false,
	subagent: false,
};

/** FellBackFirstRouteCooling: Fell back to a paid key; the first route is still cooling and is expected free at 10:40. */
export const FellBackFirstRouteCooling = {
	observed_at: "2026-11-27T10:15:00Z",
	affinity: "on",
	conversation: "bound",
	model: "opus",
	routed_model: null,
	binding: "b.k3v7q2mfx4ardn5w",
	bound: {
		route: {
			provider: "claude",
			kind: "apikey",
			priority: 5,
			host: "api.anthropic.com",
			account: "a.f6zq3m2hx7kd4vwn5tyb",
		},
		since: "2026-11-27T09:35:12Z",
		origin: "fallback",
		fell_back_from: {
			provider: "claude",
			kind: "oauth",
			priority: 10,
			account: "a.b2hw7ynq4rkx6mdz3tcv",
		},
		fell_back_at: "2026-11-27T09:35:12Z",
	},
	position: {
		below_first: true,
		higher_priority_free: false,
		higher_priority_free_at: "2026-11-27T10:40:00Z",
	},
	first: [
		{
			provider: "claude",
			kind: "apikey",
			priority: 5,
			host: "api.anthropic.com",
			account: "a.f6zq3m2hx7kd4vwn5tyb",
		},
	],
	rule: {
		in_effect: false,
		cold_after_s: null,
	},
	websocket_may_hold: false,
	subagent: false,
};

/** BoundToUnlisted: Bound to an account the list no longer shows (disabled since); asked as auto. */
export const BoundToUnlisted = {
	observed_at: "2026-11-27T10:15:00Z",
	affinity: "on",
	conversation: "bound",
	model: "auto",
	routed_model: "opus",
	binding: "b.p4nq7tz2wk5xmh3d",
	bound: {
		route: {
			listed: false,
		},
		since: "2026-11-27T09:02:44Z",
		origin: "first",
		fell_back_from: null,
		fell_back_at: null,
	},
	position: null,
	first: [
		{
			provider: "claude",
			kind: "apikey",
			priority: 5,
			host: "api.anthropic.com",
			account: "a.f6zq3m2hx7kd4vwn5tyb",
		},
	],
	rule: {
		in_effect: false,
		cold_after_s: null,
	},
	websocket_may_hold: false,
	subagent: false,
};

/** OnFirstRoute: On a first route; two accounts share the top priority (rule as with the rule, not in this release). */
export const OnFirstRoute = {
	observed_at: "2026-11-27T10:15:00Z",
	affinity: "on",
	conversation: "bound",
	model: "opus",
	routed_model: null,
	binding: "b.w6n2tq5hz3xkm7vd",
	bound: {
		route: {
			provider: "claude",
			kind: "oauth",
			priority: 10,
			account: "a.b2hw7ynq4rkx6mdz3tcv",
		},
		since: "2026-11-27T09:02:44Z",
		origin: "first",
		fell_back_from: null,
		fell_back_at: null,
	},
	position: {
		below_first: false,
		higher_priority_free: false,
		higher_priority_free_at: null,
	},
	first: [
		{
			provider: "claude",
			kind: "oauth",
			priority: 10,
			account: "a.b2hw7ynq4rkx6mdz3tcv",
		},
		{
			provider: "claude",
			kind: "oauth",
			priority: 10,
			account: "a.q5tm3xw7n2hkz4vd6byc",
		},
	],
	rule: {
		in_effect: true,
		cold_after_s: 360,
	},
	websocket_may_hold: false,
	subagent: false,
};

/** NotSeen: Another key's conversation, one that does not exist, or the first minutes after a restart. */
export const NotSeen = {
	observed_at: "2026-11-27T10:15:00Z",
	affinity: "on",
	conversation: "not-seen",
	model: "opus",
	routed_model: null,
	binding: null,
	bound: null,
	position: null,
	first: [],
	rule: {
		in_effect: true,
		cold_after_s: 360,
	},
	websocket_may_hold: false,
	subagent: false,
};

/** AffinityOff: routing.session-affinity is false. */
export const AffinityOff = {
	observed_at: "2026-11-27T10:15:00Z",
	affinity: "off",
	conversation: "not-bound",
	model: "opus",
	routed_model: null,
	binding: null,
	bound: null,
	position: null,
	first: [],
	rule: {
		in_effect: false,
		cold_after_s: null,
	},
	websocket_may_hold: false,
	subagent: false,
};

/** Released. */
export const Released = {
	observed_at: "2026-11-27T10:15:02Z",
	affinity: "on",
	released: true,
	conversation: "not-bound",
	model: "opus",
	routed_model: null,
	was: {
		provider: "claude",
		kind: "apikey",
		priority: 5,
		host: "api.anthropic.com",
		account: "a.f6zq3m2hx7kd4vwn5tyb",
	},
	next: [
		{
			provider: "claude",
			kind: "oauth",
			priority: 10,
			account: "a.b2hw7ynq4rkx6mdz3tcv",
		},
	],
	websocket_may_hold: false,
};

/** NothingBound. */
export const NothingBound = {
	observed_at: "2026-11-27T10:15:02Z",
	affinity: "on",
	released: false,
	conversation: "not-bound",
	model: "opus",
	routed_model: null,
	was: null,
	next: [],
	websocket_may_hold: false,
};

/** ReleaseNotSeen: Another key's conversation, one that does not exist, or the first minutes after a restart. */
export const ReleaseNotSeen = {
	observed_at: "2026-11-27T10:15:02Z",
	affinity: "on",
	released: false,
	conversation: "not-seen",
	model: "opus",
	routed_model: null,
	was: null,
	next: [],
	websocket_may_hold: false,
};

/** ReleaseAffinityOff: routing.session-affinity is false; nothing is ever bound. */
export const ReleaseAffinityOff = {
	observed_at: "2026-11-27T10:15:02Z",
	affinity: "off",
	released: false,
	conversation: "not-bound",
	model: "opus",
	routed_model: null,
	was: null,
	next: [],
	websocket_may_hold: false,
};
