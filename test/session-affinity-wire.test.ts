/**
 * What pi sends for a Claude-format Provimux model, before and after it names its conversation: the same request
 * through pi's own Anthropic client, once with the model as registered before (the catalog's compat flags alone) and
 * once as registered now (`withSessionAffinity`). The only difference may be `x-session-affinity: <session id>`. A
 * fixture proxy on a loopback port records both; nothing else is reached.
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Api, Model } from "@earendil-works/pi-ai";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANTHROPIC_MESSAGES_API, withSessionAffinity } from "../extensions/lib.ts";

const seen: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
let server: Server;
let origin: string;

const frames = [
	{
		type: "message_start",
		message: {
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: "claude-opus-5-5",
			content: [],
			usage: { input_tokens: 3, output_tokens: 0 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
	{ type: "message_stop" },
];

beforeAll(async () => {
	server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	if (port === 8317 || port === 8787) throw new Error("the fixture got a reserved port");
	origin = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
});

/** A Claude-format Provimux model as the extension registers it, with the catalog's compat flags. */
function claudeModel(): Model<Api> {
	return {
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5 · Anthropic sub",
		api: ANTHROPIC_MESSAGES_API,
		provider: "provimux",
		baseUrl: origin,
		reasoning: true,
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 200_000,
		maxTokens: 32_000,
		compat: { supportsLongCacheRetention: true },
	} as Model<Api>;
}

async function send(model: Model<Api>): Promise<{ headers: IncomingHttpHeaders; body: string }> {
	const before = seen.length;
	const events = anthropicStream(
		model as never,
		normalizeContext({
			systemPrompt: "You are a fixture.",
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
		}),
		{ apiKey: "sk-fixture-client", sessionId: "0c9b1f0e-6a51-4c58-9b1e-2f6f3f1f7a10" },
	);
	for await (const _ of events) {
		// Read to the end.
	}
	expect(seen.length).toBe(before + 1);
	return seen[before]!;
}

describe("a Claude-format model names its conversation", () => {
	it("as registered now: the same request as before, plus x-session-affinity with the session's id", async () => {
		const before = await send(claudeModel());
		const now = await send(withSessionAffinity(claudeModel()));
		const strip = (headers: IncomingHttpHeaders) => {
			const { "x-session-affinity": _, "x-stainless-retry-count": __, ...rest } = headers;
			return rest;
		};
		expect(before.headers).not.toHaveProperty("x-session-affinity");
		expect(now.headers["x-session-affinity"]).toBe("0c9b1f0e-6a51-4c58-9b1e-2f6f3f1f7a10");
		expect(strip(now.headers)).toEqual(strip(before.headers));
		expect(now.body).toBe(before.body);
	});

	it("withSessionAffinity keeps the catalog's flags and adds only the one", () => {
		expect(withSessionAffinity(claudeModel()).compat).toEqual({
			supportsLongCacheRetention: true,
			sendSessionAffinityHeaders: true,
		});
		expect(withSessionAffinity({ id: "m" } as { id: string; compat?: Record<string, unknown> })).toEqual({
			id: "m",
			compat: { sendSessionAffinityHeaders: true },
		});
	});
});
