/**
 * The footer's words for what answered (`answeredStatus`), and its switch. How it follows a real session (overlapping
 * requests, the WebSocket, switching models, a proxy without the headers) is in answered-overlap.test.ts.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { answeredStatus, isAnswer } from "../extensions/answered-footer.ts";
import { resolveAnsweredDefault } from "../extensions/lib.ts";
import { answerLabel, sourceLabel } from "../extensions/sources.ts";
import { type AnswerCallbacks, answeredStream, answerOf } from "../extensions/upstreams.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the footer's words for what answered", () => {
	it("the owner's four routes", () => {
		const named = (provider: string, kind: string, host?: string) => answeredStatus({ provider, kind, host }, false);
		expect(named("claude", "oauth")).toBe("answered: Anthropic sub");
		expect(named("devin", "oauth")).toBe("answered: Devin sub");
		expect(named("claude", "apikey", "api.anthropic.com")).toBe("answered: Anthropic api");
		expect(named("openai-compatible-openrouter", "apikey", "openrouter.ai")).toBe("answered: OpenRouter api");
	});

	it("the same words as the model names (sourceLabel), whatever the letter case", () => {
		const cases = [
			{ provider: "claude", kind: "oauth" },
			{ provider: "claude", kind: "apikey" },
			{ provider: "codex", kind: "oauth" },
			{ provider: "codex", kind: "apikey", host: "api.openai.com" },
			{ provider: "antigravity", kind: "oauth" },
			{ provider: "openai-compatible-openrouter", kind: "apikey" },
			{ provider: "openai-compatible-acme", kind: "apikey", host: "api.acme.test" },
			{ provider: "kimi", kind: "oauth" },
		];
		for (const credential of cases)
			expect(answerLabel(credential)).toBe(sourceLabel([{ ...credential, priority: 0 }]));
		expect(answeredStatus({ provider: "Claude", kind: "OAuth", host: undefined }, false)).toBe(
			"answered: Anthropic sub",
		);
		expect(answeredStatus({ provider: "openai-compatible-x", kind: "apikey", host: "OpenRouter.AI" }, false)).toBe(
			"answered: OpenRouter api",
		);
	});

	it("names nobody: unknown from a proxy that names answers, nothing from one that names none", () => {
		const nobody = { kind: undefined, provider: undefined, host: undefined };
		expect(answeredStatus(nobody, true)).toBe("answered: unknown");
		expect(answeredStatus(nobody, false)).toBeUndefined();
		expect(answeredStatus({ kind: "  ", provider: "claude", host: undefined }, false)).toBeUndefined();
		expect(answeredStatus({ kind: "magic", provider: "claude", host: undefined }, true)).toBe("answered: unknown");
	});

	it("only the kind (an older Provimux): unknown", () => {
		expect(answeredStatus({ kind: "oauth", provider: undefined, host: undefined }, false)).toBe("answered: unknown");
		expect(answeredStatus({ kind: "apikey", provider: 42, host: undefined }, false)).toBe("answered: unknown");
	});
});

describe("an answer the user sees", () => {
	const text = (value: string) => ({ type: "text", text: value });
	it("completed or calling tools, with something in it", () => {
		expect(isAnswer({ stopReason: "stop", content: [text("ok")] })).toBe(true);
		expect(
			isAnswer({ stopReason: "toolUse", content: [{ type: "toolCall", id: "1", name: "x", arguments: {} }] }),
		).toBe(true);
		expect(isAnswer({ stopReason: "stop", content: [{ type: "thinking", thinking: "hm" }] })).toBe(true);
	});
	it("not: failed, aborted, cut short, or empty", () => {
		for (const stopReason of ["error", "aborted", "length", undefined])
			expect(isAnswer({ stopReason, content: [text("ok")] })).toBe(false);
		expect(isAnswer({ stopReason: "stop", content: [] })).toBe(false);
		expect(isAnswer({ stopReason: "stop", content: [text("  "), { type: "thinking", thinking: "" }] })).toBe(false);
		expect(isAnswer({ stopReason: "stop" })).toBe(false);
	});
});

describe("what answered, carried by the message", () => {
	/** One request through `answeredStream`: `events` play the provider's part; resolves with its message. */
	type Callbacks = Required<AnswerCallbacks<unknown>>;
	async function request(events: (options: Callbacks) => void) {
		const message = { role: "assistant", content: [] };
		const stream = answeredStream((_model: unknown, _context: unknown, options: Callbacks) => {
			events(options);
			return { result: () => Promise.resolve(message) };
		});
		await stream({}, {}, { onResponse: () => {}, onProviderStreamEvent: () => {} }).result();
		await Promise.resolve();
		return message;
	}

	it("a shallow copy of the message still says it; the session file does not", async () => {
		const message = await request((options) => {
			options.onResponse(
				{ status: 200, headers: { "X-CPA-AUTH-KIND": "oauth", "X-CPA-AUTH-PROVIDER": "devin" } },
				{},
			);
			options.onProviderStreamEvent({ type: "message_start" }, {});
		});
		const said = { kind: "oauth", provider: "devin", host: undefined };
		expect(answerOf(message)).toEqual(said);
		expect(answerOf({ ...message })).toEqual(said);
		expect(answerOf(JSON.parse(JSON.stringify(message)))).toBeUndefined();
		expect(answerOf({ role: "assistant" })).toBeUndefined();
	});

	it("a retried request: the last response's headers", async () => {
		const message = await request((options) => {
			options.onResponse(
				{ status: 429, headers: { "X-CPA-AUTH-KIND": "oauth", "X-CPA-AUTH-PROVIDER": "devin" } },
				{},
			);
			const named = {
				"x-cpa-auth-kind": "apikey",
				"x-cpa-auth-provider": "claude",
				"x-cpa-auth-host": "api.anthropic.com",
			};
			options.onResponse({ status: 200, headers: named }, {});
			options.onProviderStreamEvent({ type: "message_start" }, {});
		});
		expect(answerOf(message)).toEqual({ kind: "apikey", provider: "claude", host: "api.anthropic.com" });
	});

	it("a WebSocket replay: the last response.created's fields", async () => {
		const message = await request((options) => {
			options.onProviderStreamEvent(
				{ type: "response.created", cpa_auth_kind: "oauth", cpa_auth_provider: "devin" },
				{},
			);
			options.onProviderStreamEvent({ type: "response.failed" }, {});
			options.onProviderStreamEvent(
				{
					type: "response.created",
					cpa_auth_kind: "apikey",
					cpa_auth_provider: "openai-compatible-openrouter",
					cpa_auth_host: "openrouter.ai",
				},
				{},
			);
		});
		expect(answerOf(message)).toEqual({
			kind: "apikey",
			provider: "openai-compatible-openrouter",
			host: "openrouter.ai",
		});
	});
});

describe("answered setting", () => {
	it("defaults to on and honours a persisted boolean", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-provimux-answered-"));
		tempDirs.push(agentDir);
		expect(resolveAnsweredDefault(agentDir)).toBe(true);
		writeFileSync(join(agentDir, "cliproxyapi.json"), '{"answered":false}\n', "utf8");
		expect(resolveAnsweredDefault(agentDir)).toBe(false);
		writeFileSync(join(agentDir, "cliproxyapi.json"), '{"answered":true}\n', "utf8");
		expect(resolveAnsweredDefault(agentDir)).toBe(true);
		writeFileSync(join(agentDir, "cliproxyapi.json"), '{"answered":"no"}\n', "utf8");
		expect(() => resolveAnsweredDefault(agentDir)).toThrow(/"answered" must be a boolean/);
	});
});
