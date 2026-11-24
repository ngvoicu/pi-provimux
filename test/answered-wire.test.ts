/**
 * What answered, over the wire: pi's own transports (Claude Messages over SSE; the Codex format over SSE and over the
 * WebSocket, through this package's patched module) against a fixture proxy, with the announcer's handlers wired the
 * way pi wires them (`onResponse` → `after_provider_response`, `onProviderStreamEvent` → `provider_stream_event`),
 * each request with its own callbacks over those, as the provider's stream gives them.
 *
 * Three kinds of answer:
 * - named: Provimux names the credential (`X-CPA-AUTH-*` headers; `cpa_auth_*` on the WebSocket's response.created);
 * - named nobody: Provimux withdrew the name (plugin code took part in the bytes), so the three are absent;
 * - plain CLIProxyAPI, which never sends them.
 * The last two look the same on the wire. The extension tells them apart by the proxy: Provimux lists its credentials,
 * so its unnamed answer is reported as `upstreams: []`; plain CLIProxyAPI's is not reported.
 *
 * The Codex format's SSE body carries an inner gateway's `cpa_auth_*` fields on its response.created, named or not:
 * Provimux passes them through on SSE, and only its headers count there.
 *
 * pi's context names the session's selection, here a virtual model of another provider: the model reported is the
 * request's.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadProvimuxCodexStreams, PROVIMUX_CODEX_API, type ProvimuxCodexStreams } from "../extensions/codex-stream.ts";
import {
	ANSWERED_EVENT,
	answeredOptions,
	answeredStream,
	type ModelAccounts,
	REQUEST_EVENT,
	UpstreamsAnnouncer,
} from "../extensions/upstreams.ts";
import { acceptWebSocket } from "./websocket-fixture.ts";

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
/** What an inner gateway says on its own response.created, passed through in an SSE body. */
const INNER_GATEWAY = {
	cpa_auth_kind: "apikey",
	cpa_auth_provider: "openai-compatible-inner",
	cpa_auth_host: "inner.test",
};
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
		else if (req.url?.includes("/responses"))
			void writeSse(res, named ? CODEX_NAMED_HEADERS : {}, codexFrames(INNER_GATEWAY));
		else {
			res.writeHead(404);
			res.end();
		}
	});
}

let server: Server;
let baseUrl: string;
let codex: ProvimuxCodexStreams;

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
	codex = await loadProvimuxCodexStreams(["provimux"]);
});

afterAll(async () => {
	codex?.closeOpenAICodexWebSocketSessions();
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
});

/** The session's selection: a virtual model of another provider, which routes to the models sent here. */
const selection = { provider: "router", id: "virtual" };

/**
 * The announcer with pi's wiring, an extension (pi-cache-keeper) having asked; what it said, and when. `lists`: the
 * proxy lists its credentials (Provimux), else not (plain CLIProxyAPI).
 */
async function announcer(lists: boolean) {
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
		accounts: lists
			? {
					"claude-opus-5-5": [{ provider: "claude", kind: "oauth", priority: 0 }],
					"gpt-6.1-sol": [{ provider: "codex", kind: "oauth", priority: 0 }],
				}
			: {},
	};
	const upstreams = new UpstreamsAnnouncer(
		pi,
		"provimux",
		() => ({ baseUrlInput: baseUrl, apiKey: "k" }),
		async () => list,
	);
	upstreams.register();
	listeners.get(REQUEST_EVENT)!({});
	await upstreams.announce();
	said.length = 0;
	// As pi's SDK does: the payload before it is sent, the response's headers before its stream is read (without the
	// request's model: the context has the session's selection), then each parsed stream event with the model sent.
	const ctx = { model: selection };
	const wiring: SimpleStreamOptions = {
		apiKey: "sk-test",
		onPayload: async (payload) => {
			await handlers.get("before_provider_request")?.({ type: "before_provider_request", payload }, ctx);
			return undefined;
		},
		onResponse: async (response) => {
			await handlers.get("after_provider_response")?.(
				{ type: "after_provider_response", status: response.status, headers: response.headers },
				ctx,
			);
		},
		onProviderStreamEvent: async (data, model) => {
			await handlers.get("provider_stream_event")!(
				{ type: "provider_stream_event", data, provider: model.provider, api: model.api, model: model.id },
				ctx,
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
		provider: "provimux",
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
		provider: "provimux",
		model: "claude-opus-5-5",
		upstreams: [{ provider: "anthropic", subscription: true }],
	},
	answerEnded: false,
};
const codexLogin = {
	channel: ANSWERED_EVENT,
	data: {
		provider: "provimux",
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
					answeredOptions(wiring),
				),
		},
		{
			name: "the Codex format over SSE (headers)",
			way: "sse",
			expected: codexLogin,
			send: (wiring: SimpleStreamOptions) =>
				answeredStream(codex.streamSimple)(model("gpt-6.1-sol", PROVIMUX_CODEX_API, "/v1"), context, {
					...wiring,
					transport: "sse",
				} as SimpleStreamOptions),
		},
		{
			name: "the Codex WebSocket (response.created)",
			way: "ws",
			expected: codexLogin,
			send: (wiring: SimpleStreamOptions) =>
				answeredStream(codex.streamSimple)(model("gpt-6.1-sol", PROVIMUX_CODEX_API, "/v1"), context, {
					...wiring,
					transport: "websocket",
					sessionId: `ws-${Math.random()}`,
				} as SimpleStreamOptions),
		},
	];

	for (const transport of transports) {
		const unnamed = { ...transport.expected, data: { ...transport.expected.data, upstreams: [] } };
		it(`${transport.name}: once per answer while it is out; named nobody, []; plain CLIProxyAPI, nothing`, async () => {
			const provimux = await announcer(true);
			const plain = await announcer(false);
			const told: unknown[][] = [];
			served.length = 0;
			for (const [each, wiring, said] of [
				["named", provimux.wiring, provimux.said],
				["nobody", provimux.wiring, provimux.said],
				["named", provimux.wiring, provimux.said],
				["plain", plain.wiring, plain.said],
			] as const) {
				naming = each;
				const ends = await run(transport.send(wiring));
				expect(ends.at(-1)).toBe("done");
				told.push(said.splice(0));
			}
			expect(told).toEqual([
				// Named: one report, from the proxy's own statement, sent before the answer ended.
				[transport.expected],
				// Named nobody (plugin code took part): said as `[]`, answered by what the proxy would not name.
				[unnamed],
				[transport.expected],
				// Plain CLIProxyAPI: none of the three, quiet as before.
				[],
			]);
			expect(served).toEqual([transport.way, transport.way, transport.way, transport.way]);
		});
	}
});
