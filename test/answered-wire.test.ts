/**
 * What answered, over the wire: pi's own transports (Claude Messages over SSE; the Codex format over SSE and over the
 * WebSocket, through this package's patched module) against a fixture proxy, with the announcer's handlers wired the
 * way pi wires them (`onResponse` → `after_provider_response`, `onProviderStreamEvent` → `provider_stream_event`).
 *
 * Three kinds of answer:
 * - named: Provimux names the credential (`X-CPA-AUTH-*` headers; `cpa_auth_*` on the WebSocket's response.created);
 * - named nobody: Provimux withdrew the name (plugin code took part in the bytes), so the three are absent;
 * - plain CLIProxyAPI, which never sends them.
 * The last two look the same on the wire, and the extension says nothing for either.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	CLIPROXYAPI_CODEX_API,
	type CliproxyCodexStreams,
	loadCliproxyCodexStreams,
} from "../extensions/codex-stream.ts";
import { ANSWERED_EVENT, type ModelAccounts, REQUEST_EVENT, UpstreamsAnnouncer } from "../extensions/upstreams.ts";

type Naming = "named" | "nobody" | "plain";

/** What the fixture proxy says about the answer, per request. */
let naming: Naming = "named";
/** Whether the fixture proxy finished the answer it is writing. */
let answerEnded = true;
/** Which way each answer went: "sse" or "ws". */
const served: string[] = [];
const NAMED_HEADERS = {
	"X-CPA-AUTH-KIND": "oauth",
	"X-CPA-AUTH-PROVIDER": "claude",
};
const CODEX_NAMED_HEADERS = { "X-CPA-AUTH-KIND": "oauth", "X-CPA-AUTH-PROVIDER": "codex" };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const anthropicFrames = [
	{
		type: "message_start",
		message: {
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: "claude-opus-5-5",
			content: [],
			stop_reason: null,
			usage: { input_tokens: 3, output_tokens: 0 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
	{ type: "message_stop" },
];

function codexFrames(created: Record<string, unknown> = {}) {
	const item = { type: "message", id: "msg_1", role: "assistant", status: "completed" };
	return [
		{ type: "response.created", response: { id: "resp_1", status: "in_progress" }, ...created },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
		{
			type: "response.content_part.added",
			item_id: "msg_1",
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "" },
		},
		{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "hi" },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: { ...item, content: [{ type: "output_text", text: "hi", annotations: [] }] },
		},
		{
			type: "response.completed",
			response: {
				id: "resp_1",
				status: "completed",
				usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
}

/** Writes an SSE answer: the headers and first frame, a pause (the request is out), then the rest. */
async function writeSse(res: ServerResponse, headers: Record<string, string>, frames: Array<{ type: string }>) {
	answerEnded = false;
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...headers });
	const [first, ...rest] = frames;
	res.write(`event: ${first!.type}\ndata: ${JSON.stringify(first)}\n\n`);
	await pause(40);
	for (const frame of rest) res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
	answerEnded = true;
	res.end();
}

function route(req: IncomingMessage, res: ServerResponse) {
	req.resume();
	req.on("end", () => {
		served.push("sse");
		const named = naming === "named";
		if (req.url?.includes("/messages")) void writeSse(res, named ? NAMED_HEADERS : {}, anthropicFrames);
		else if (req.url?.includes("/responses")) void writeSse(res, named ? CODEX_NAMED_HEADERS : {}, codexFrames());
		else {
			res.writeHead(404);
			res.end();
		}
	});
}

/** A minimal WebSocket server side (RFC 6455): text messages in, text messages out, close and ping answered. */
function acceptWebSocket(req: IncomingMessage, socket: Socket, onMessage: (send: (text: string) => void) => void) {
	const accept = createHash("sha1")
		.update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
		.digest("base64");
	socket.write(
		`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
	);
	const frame = (opcode: number, payload: Buffer) => {
		const length = payload.length;
		const head =
			length < 126
				? Buffer.from([0x80 | opcode, length])
				: Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]);
		if (!socket.destroyed) socket.write(Buffer.concat([head, payload]));
	};
	const send = (text: string) => frame(0x1, Buffer.from(text));
	let buffered = Buffer.alloc(0);
	socket.on("data", (chunk: Buffer) => {
		buffered = Buffer.concat([buffered, chunk]);
		while (buffered.length >= 2) {
			const opcode = buffered[0]! & 0x0f;
			let length = buffered[1]! & 0x7f;
			let offset = 2;
			if (length === 126) {
				length = buffered.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				length = Number(buffered.readBigUInt64BE(2));
				offset = 10;
			}
			if (buffered.length < offset + 4 + length) return;
			const mask = buffered.subarray(offset, offset + 4);
			const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
			for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
			buffered = buffered.subarray(offset + 4 + length);
			if (opcode === 0x1) onMessage(send);
			else if (opcode === 0x9) frame(0xa, payload);
			else if (opcode === 0x8) {
				frame(0x8, Buffer.alloc(0));
				socket.end();
			}
		}
	});
	socket.on("error", () => {});
}

let server: Server;
let baseUrl: string;
let codex: CliproxyCodexStreams;

beforeAll(async () => {
	server = createServer(route);
	// The Codex WebSocket: no headers per turn; the name, when given, is on response.created.
	server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
		acceptWebSocket(req, socket, async (send) => {
			served.push("ws");
			answerEnded = false;
			const created = naming === "named" ? { cpa_auth_kind: "oauth", cpa_auth_provider: "codex" } : {};
			const [first, ...rest] = codexFrames(created);
			send(JSON.stringify(first));
			await pause(40);
			for (const frame of rest) send(JSON.stringify(frame));
			answerEnded = true;
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	codex = await loadCliproxyCodexStreams(["cliproxyapi"]);
});

afterAll(async () => {
	codex?.closeOpenAICodexWebSocketSessions();
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
});

/** The announcer with pi's wiring, an extension (pi-cache-keeper) having asked; what it said, and when. */
async function announcer() {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const listeners = new Map<string, (data: unknown) => void>();
	const said: Array<{ channel: string; data: unknown; answerEnded: boolean }> = [];
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
		events: {
			emit: (channel: string, data: unknown) => said.push({ channel, data, answerEnded }),
			on: (channel: string, handler: (data: unknown) => void) => {
				listeners.set(channel, handler);
				return () => {};
			},
		},
	} as unknown as ExtensionAPI;
	const list: ModelAccounts = {
		owners: { "claude-opus-5-5": "anthropic", "gpt-6.1-sol": "openai" },
		accounts: {
			"claude-opus-5-5": [{ provider: "claude", kind: "oauth", priority: 0 }],
			"gpt-6.1-sol": [{ provider: "codex", kind: "oauth", priority: 0 }],
		},
	};
	const upstreams = new UpstreamsAnnouncer(
		pi,
		"cliproxyapi",
		() => ({ baseUrlInput: baseUrl, apiKey: "k" }),
		async () => list,
	);
	upstreams.register();
	listeners.get(REQUEST_EVENT)!({});
	await upstreams.announce();
	said.length = 0;
	// As pi's SDK does: the response's headers before its stream is read, then each parsed stream event.
	const wiring: SimpleStreamOptions = {
		apiKey: "sk-test",
		onResponse: async (response, model) => {
			await handlers.get("after_provider_response")!(
				{ type: "after_provider_response", status: response.status, headers: response.headers },
				{ model },
			);
		},
		onProviderStreamEvent: async (data, model) => {
			await handlers.get("provider_stream_event")!(
				{ type: "provider_stream_event", data, provider: model.provider, api: model.api, model: model.id },
				{},
			);
		},
	};
	return { said, wiring };
}

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
function model(id: string, api: Api, suffix = ""): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider: "cliproxyapi",
		baseUrl: `${baseUrl}${suffix}`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 1000,
	} as Model<Api>;
}

/** Runs one request to the end; the stream's own end is "done" or "error". */
async function run(events: AsyncIterable<AssistantMessageEvent>) {
	const types: string[] = [];
	for await (const event of events) types.push(event.type);
	return types;
}

const claudeLogin = {
	channel: ANSWERED_EVENT,
	data: {
		provider: "cliproxyapi",
		model: "claude-opus-5-5",
		upstreams: [{ provider: "anthropic", subscription: true }],
	},
	answerEnded: false,
};
const codexLogin = {
	channel: ANSWERED_EVENT,
	data: {
		provider: "cliproxyapi",
		model: "gpt-6.1-sol",
		upstreams: [{ provider: "openai-codex", subscription: true }],
	},
	answerEnded: false,
};

describe("what answered, over the wire", () => {
	const transports = [
		{
			name: "Claude Messages over SSE (headers)",
			way: "sse",
			expected: claudeLogin,
			send: (wiring: SimpleStreamOptions) =>
				anthropicStream(
					model("claude-opus-5-5", "anthropic-messages") as Model<"anthropic-messages">,
					normalizeContext(context),
					wiring,
				),
		},
		{
			name: "the Codex format over SSE (headers)",
			way: "sse",
			expected: codexLogin,
			send: (wiring: SimpleStreamOptions) =>
				codex.streamSimple(model("gpt-6.1-sol", CLIPROXYAPI_CODEX_API, "/v1"), context, {
					...wiring,
					transport: "sse",
				} as SimpleStreamOptions),
		},
		{
			name: "the Codex WebSocket (response.created)",
			way: "ws",
			expected: codexLogin,
			send: (wiring: SimpleStreamOptions) =>
				codex.streamSimple(model("gpt-6.1-sol", CLIPROXYAPI_CODEX_API, "/v1"), context, {
					...wiring,
					transport: "websocket",
					sessionId: `ws-${Math.random()}`,
				} as SimpleStreamOptions),
		},
	];

	for (const transport of transports) {
		it(`${transport.name}: named, the credential is told while the request is out; named nobody or plain CLIProxyAPI, nothing`, async () => {
			const { said, wiring } = await announcer();
			const told: unknown[][] = [];
			served.length = 0;
			for (const each of ["named", "nobody", "named", "plain"] as Naming[]) {
				naming = each;
				const ends = await run(transport.send(wiring));
				expect(ends.at(-1)).toBe("done");
				told.push(said.splice(0));
			}
			expect(told).toEqual([
				// Named: one report, sent before the fixture proxy finished writing the answer.
				[transport.expected],
				// Named nobody (plugin code took part): no report for this answer, which pi-cache-keeper reads as a change
				// of route, so it does not keep the values of the last named credential.
				[],
				[transport.expected],
				// Plain CLIProxyAPI: none of the three, quiet as before.
				[],
			]);
			expect(served).toEqual([transport.way, transport.way, transport.way, transport.way]);
		});
	}
});
