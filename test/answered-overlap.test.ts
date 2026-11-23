/**
 * What answered, when requests overlap: this extension as pi loads it, in a real pi session, against a fixture proxy
 * whose answers the test releases in a chosen order. Each request must be told once, with its own credential.
 *
 * Requests overlap in pi: its cache warmer refreshes the cache while the turn it warms is still streaming, and an
 * extension can send its own request with the session's callbacks. pi's events (`after_provider_response`,
 * `provider_stream_event`) name no request, so whatever one request's answer says must stay with that request.
 *
 * The order forced in each case is the one where a shared slot goes wrong: the second request's headers arrive before
 * the first request's first stream event.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
	type AgentSession,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionAPI,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import providerExtension from "../extensions/index.ts";
import { ANSWERED_EVENT, REQUEST_EVENT, UPSTREAMS_EVENT } from "../extensions/upstreams.ts";
import { acceptWebSocket } from "./websocket-fixture.ts";

const PROVIDER = "provimux";
const CLAUDE = "claude-opus-5-5";
const GPT = "gpt-6.1-sol";
const GPT_HELPER = "gpt-6.1-sol-mini";
/** The owner's proxy and its neighbour: never contacted. */
const FORBIDDEN_PORTS = new Set(["8317", "8787"]);

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(what: string, ready: () => boolean, ms = 8_000) {
	const deadline = Date.now() + ms;
	while (!ready()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await pause(5);
	}
}

// --- The fixture proxy -----------------------------------------------------------------------------------------------

/** What the proxy says about one answer: its headers (HTTP) or the fields on its response.created (WebSocket). */
interface Plan {
	headers?: Record<string, string>;
	created?: Record<string, string>;
}

/** A request the proxy holds: the test sends its headers, then its body, when it chooses. */
interface Held {
	id: string;
	kind: "claude" | "codex-sse" | "codex-ws";
	sendHeaders: () => void;
	/** The answer's first frame only. */
	sendFirst: () => void;
	/** What is left of the answer. */
	sendBody: () => void;
}

const login = (provider: string) => ({ "X-CPA-AUTH-KIND": "oauth", "X-CPA-AUTH-PROVIDER": provider });
const apiKey = (provider: string) => ({ "X-CPA-AUTH-KIND": "apikey", "X-CPA-AUTH-PROVIDER": provider });
/** An inner gateway's own fields, passed through on a Codex SSE body's response.created: never the proxy's. */
const INNER_GATEWAY = {
	cpa_auth_kind: "apikey",
	cpa_auth_provider: "openai-compatible-inner",
	cpa_auth_host: "inner.test",
};

const plans = new Map<string, Plan>();
const held = new Map<string, Held>();
/** Requests the proxy answers at once, headers and body. */
const immediate = new Set<string>();

function claudeFrames(id: string) {
	return [
		{
			type: "message_start",
			message: {
				id,
				type: "message",
				role: "assistant",
				model: CLAUDE,
				content: [],
				stop_reason: null,
				usage: { input_tokens: 3, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
}

function codexFrames(id: string, created: Record<string, unknown>) {
	const item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed" };
	return [
		{ type: "response.created", response: { id, status: "in_progress" }, ...created },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
		{
			type: "response.content_part.added",
			item_id: item.id,
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "" },
		},
		{ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "ok" },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: { ...item, content: [{ type: "output_text", text: "ok", annotations: [] }] },
		},
		{
			type: "response.completed",
			response: {
				id,
				status: "completed",
				usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
}

/** Which request a body is: the marker `#<id>` in its prompt; a one-token replay is the cache warmer's. */
function idOf(body: string): string {
	const marker = /#([a-z]+)/.exec(body)?.[1] ?? "unknown";
	return /"max_tokens":1[,}]/.test(body) ? `${marker}-warm` : marker;
}

/** Writes frames one at a time: the first on its own, when asked, then the rest. */
function framer(frames: unknown[], write: (frame: unknown) => void, end: () => void) {
	let next = 0;
	return {
		sendFirst: () => {
			if (next === 0) write(frames[next++]);
		},
		sendBody: () => {
			while (next < frames.length) write(frames[next++]);
			end();
		},
	};
}

function hold(entry: Held) {
	if (immediate.has(entry.id)) {
		entry.sendHeaders();
		entry.sendBody();
		return;
	}
	held.set(entry.id, entry);
}

function serveHttp(req: IncomingMessage, res: ServerResponse) {
	const chunks: Buffer[] = [];
	req.on("data", (chunk: Buffer) => chunks.push(chunk));
	req.on("end", () => {
		const url = new URL(req.url ?? "/", "http://fixture");
		if (req.method === "GET" && url.pathname === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			if (url.searchParams.get("include") === "accounts") {
				const claude = [
					{ provider: "claude", kind: "oauth", priority: 0 },
					{ provider: "claude", kind: "apikey", priority: 0 },
				];
				const codex = [
					{ provider: "codex", kind: "oauth", priority: 0 },
					{ provider: "codex", kind: "apikey", priority: 0 },
				];
				res.end(
					JSON.stringify({
						object: "list",
						data: [
							{ id: CLAUDE, object: "model", owned_by: "anthropic", accounts: claude },
							{ id: GPT, object: "model", owned_by: "openai", accounts: codex },
							{ id: GPT_HELPER, object: "model", owned_by: "openai", accounts: codex },
						],
					}),
				);
			} else {
				res.end(
					JSON.stringify({
						models: [CLAUDE, GPT, GPT_HELPER].map((slug) => ({
							slug,
							display_name: slug,
							input_modalities: ["text"],
							context_window: 200_000,
						})),
					}),
				);
			}
			return;
		}
		const raw = Buffer.concat(chunks);
		// The Codex SSE body comes zstd-compressed, as to the Codex backend.
		const body = (req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw).toString("utf8");
		const id = idOf(body);
		const plan = plans.get(id) ?? {};
		const claude = url.pathname.endsWith("/messages");
		if (!claude && !url.pathname.endsWith("/responses")) {
			res.writeHead(404);
			res.end();
			return;
		}
		const frames = claude ? claudeFrames(id) : codexFrames(id, INNER_GATEWAY);
		hold({
			id,
			kind: claude ? "claude" : "codex-sse",
			sendHeaders: () => {
				res.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					"x-fixture-request": id,
					...plan.headers,
				});
				res.flushHeaders();
			},
			...framer(
				frames,
				(frame) => res.write(`event: ${(frame as { type: string }).type}\ndata: ${JSON.stringify(frame)}\n\n`),
				() => res.end(),
			),
		});
	});
}

let server: Server;
let baseUrl: string;
const upgraded = new Set<Socket>();

beforeAll(async () => {
	server = createServer(serveHttp);
	server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
		upgraded.add(socket);
		socket.on("close", () => upgraded.delete(socket));
		acceptWebSocket(req, socket, (send, text) => {
			const id = idOf(text);
			const created = plans.get(id)?.created ?? {};
			hold({
				id,
				kind: "codex-ws",
				sendHeaders: () => {},
				...framer(
					codexFrames(id, created),
					(frame) => send(JSON.stringify(frame)),
					() => {},
				),
			});
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	for (const socket of upgraded) socket.destroy();
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
});

// --- pi, with this extension loaded ---------------------------------------------------------------------------------

interface Harness {
	session: AgentSession;
	/** The reports, as other extensions hear them. */
	reports: unknown[];
	/** Requests whose headers pi passed to extensions, by the fixture's request id. */
	headersSeen: string[];
	/** Requests whose first stream event pi passed to extensions. */
	firstEvents: string[];
	/** The callbacks pi gives a request of this session (as pi's own calls and an extension's reuse get them). */
	sessionOptions: (fresh?: boolean) => Promise<SimpleStreamOptions>;
	model: (id: string) => Model<Api>;
	/** `/reload`: the session's extensions shut down and load again. */
	reload: () => Promise<void>;
	/** Quits the session. */
	dispose: () => Promise<void>;
}

const savedEnv = new Map<string, string | undefined>();
const tempDirs: string[] = [];
const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
	for (const [name, value] of savedEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	savedEnv.clear();
	plans.clear();
	held.clear();
	immediate.clear();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setEnv(name: string, value: string | undefined) {
	if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function startPi(options: { warm?: boolean } = {}): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), "pi-provimux-overlap-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	setEnv("PI_CODING_AGENT_DIR", agentDir);
	setEnv("PI_OFFLINE", "1");
	for (const name of ["CLIPROXYAPI_API_KEY", "CLIPROXYAPI_BASE_URL", "CLIPROXYAPI_PROVIDER_ID"])
		setEnv(name, undefined);
	writeFileSync(
		join(agentDir, "cliproxyapi.json"),
		JSON.stringify({ baseUrl, apiKey: "sk-fixture", claudeMessages: true }),
	);
	// A cache lifetime of 11 s: pi's warmer refreshes after 1 s, while the turn it warms is still out.
	if (options.warm)
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: { [PROVIDER]: { modelOverrides: { [CLAUDE]: { promptCache: { short: 11 } } } } },
			}),
		);
	// Nothing leaves the machine: models.dev answers empty, the owner's proxy is never reached.
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (FORBIDDEN_PORTS.has(url.port)) throw new Error(`refused: ${url.href}`);
		if (url.hostname === "models.dev") return new Response("{}", { headers: { "content-type": "application/json" } });
		if (url.hostname !== "127.0.0.1") throw new Error(`refused: ${url.href}`);
		return realFetch(input, init);
	}) as typeof fetch;

	const reports: unknown[] = [];
	const headersSeen: string[] = [];
	const firstEvents: string[] = [];
	let routesTold = false;
	let captured: SimpleStreamOptions | undefined;
	const settingsManager = SettingsManager.inMemory();
	settingsManager.setCacheWarmingMode(options.warm ? "streaming" : "off");
	const testExtension = (pi: ExtensionAPI) => {
		// pi-cache-keeper's part: it asks for the routes and hears what answered.
		pi.on("session_start", () => {
			pi.events.emit(REQUEST_EVENT, {});
		});
		pi.events.on(UPSTREAMS_EVENT, () => {
			routesTold = true;
		});
		pi.events.on(ANSWERED_EVENT, (report) => {
			reports.push(report);
		});
		pi.on("after_provider_response", (event) => {
			const id = event.headers["x-fixture-request"];
			if (id) headersSeen.push(id);
		});
		pi.on("provider_stream_event", (event) => {
			const data = event.data as { type?: string; message?: { id?: string }; response?: { id?: string } };
			if (data.type === "message_start" && data.message?.id) firstEvents.push(data.message.id);
			if (data.type === "response.created" && data.response?.id) firstEvents.push(data.response.id);
		});
		// The warmer refreshes whatever its own estimate (pi >=1.3 asks extensions; typed only from later versions).
		(pi.on as (event: string, handler: () => unknown) => void)("cache_warming_decision", () => ({
			action: "refresh",
		}));
		// A provider of the test's own, whose stream keeps the callbacks pi gives a request of this session.
		pi.registerProvider("capture", {
			baseUrl: "http://127.0.0.1:9",
			api: "capture-api",
			apiKey: "capture",
			models: [
				{
					id: "capture",
					name: "capture",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 100,
				},
			],
			streamSimple: (model, _context, streamOptions) => {
				captured = streamOptions;
				const stream = createAssistantMessageEventStream();
				const message = {
					role: "assistant" as const,
					content: [{ type: "text" as const, text: "ok" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop" as const,
					timestamp: Date.now(),
				};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
				});
				return stream;
			},
		});
	};
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		settingsManager,
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [providerExtension, testExtension],
		},
	});
	// pi's session runtime, as the CLI runs one: quitting it tells extensions `session_shutdown` ("quit").
	const runtime = await createAgentSessionRuntime(
		async (target) => {
			const result = await createAgentSessionFromServices({ ...target, services, noTools: "all" });
			return { ...result, services, diagnostics: services.diagnostics };
		},
		{ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
	);
	const session = runtime.session;
	await session.bindExtensions({ mode: "print", onError: (error) => console.error(error) });
	await until("the routes", () => routesTold);
	const model = (id: string) => {
		const found = session.modelRuntime.getModel(PROVIDER, id);
		if (!found) throw new Error(`no model ${id}`);
		return found;
	};
	let quit: Promise<void> | undefined;
	return {
		session,
		reports,
		headersSeen,
		firstEvents,
		model,
		sessionOptions: async (fresh = false) => {
			if (!captured || fresh) {
				captured = undefined;
				await session.setModel(session.modelRuntime.getModel("capture", "capture")!);
				await session.prompt("capture the callbacks");
			}
			return captured!;
		},
		reload: async () => {
			routesTold = false;
			await session.reload();
			await until("the routes after the reload", () => routesTold);
		},
		dispose: () => {
			quit ??= runtime.dispose();
			return quit;
		},
	};
}

const context = (marker: string): Context => ({
	messages: [{ role: "user", content: `say ok #${marker}`, timestamp: 0 }],
});

const report = (model: string, upstreams: unknown[]) => ({ provider: PROVIDER, model, upstreams });
const CLAUDE_LOGIN = { provider: "anthropic", subscription: true };
const CLAUDE_KEY = { provider: "anthropic", subscription: false };
const CODEX_LOGIN = { provider: "openai-codex", subscription: true };
const OPENAI_KEY = { provider: "openai", subscription: false };

/** Sends one request with the session's callbacks, as an extension's own call does; resolves with its end. */
async function send(pi: Harness, model: Model<Api>, marker: string, extra: Partial<SimpleStreamOptions> = {}) {
	const options = await pi.sessionOptions();
	const message = await pi.session.modelRuntime
		.streamSimple(model, context(marker), { ...options, ...extra } as SimpleStreamOptions)
		.result();
	expect(message.stopReason, message.errorMessage).toBe("stop");
}

const heldRequest = (id: string) => held.get(id)!;

describe("what answered, when requests overlap", { timeout: 20_000 }, () => {
	it("pi's cache warmer next to the turn it warms: each reports its own credential", async () => {
		const pi = await startPi({ warm: true });
		try {
			plans.set("fg", { headers: login("claude") });
			plans.set("fg-warm", { headers: apiKey("claude") });
			await pi.session.setModel(pi.model(CLAUDE));
			pi.session.setThinkingLevel("off");
			const turn = pi.session.prompt("say ok #fg");
			// The turn's headers arrive; then pi's warmer refreshes the same model while the turn is out.
			await until("the turn", () => held.has("fg"));
			heldRequest("fg").sendHeaders();
			await until("the turn's headers", () => pi.headersSeen.includes("fg"));
			await until("the warmer's refresh", () => held.has("fg-warm"));
			heldRequest("fg-warm").sendHeaders();
			await until("the refresh's headers", () => pi.headersSeen.includes("fg-warm"));
			// The turn's first event, then the refresh's (whole: pi stops warming when the turn ends), then the turn's end.
			heldRequest("fg").sendFirst();
			await until("the turn's first event", () => pi.firstEvents.includes("fg"));
			heldRequest("fg-warm").sendBody();
			await until("the refresh's first event", () => pi.firstEvents.includes("fg-warm"));
			heldRequest("fg").sendBody();
			await turn;
			expect(pi.reports).toEqual([report(CLAUDE, [CLAUDE_LOGIN]), report(CLAUDE, [CLAUDE_KEY])]);
		} finally {
			await pi.dispose();
		}
	});

	it("two requests to the same model: each reports its own credential", async () => {
		const pi = await startPi();
		try {
			plans.set("first", { headers: login("claude") });
			plans.set("second", { headers: apiKey("claude") });
			await pi.sessionOptions();
			const first = send(pi, pi.model(CLAUDE), "first");
			await until("the first request", () => held.has("first"));
			heldRequest("first").sendHeaders();
			await until("the first's headers", () => pi.headersSeen.includes("first"));
			const second = send(pi, pi.model(CLAUDE), "second");
			await until("the second request", () => held.has("second"));
			heldRequest("second").sendHeaders();
			await until("the second's headers", () => pi.headersSeen.includes("second"));
			heldRequest("first").sendBody();
			await first;
			heldRequest("second").sendBody();
			await second;
			expect(pi.reports).toEqual([report(CLAUDE, [CLAUDE_LOGIN]), report(CLAUDE, [CLAUDE_KEY])]);
		} finally {
			await pi.dispose();
		}
	});

	it("two Codex SSE requests: one the proxy names nobody for, one named; the body's fields never count", async () => {
		const pi = await startPi();
		try {
			// The main answer names nobody (its body carries an inner gateway's fields); the helper's is an API key.
			plans.set("main", { headers: {} });
			plans.set("helper", { headers: apiKey("codex") });
			await pi.sessionOptions();
			const sse = { transport: "sse" } as Partial<SimpleStreamOptions>;
			const main = send(pi, pi.model(GPT), "main", { ...sse, sessionId: "overlap-main" });
			await until("the main request", () => held.has("main"));
			heldRequest("main").sendHeaders();
			await until("the main's headers", () => pi.headersSeen.includes("main"));
			// The helper starts before the main's first frame; its headers come after it.
			const helper = send(pi, pi.model(GPT_HELPER), "helper", { ...sse, sessionId: "overlap-helper" });
			await until("the helper request", () => held.has("helper"));
			heldRequest("main").sendBody();
			await main;
			heldRequest("helper").sendHeaders();
			heldRequest("helper").sendBody();
			await helper;
			expect(pi.reports).toEqual([report(GPT, []), report(GPT_HELPER, [OPENAI_KEY])]);
		} finally {
			await pi.dispose();
		}
	});

	it("a Codex WebSocket turn next to an SSE request: the turn's response.created, the request's headers", async () => {
		const pi = await startPi();
		try {
			plans.set("turn", { created: { cpa_auth_kind: "oauth", cpa_auth_provider: "codex" } });
			plans.set("side", { headers: apiKey("codex") });
			await pi.sessionOptions();
			const turn = send(pi, pi.model(GPT), "turn", { transport: "websocket", sessionId: "overlap-ws" });
			await until("the WebSocket turn", () => held.has("turn"));
			const side = send(pi, pi.model(GPT_HELPER), "side", { transport: "sse", sessionId: "overlap-sse" });
			await until("the SSE request", () => held.has("side"));
			heldRequest("side").sendHeaders();
			await until("the SSE request's headers", () => pi.headersSeen.includes("side"));
			heldRequest("turn").sendBody();
			await turn;
			heldRequest("side").sendBody();
			await side;
			expect(pi.reports).toEqual([report(GPT, [CODEX_LOGIN]), report(GPT_HELPER, [OPENAI_KEY])]);
		} finally {
			await pi.dispose();
		}
	});
});

/** pi-ai's shared Claude Messages implementation, as pi looks it up for every provider without its own stream. */
const claudeMessages = () =>
	getApiProvider("anthropic-messages") as unknown as Record<"stream" | "streamSimple", unknown>;
const methodsOf = (implementation: Record<"stream" | "streamSimple", unknown>) => ({
	implementation,
	stream: implementation.stream,
	streamSimple: implementation.streamSimple,
});

describe("the Claude Messages wrap, as sessions load, reload and quit", { timeout: 20_000 }, () => {
	/** One Claude request with the session's callbacks, answered at once by a login. */
	async function ask(pi: Harness, marker: string) {
		plans.set(marker, { headers: login("claude") });
		immediate.add(marker);
		await send(pi, pi.model(CLAUDE), marker);
	}
	const claudeLogin = report(CLAUDE, [CLAUDE_LOGIN]);

	it("one wrap however many sessions; after the last quit, pi-ai's own methods, the same functions", async () => {
		const original = methodsOf(claudeMessages());

		// Load: the same implementation, both methods wrapped.
		const first = await startPi();
		const installed = methodsOf(claudeMessages());
		expect(installed.implementation).toBe(original.implementation);
		expect(installed.stream).not.toBe(original.stream);
		expect(installed.streamSimple).not.toBe(original.streamSimple);
		await ask(first, "one");
		expect(first.reports).toEqual([claudeLogin]);

		// A second session loads the extension too: the one wrap, unchanged.
		const second = await startPi();
		expect(methodsOf(claudeMessages())).toEqual(installed);
		await ask(second, "two");
		expect(second.reports).toEqual([claudeLogin]);

		// The first quits: the second still reports.
		await first.dispose();
		expect(methodsOf(claudeMessages())).toEqual(installed);
		await ask(second, "three");
		expect(second.reports).toEqual([claudeLogin, claudeLogin]);

		// The last quits: pi-ai's own methods back on the same implementation.
		await second.dispose();
		const after = methodsOf(claudeMessages());
		expect(after.implementation).toBe(original.implementation);
		expect(after.stream).toBe(original.stream);
		expect(after.streamSimple).toBe(original.streamSimple);
	});

	it("a reload: the old implementation gets its own methods back, the new one is wrapped once; then the quit", async () => {
		const pi = await startPi();
		for (const round of ["a", "b"]) {
			const before = claudeMessages();
			const wrapped = methodsOf(before);
			await pi.reload();
			// pi made a new implementation on the reload; the extension, loaded again, wrapped that one.
			const now = claudeMessages();
			expect(now).not.toBe(before);
			expect(before.stream).not.toBe(wrapped.stream);
			expect(before.streamSimple).not.toBe(wrapped.streamSimple);
			expect(now.streamSimple).not.toBe(before.streamSimple);
			await pi.sessionOptions(true);
			await ask(pi, `reload${round}`);
		}
		expect(pi.reports).toEqual([claudeLogin, claudeLogin]);
		// What the reload replaced was pi-ai's own; after the quit the current one is unwrapped too: a request of this
		// provider made directly through it gets the callbacks it was given.
		const current = claudeMessages();
		const wrapper = current.streamSimple;
		await pi.dispose();
		expect(current.streamSimple).not.toBe(wrapper);
		expect(current.stream).not.toBe(wrapper);
	});
});
