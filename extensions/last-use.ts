/**
 * When this Pi last used a session's prompt cache, and how long Pi takes that cache to live: what `/provimux-route`
 * needs to say whether a release costs a read without cache. The gateway states no cache's lifetime.
 *
 * Every request of a Provimux model passes through this package's stream wrappers (the Codex stream, and pi-ai's own
 * Claude Messages implementation, wrapped in upstreams.ts): the session's turns, Pi's cache warmer and another
 * extension's keep-warm request alike, each with the session id it was sent under. A request sent without caching
 * (`cacheRetention: "none"`, as Pi's compaction summaries are) touches no cache and is not noted. The lifetime is the
 * one Pi's own cache warmer uses: the model's `promptCache` value for the request's retention tier
 * (`getPromptCacheTtlMs`), which pi-cache-keeper fills from providers.dev where it is installed; undefined when Pi has
 * none. Kept per process: after a restart, the session's last answer stands in (route.ts).
 */
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getPromptCacheTtlMs } from "@earendil-works/pi-ai";

export interface CacheUse {
	/** When the request was sent (ms since the epoch): the vendor reads and writes the cache as it starts. */
	at: number;
	/** How long Pi takes the cache that request wrote to live, in ms; undefined when Pi does not know. */
	ttlMs?: number;
}

const KEY = Symbol.for("pi-provimux.last-cache-use.v1");
const LIMIT = 256;

/** One table per process, however many copies of the extension are loaded. */
function table(): Map<string, CacheUse> {
	const global = globalThis as { [KEY]?: Map<string, CacheUse> };
	global[KEY] ??= new Map();
	return global[KEY];
}

/** Notes a request as it is sent. Nothing without a session id, or without caching. */
export function noteCacheUse(model: unknown, options: unknown, now = Date.now()): void {
	const sent = options as (SimpleStreamOptions & { sessionId?: string }) | undefined;
	const sessionId = typeof sent?.sessionId === "string" ? sent.sessionId : "";
	if (!sessionId || sent?.cacheRetention === "none") return;
	let ttlMs: number | undefined;
	try {
		ttlMs = getPromptCacheTtlMs(model as Model<Api>, sent);
	} catch {
		ttlMs = undefined;
	}
	const uses = table();
	uses.delete(sessionId);
	uses.set(sessionId, { at: now, ...(ttlMs !== undefined ? { ttlMs } : {}) });
	while (uses.size > LIMIT) uses.delete(uses.keys().next().value as string);
}

/** The last request noted for a session in this process. */
export function lastCacheUse(sessionId: string): CacheUse | undefined {
	return table().get(sessionId);
}

/** For tests: forget every session. */
export function forgetCacheUses(): void {
	table().clear();
}
