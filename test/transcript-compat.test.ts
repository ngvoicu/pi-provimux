import type { Context, Tool } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ensureTranscriptContext } from "../extensions/codex-stream.ts";

describe("ensureTranscriptContext", () => {
	it("leaves transcript context with system message untouched", () => {
		const transcriptContext = {
			messages: [
				{
					role: "system",
					content: "Preamble",
					toolsAdded: [{ name: "bash", description: "Run bash", parameters: {} }],
				},
				{ role: "user", content: "Hello", timestamp: 1000 },
			],
		};

		const result = ensureTranscriptContext(transcriptContext);
		expect(result).toBe(transcriptContext);
		expect(result.messages).toHaveLength(2);
		expect((result.messages[0] as { toolsAdded?: unknown[] }).toolsAdded).toHaveLength(1);
	});

	it("converts classic context into transcript context by prepending a system message", () => {
		const classicContext: Context = {
			systemPrompt: "Classic instructions",
			tools: [
				{
					name: "read",
					description: "Read file",
					parameters: { type: "object", properties: {} },
				} as Tool,
			],
			messages: [{ role: "user", content: "Hello world", timestamp: 1000 }],
		};

		const result = ensureTranscriptContext(classicContext);
		expect(result.messages).toHaveLength(2);
		const firstMsg = result.messages[0] as { role: string; content: string; toolsAdded?: Tool[] };
		expect(firstMsg.role).toBe("system");
		expect(firstMsg.content).toBe("Classic instructions");
		expect(firstMsg.toolsAdded).toHaveLength(1);
		expect(firstMsg.toolsAdded?.[0]?.name).toBe("read");
		expect(result.messages[1]).toEqual({ role: "user", content: "Hello world", timestamp: 1000 });
	});

	it("leaves empty context untouched", () => {
		expect(ensureTranscriptContext({} as Context)).toEqual({});
		expect(ensureTranscriptContext({ messages: [] } as unknown as Context)).toEqual({ messages: [] });
	});
});
