/**
 * The footer's words for what answered (`answeredStatus`), and its switch. How it follows a real session (overlapping
 * requests, the WebSocket, switching models, a proxy without the headers) is in answered-overlap.test.ts.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { answeredStatus } from "../extensions/answered-footer.ts";
import { resolveAnsweredDefault } from "../extensions/lib.ts";
import { answerLabel, sourceLabel } from "../extensions/sources.ts";

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
