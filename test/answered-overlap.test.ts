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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { ANSWERED_STATUS_KEY } from "../extensions/answered-footer.ts";
import providerExtension from "../extensions/index.ts";
import { MODELS_CACHE_FILE_NAME, resolveMappedModels } from "../extensions/lib.ts";
import type { Account } from "../extensions/sources.ts";
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
	/** Codex WebSocket: the answer (or a replay's answer) comes without response.created, as a relayed upstream may send it. */
	noCreated?: boolean;
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
/** How many times the proxy was asked for its credential list (`?include=accounts`), and answered it. */
let listHits = 0;
let accountsAnswered = 0;
/** The credential list's answer: a failure status instead of the list; held until released. */
let accountsStatus: number | undefined;
let accountsHold: { promise: Promise<void>; resolve: () => void } | undefined;
/** Holds the next credential lookups until the test releases them. */
function holdAccounts() {
	let resolve = () => {};
	const promise = new Promise<void>((release) => {
		resolve = release;
	});
	accountsHold = { promise, resolve };
	return resolve;
}
/** Attempts per request marker: a retry is a second attempt with the same marker. */
const attempts = new Map<string, number>();
/** WebSocket requests: [marker, previous_response_id, the socket's client port]. */
const wsRequests: Array<[string, string, number]> = [];
const attempt = (id: string) => {
	const count = (attempts.get(id) ?? 0) + 1;
	attempts.set(id, count);
	return count;
};
/** Requests the proxy answers at once, headers and body. */
const immediate = new Set<string>();

/** The credentials the proxy lists for its models, as an install configured them; "plain": it lists none. */
type Listing = { claude: Account[]; codex: Account[] } | "plain";
const DEFAULT_LISTING = {
	claude: [
		{ provider: "claude", kind: "oauth", priority: 0 },
		{ provider: "claude", kind: "apikey", priority: 0 },
	],
	codex: [
		{ provider: "codex", kind: "oauth", priority: 0 },
		{ provider: "codex", kind: "apikey", priority: 0 },
	],
};
let listing: Listing = DEFAULT_LISTING;

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
	// The last marker: a session's later turns carry the earlier ones in their history.
	const marker = [...body.matchAll(/#([a-z]+)/g)].at(-1)?.[1] ?? "unknown";
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
		if (req.method === "GET" && url.pathname === "/v1/models" && url.searchParams.get("include") === "accounts") {
			// The credential lookup, as the test lets it: held, or failing with a status.
			void (async () => {
				listHits++;
				await accountsHold?.promise;
				if (accountsStatus) {
					res.writeHead(accountsStatus, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: { message: "fixture: credential list unavailable" } }));
					accountsAnswered++;
					return;
				}
				res.writeHead(200, { "content-type": "application/json" });
				const accounts = (list: Account[]) => (listing === "plain" ? {} : { accounts: list });
				const { claude, codex } = listing === "plain" ? DEFAULT_LISTING : listing;
				res.end(
					JSON.stringify({
						object: "list",
						data: [
							{ id: CLAUDE, object: "model", owned_by: "anthropic", ...accounts(claude) },
							{ id: GPT, object: "model", owned_by: "openai", ...accounts(codex) },
							{ id: GPT_HELPER, object: "model", owned_by: "openai", ...accounts(codex) },
						],
					}),
				);
				accountsAnswered++;
			})();
			return;
		}
		if (req.method === "GET" && url.pathname === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			if (url.searchParams.get("include") === "accounts") {
				// A plain CLIProxyAPI does not know the parameter: its plain list, with no credentials.
				const accounts = (list: Account[]) => (listing === "plain" ? {} : { accounts: list });
				const { claude, codex } = listing === "plain" ? DEFAULT_LISTING : listing;
				res.end(
					JSON.stringify({
						object: "list",
						data: [
							{ id: CLAUDE, object: "model", owned_by: "anthropic", ...accounts(claude) },
							{ id: GPT, object: "model", owned_by: "openai", ...accounts(codex) },
							{ id: GPT_HELPER, object: "model", owned_by: "openai", ...accounts(codex) },
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
		const count = attempt(id);
		// Refused before any stream: an HTTP error that still names a credential.
		if (id === "refused" || (id === "httpretry" && count === 1)) {
			res.writeHead(id === "refused" ? 400 : 429, {
				"content-type": "application/json",
				...(id === "refused" ? {} : { "retry-after-ms": "1" }),
				...login("devin"),
			});
			res.end(JSON.stringify({ error: { message: `fixture: ${id}` } }));
			return;
		}
		const frames =
			id === "failedstream"
				? // Opened, named, then failed without a word of answer.
					[
						codexFrames(id, {})[0],
						{
							type: "response.failed",
							response: { status: "failed", error: { code: "invalid_request", message: "fixture: failed" } },
						},
					]
				: id === "empty"
					? // Completed, named, with nothing in it.
						[claudeFrames(id)[0], claudeFrames(id).at(-2), claudeFrames(id).at(-1)]
					: claude
						? claudeFrames(id)
						: codexFrames(id, INNER_GATEWAY);
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
			const count = attempt(id);
			wsRequests.push([id, String(JSON.parse(text).previous_response_id ?? ""), socket.remotePort ?? 0]);
			// The first attempt opens, named by Devin, then fails: the proxy lost the previous response. pi replays the
			// conversation on a fresh socket, and that attempt answers.
			if (id === "wsretry" && count === 1) {
				const response = { id: "lost", status: "in_progress" };
				send(
					JSON.stringify({
						type: "response.created",
						response,
						cpa_auth_kind: "oauth",
						cpa_auth_provider: "devin",
					}),
				);
				send(
					JSON.stringify({
						type: "response.failed",
						response: {
							...response,
							status: "failed",
							error: { code: "previous_response_not_found", message: "fixture: previous response not found" },
						},
					}),
				);
				return;
			}
			const plan = plans.get(id);
			const frames = codexFrames(id, plan?.created ?? {});
			hold({
				id,
				kind: "codex-ws",
				sendHeaders: () => {},
				...framer(
					plan?.noCreated ? frames.slice(1) : frames,
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
	/** Every value the footer's "answered" status was set to, in order (undefined: cleared). */
	statuses: Array<string | undefined>;
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
	/** The models cache on disk. */
	cache: () => { fetchedAt: number; listsCredentials?: boolean };
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
	listing = DEFAULT_LISTING;
	listHits = 0;
	accountsAnswered = 0;
	accountsStatus = undefined;
	accountsHold?.resolve();
	accountsHold = undefined;
	attempts.clear();
	wsRequests.length = 0;
	held.clear();
	immediate.clear();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setEnv(name: string, value: string | undefined) {
	if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

interface StartOptions {
	/** pi's cache warmer refreshes the Claude model while a turn is out. */
	warm?: boolean;
	/** An extension asks for the routes, as pi-cache-keeper does (default); false: nobody asks. */
	ask?: boolean;
	/** The session's transport setting ("websocket-cached": continues on the socket with previous_response_id). */
	transport?: "sse" | "websocket" | "websocket-cached";
	/** Another extension, loaded before this one, returns a shallow copy of each assistant message at its end. */
	copier?: boolean;
	/** A models cache written by this version before pi starts, from the proxy as it is listed then. */
	seedCache?: boolean;
	/** Called once the cache is seeded, before pi starts (and its background refresh asks for the credentials). */
	afterSeed?: () => void;
	/** The footer switch in provimux.json; absent: not set. */
	answered?: boolean;
}

/** A UI for the session: the footer's "answered" status is recorded, everything else does nothing. */
function recordingUi(statuses: Array<string | undefined>) {
	const ui: Record<string | symbol, unknown> = {
		setStatus: (key: string, text: string | undefined) => {
			if (key === ANSWERED_STATUS_KEY) statuses.push(text);
		},
		theme: { fg: (_color: string, text: string) => text },
	};
	return new Proxy(ui, {
		get: (target, name) => (name in target ? target[name] : () => undefined),
	}) as never;
}

async function startPi(options: StartOptions = {}): Promise<Harness> {
	const ask = options.ask ?? true;
	const root = mkdtempSync(join(tmpdir(), "pi-provimux-overlap-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	setEnv("PI_CODING_AGENT_DIR", agentDir);
	setEnv("PI_OFFLINE", "1");
	for (const name of ["PROVIMUX_API_KEY", "PROVIMUX_BASE_URL", "PROVIMUX_PROVIDER_ID"]) setEnv(name, undefined);
	writeFileSync(
		join(agentDir, "provimux.json"),
		JSON.stringify({
			baseUrl,
			apiKey: "sk-fixture",
			claudeMessages: true,
			...(options.answered === undefined ? {} : { answered: options.answered }),
		}),
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
	if (options.seedCache)
		await resolveMappedModels(agentDir, baseUrl, "sk-fixture", { fastMode: false, claudeMessages: "on" });
	options.afterSeed?.();

	const reports: unknown[] = [];
	const statuses: Array<string | undefined> = [];
	const headersSeen: string[] = [];
	const firstEvents: string[] = [];
	let routesTold = false;
	let captured: SimpleStreamOptions | undefined;
	// One provider retry (an HTTP 429 is tried again); no agent-level retry: a failed turn stays failed.
	const settingsManager = SettingsManager.inMemory({ retry: { provider: { maxRetries: 1 } } });
	settingsManager.setRetryEnabled(false);
	settingsManager.setCacheWarmingMode(options.warm ? "streaming" : "off");
	if (options.transport) settingsManager.setTransport(options.transport);
	const testExtension = (pi: ExtensionAPI) => {
		// pi-cache-keeper's part: it asks for the routes and hears what answered.
		pi.on("session_start", () => {
			if (ask) pi.events.emit(REQUEST_EVENT, {});
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
		// The warmer refreshes whatever its own estimate.
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
			extensionFactories: [
				...(options.copier
					? [
							(other: ExtensionAPI) => {
								other.on("message_end", ({ message }) =>
									message.role === "assistant" ? { message: { ...message } } : undefined,
								);
							},
						]
					: []),
				providerExtension,
				testExtension,
			],
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
	await session.bindExtensions({
		mode: "print",
		uiContext: recordingUi(statuses),
		onError: (error) => console.error(error),
	});
	if (ask) await until("the routes", () => routesTold);
	else await until("the models", () => !!session.modelRuntime.getModel(PROVIDER, CLAUDE));
	const model = (id: string) => {
		const found = session.modelRuntime.getModel(PROVIDER, id);
		if (!found) throw new Error(`no model ${id}`);
		return found;
	};
	let quit: Promise<void> | undefined;
	return {
		session,
		reports,
		statuses,
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
		cache: () => JSON.parse(readFileSync(join(agentDir, MODELS_CACHE_FILE_NAME), "utf8")),
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

const CLAUDE_HOST = "api.anthropic.com";
const devinLogin = () => login("devin");
const claudeKey = () => ({ ...apiKey("claude"), "X-CPA-AUTH-HOST": CLAUDE_HOST });
const openRouterKey = () => ({ ...apiKey("openai-compatible-openrouter"), "X-CPA-AUTH-HOST": "openrouter.ai" });

/** One turn of the session on a model, answered at once as planned; resolves when the turn ends. */
async function turn(pi: Harness, model: string, marker: string, plan: Plan) {
	plans.set(marker, plan);
	immediate.add(marker);
	await pi.session.setModel(pi.model(model));
	pi.session.setThinkingLevel("off");
	await pi.session.prompt(`say ok #${marker}`);
	const last = pi.session.messages.at(-1) as { role?: string; stopReason?: string; errorMessage?: string };
	expect(last.role).toBe("assistant");
	expect(last.stopReason, last.errorMessage).toBe("stop");
}

/** What the footer says now: the last value it was set to. */
const footer = (pi: Harness) => pi.statuses.at(-1);

describe("the footer says which route answered the session's turn", { timeout: 20_000 }, () => {
	it("Anthropic sub, Devin sub, Anthropic api, OpenRouter api: with no other extension asking for routes", async () => {
		const pi = await startPi({ ask: false, transport: "sse" });
		try {
			const seen: Array<string | undefined> = [];
			await turn(pi, CLAUDE, "claudesub", { headers: login("claude") });
			seen.push(footer(pi));
			await turn(pi, GPT, "devinsub", { headers: devinLogin() });
			seen.push(footer(pi));
			await turn(pi, CLAUDE, "claudeapi", { headers: claudeKey() });
			seen.push(footer(pi));
			await turn(pi, GPT, "openrouterapi", { headers: openRouterKey() });
			seen.push(footer(pi));
			expect(seen).toEqual([
				"answered: Anthropic sub",
				"answered: Devin sub",
				"answered: Anthropic api",
				"answered: OpenRouter api",
			]);
			// Nobody asked for the routes: no event was told, the footer did not need one.
			expect(pi.reports).toEqual([]);
		} finally {
			await pi.dispose();
		}
	});

	it("a Codex WebSocket turn: its response.created's fields; one without them, after a named one: unknown", async () => {
		const pi = await startPi({ ask: false, transport: "websocket" });
		try {
			await turn(pi, GPT, "wsnamed", { created: { cpa_auth_kind: "oauth", cpa_auth_provider: "devin" } });
			expect(footer(pi)).toBe("answered: Devin sub");
			await turn(pi, GPT, "wskey", {
				created: {
					cpa_auth_kind: "apikey",
					cpa_auth_provider: "openai-compatible-openrouter",
					cpa_auth_host: "openrouter.ai",
				},
			});
			expect(footer(pi)).toBe("answered: OpenRouter api");
			// The proxy named answers before: one it names nobody for is one it would not name.
			await turn(pi, GPT, "wsnobody", { created: {} });
			expect(footer(pi)).toBe("answered: unknown");
		} finally {
			await pi.dispose();
		}
	});

	it("pi's cache warmer next to the turn it warms, and an extension's own request: only the turn counts", async () => {
		const pi = await startPi({ warm: true, ask: false });
		try {
			// The session's callbacks, for the extension's request below (taken on another model, before the turn).
			await pi.sessionOptions();
			plans.set("fg", { headers: login("claude") });
			plans.set("fg-warm", { headers: claudeKey() });
			await pi.session.setModel(pi.model(CLAUDE));
			pi.session.setThinkingLevel("off");
			const running = pi.session.prompt("say ok #fg");
			// The order where the last answer seen is the warmer's: its headers and first event come after the turn's.
			await until("the turn", () => held.has("fg"));
			heldRequest("fg").sendHeaders();
			await until("the turn's headers", () => pi.headersSeen.includes("fg"));
			await until("the warmer's refresh", () => held.has("fg-warm"));
			heldRequest("fg-warm").sendHeaders();
			await until("the refresh's headers", () => pi.headersSeen.includes("fg-warm"));
			heldRequest("fg").sendFirst();
			await until("the turn's first event", () => pi.firstEvents.includes("fg"));
			heldRequest("fg-warm").sendBody();
			await until("the refresh's first event", () => pi.firstEvents.includes("fg-warm"));
			heldRequest("fg").sendBody();
			await running;
			expect(pi.statuses.filter((status) => status !== undefined)).toEqual(["answered: Anthropic sub"]);
			expect(footer(pi)).toBe("answered: Anthropic sub");

			// An extension's own request with the session's callbacks, answered by a key: the footer stays.
			plans.set("side", { headers: openRouterKey() });
			immediate.add("side");
			await send(pi, pi.model(CLAUDE), "side");
			expect(pi.firstEvents).toContain("side");
			expect(footer(pi)).toBe("answered: Anthropic sub");
		} finally {
			await pi.dispose();
		}
	});

	it("switching to a model of another provider clears it; a turn there leaves it clear", async () => {
		const pi = await startPi({ ask: false });
		try {
			await turn(pi, CLAUDE, "before", { headers: login("claude") });
			expect(footer(pi)).toBe("answered: Anthropic sub");
			await pi.session.setModel(pi.session.modelRuntime.getModel("capture", "capture")!);
			expect(footer(pi)).toBeUndefined();
			const count = pi.statuses.length;
			await pi.session.prompt("a turn on the other provider");
			expect(pi.statuses.slice(count).every((status) => status === undefined)).toBe(true);
			// Back on a Provimux model: the next answer is shown again.
			await turn(pi, CLAUDE, "after", { headers: claudeKey() });
			expect(footer(pi)).toBe("answered: Anthropic api");
		} finally {
			await pi.dispose();
		}
	});

	it("a proxy without the headers (plain CLIProxyAPI): nothing, over Claude Messages, Codex SSE and WebSocket", async () => {
		// Plain CLIProxyAPI lists no credentials either.
		listing = "plain";
		for (const transport of ["sse", "websocket"] as const) {
			const pi = await startPi({ ask: false, transport });
			try {
				await turn(pi, CLAUDE, "plainclaude", { headers: {} });
				// The Codex SSE body carries an inner gateway's cpa_auth_* fields: never the proxy's.
				await turn(pi, GPT, "plaingpt", { headers: {}, created: {} });
				expect(pi.statuses.every((status) => status === undefined)).toBe(true);
				expect(pi.reports).toEqual([]);
			} finally {
				await pi.dispose();
			}
		}
	});

	it("an answer the proxy would not name, from a proxy that lists its credentials: unknown", async () => {
		// An extension asked for the routes: the credential list says the proxy names answers.
		const pi = await startPi({ transport: "sse" });
		try {
			await turn(pi, CLAUDE, "unnamed", { headers: {} });
			expect(footer(pi)).toBe("answered: unknown");
			expect(pi.reports).toEqual([report(CLAUDE, [])]);
		} finally {
			await pi.dispose();
		}
	});

	describe("any install: whatever routes it has, in whatever order, the footer says what answered", () => {
		const oauth = (provider: string) => ({ "X-CPA-AUTH-KIND": "oauth", "X-CPA-AUTH-PROVIDER": provider });
		const key = (provider: string, host?: string) => ({
			"X-CPA-AUTH-KIND": "apikey",
			"X-CPA-AUTH-PROVIDER": provider,
			...(host ? { "X-CPA-AUTH-HOST": host } : {}),
		});
		/** Answers a proxy can give, and what the footer must say for each. */
		const ANSWERS: Array<[Record<string, string>, string]> = [
			[oauth("claude"), "Anthropic sub"],
			[key("claude", "api.anthropic.com"), "Anthropic api"],
			[key("claude"), "Anthropic api"],
			[oauth("devin"), "Devin sub"],
			[key("openai-compatible-openrouter", "openrouter.ai"), "OpenRouter api"],
			// An entry named anything, sent to openrouter.ai: OpenRouter.
			[key("openai-compatible-myrouter", "openrouter.ai"), "OpenRouter api"],
			[oauth("antigravity"), "Antigravity sub"],
			[oauth("codex"), "OpenAI sub"],
			[oauth("kimi"), "Kimi sub"],
			[key("gemini", "generativelanguage.googleapis.com"), "Google api"],
			// Services nobody here knows: named as the proxy names them.
			[key("openai-compatible-acme", "api.acme.test"), "api.acme.test api"],
			[oauth("MysteryLab"), "MysteryLab sub"],
		];
		const account = (provider: string, kind: string, priority: number, host?: string): Account => ({
			provider,
			kind,
			priority,
			...(host ? { host } : {}),
		});
		/** Installs as owners set them up: different routes, different priorities. */
		const INSTALLS: Array<[string, Listing]> = [
			[
				"subscription first, then the Claude key, OpenRouter, Devin",
				{
					claude: [
						account("claude", "oauth", 10),
						account("claude", "apikey", 5, "api.anthropic.com"),
						account("openai-compatible-openrouter", "apikey", 1, "openrouter.ai"),
						account("devin", "oauth", 0),
					],
					codex: [account("codex", "oauth", 10), account("codex", "apikey", 0, "api.openai.com")],
				},
			],
			[
				"the reverse: OpenRouter first, the subscription last",
				{
					claude: [
						account("openai-compatible-openrouter", "apikey", 10, "openrouter.ai"),
						account("devin", "oauth", 5),
						account("claude", "apikey", 1, "api.anthropic.com"),
						account("claude", "oauth", 0),
					],
					codex: [account("codex", "apikey", 10, "api.openai.com"), account("codex", "oauth", 0)],
				},
			],
			[
				"no Anthropic at all: OpenRouter and Antigravity, same priority",
				{
					claude: [
						account("openai-compatible-openrouter", "apikey", 0, "openrouter.ai"),
						account("antigravity", "oauth", 0),
					],
					codex: [account("openai-compatible-openrouter", "apikey", 0, "openrouter.ai")],
				},
			],
			[
				"services nobody here knows, mixed with known ones",
				{
					claude: [
						account("openai-compatible-acme", "apikey", 3, "api.acme.test"),
						account("MysteryLab", "oauth", 2),
						account("kimi", "oauth", 1),
						account("claude", "oauth", 0),
					],
					codex: [account("gemini", "apikey", 0, "generativelanguage.googleapis.com")],
				},
			],
		];
		/** A deterministic order of every answer, different for each install. */
		const orderFor = (seed: number) =>
			ANSWERS.map((answer, index) => ({ answer, rank: (index * (2 * seed + 5) + seed * 7) % 13 }))
				.sort((a, b) => a.rank - b.rank)
				.map(({ answer }) => answer);
		const letters = (n: number) => String.fromCharCode(97 + Math.floor(n / 26), 97 + (n % 26));

		for (const [index, [name, installed]] of INSTALLS.entries()) {
			for (const ask of [true, false]) {
				it(`${name}${ask ? ", with the routes asked for" : ""}`, async () => {
					listing = installed;
					const pi = await startPi({ ask, transport: "sse" });
					try {
						const order = orderFor(index);
						// Every answer, once: some are in the install's list, at any priority; some are not in it at all.
						expect(new Set(order)).toEqual(new Set(ANSWERS));
						const shown: Array<string | undefined> = [];
						for (const [turnIndex, [headers]] of order.entries()) {
							// Turns alternate between the Claude Messages model and the Codex SSE model.
							await turn(pi, turnIndex % 2 ? GPT : CLAUDE, `i${letters(index)}t${letters(turnIndex)}`, {
								headers,
							});
							shown.push(footer(pi));
						}
						expect(shown).toEqual(order.map(([, said]) => `answered: ${said}`));
					} finally {
						await pi.dispose();
					}
				});
			}
		}

		it("plain CLIProxyAPI, which lists no credentials and names no answer: nothing, asked or not", async () => {
			listing = "plain";
			for (const ask of [true, false]) {
				const pi = await startPi({ ask, transport: "sse" });
				try {
					for (const [turnIndex, model] of [CLAUDE, GPT, CLAUDE, GPT].entries())
						await turn(pi, model, `plain${letters(turnIndex)}`, { headers: {} });
					expect(pi.statuses.every((status) => status === undefined)).toBe(true);
					expect(pi.reports).toEqual([]);
				} finally {
					await pi.dispose();
				}
			}
		});
	});

	it('"answered": false in provimux.json turns it off; the routes are still told', async () => {
		const pi = await startPi({ answered: false });
		try {
			await turn(pi, CLAUDE, "off", { headers: login("claude") });
			expect(pi.statuses).toEqual([]);
			expect(pi.reports).toEqual([report(CLAUDE, [CLAUDE_LOGIN])]);
		} finally {
			await pi.dispose();
		}
	});
});

/** The session's last message: what the user sees. */
const lastMessage = (pi: Harness) =>
	pi.session.messages.at(-1) as { role?: string; stopReason?: string; content?: unknown[] };

describe("the footer only ever shows the route that produced the answer the user sees", { timeout: 25_000 }, () => {
	describe("retries: the attempt that answered", () => {
		it("a WebSocket continuation the proxy lost, replayed on a fresh socket by another route", async () => {
			const pi = await startPi({ transport: "websocket-cached" });
			try {
				await turn(pi, GPT, "previous", { created: { cpa_auth_kind: "oauth", cpa_auth_provider: "codex" } });
				await turn(pi, GPT, "wsretry", {
					created: {
						cpa_auth_kind: "apikey",
						cpa_auth_provider: "openai-compatible-openrouter",
						cpa_auth_host: "openrouter.ai",
					},
				});
				// The first attempt continued the previous response and was named by Devin; the replay had no previous id.
				expect(attempts.get("wsretry")).toBe(2);
				const [failed, replayed] = wsRequests.filter(([id]) => id === "wsretry");
				expect(failed?.[1]).toBe("previous");
				expect(replayed?.[1]).toBe("");
				expect(footer(pi)).toBe("answered: OpenRouter api");
			} finally {
				await pi.dispose();
			}
		});

		it("three answers on one WebSocket, three routes", async () => {
			const pi = await startPi({ transport: "websocket-cached" });
			try {
				const shown: Array<string | undefined> = [];
				const turns: Array<[string, Record<string, string>]> = [
					["one", { cpa_auth_kind: "oauth", cpa_auth_provider: "devin" }],
					[
						"two",
						{
							cpa_auth_kind: "apikey",
							cpa_auth_provider: "openai-compatible-openrouter",
							cpa_auth_host: "openrouter.ai",
						},
					],
					["three", {}],
				];
				for (const [id, created] of turns) {
					await turn(pi, GPT, id, { created });
					shown.push(footer(pi));
				}
				expect(new Set(wsRequests.map(([, , port]) => port)).size).toBe(1);
				expect(shown).toEqual(["answered: Devin sub", "answered: OpenRouter api", "answered: unknown"]);
			} finally {
				await pi.dispose();
			}
		});

		it("an HTTP 429 named by Devin, retried, answered by OpenRouter", async () => {
			const pi = await startPi({ transport: "sse" });
			try {
				await turn(pi, GPT, "httpretry", { headers: openRouterKey() });
				expect(attempts.get("httpretry")).toBe(2);
				expect(footer(pi)).toBe("answered: OpenRouter api");
			} finally {
				await pi.dispose();
			}
		});
	});

	describe("each attempt names its own route, or none", () => {
		const devinOpens = { cpa_auth_kind: "oauth", cpa_auth_provider: "devin" };

		it("a WebSocket replay without response.created, after an attempt Devin opened: unnamed, so unknown", async () => {
			const pi = await startPi({ ask: false, transport: "websocket-cached" });
			try {
				await turn(pi, GPT, "previous", { created: { cpa_auth_kind: "oauth", cpa_auth_provider: "codex" } });
				// The replay sends its output and response.completed only, as Provimux forwards such an upstream answer.
				await turn(pi, GPT, "wsretry", { noCreated: true });
				expect(attempts.get("wsretry")).toBe(2);
				const [failed, replayed] = wsRequests.filter(([id]) => id === "wsretry");
				expect(failed?.[1]).toBe("previous");
				expect(replayed?.[1]).toBe("");
				expect(footer(pi)).toBe("answered: unknown");
			} finally {
				await pi.dispose();
			}
		});

		it("the same replay naming nobody on response.created: unknown; naming OpenRouter: OpenRouter", async () => {
			const pi = await startPi({ ask: false, transport: "websocket-cached" });
			try {
				await turn(pi, GPT, "previous", { created: devinOpens });
				await turn(pi, GPT, "wsretry", { created: {} });
				expect(footer(pi)).toBe("answered: unknown");
			} finally {
				await pi.dispose();
			}
		});

		it("a first WebSocket answer without response.created, after a successful credential lookup: unknown", async () => {
			const pi = await startPi({ ask: false, transport: "websocket-cached" });
			try {
				await turn(pi, GPT, "single", { noCreated: true });
				expect(listHits).toBe(1);
				expect(wsRequests.map(([id]) => id)).toEqual(["single"]);
				expect(footer(pi)).toBe("answered: unknown");
			} finally {
				await pi.dispose();
			}
		});

		it("the same from plain CLIProxyAPI, which lists no credentials: nothing", async () => {
			listing = "plain";
			const pi = await startPi({ ask: false, transport: "websocket-cached" });
			try {
				await turn(pi, GPT, "single", { noCreated: true });
				await turn(pi, GPT, "again", { noCreated: true });
				expect(pi.statuses.every((status) => status === undefined)).toBe(true);
			} finally {
				await pi.dispose();
			}
		});
	});

	describe("only a credential lookup that answered changes what is known", () => {
		/**
		 * pi starts on a cache that lists credentials; its background refresh's credential lookup is held. `early`: an
		 * unnamed turn while it is held. Then the lookup answers `then` (a status, or the list as `listing` is), and an
		 * unnamed turn follows.
		 */
		async function refresh(then: number | "plain" | "listed", early: boolean) {
			let release = () => {};
			const pi = await startPi({
				ask: false,
				transport: "sse",
				seedCache: true,
				afterSeed: () => {
					release = holdAccounts();
				},
			});
			try {
				const seeded = pi.cache();
				await until("the background lookup", () => listHits > 0);
				if (early) await turn(pi, CLAUDE, "early", { headers: {} });
				const shown = [early ? footer(pi) : "no turn"];
				if (typeof then === "number") accountsStatus = then;
				if (then === "plain") listing = "plain";
				release();
				await until("the lookup's answer", () => accountsAnswered > 0);
				await until("the refreshed cache", () => pi.cache().fetchedAt !== seeded.fetchedAt);
				await turn(pi, CLAUDE, "later", { headers: {} });
				shown.push(footer(pi));
				return { seeded: seeded.listsCredentials, kept: pi.cache().listsCredentials ?? null, shown };
			} finally {
				release();
				await pi.dispose();
			}
		}

		it("a cache that lists credentials, then the lookup fails (503) before any answer: kept, unknown", async () => {
			expect(await refresh(503, false)).toEqual({
				seeded: true,
				kept: true,
				shown: ["no turn", "answered: unknown"],
			});
		});

		it("two unnamed answers on the same proxy, a failed lookup between them: unknown both times", async () => {
			expect(await refresh(503, true)).toEqual({
				seeded: true,
				kept: true,
				shown: ["answered: unknown", "answered: unknown"],
			});
		});

		it("the lookup answers, still listing credentials: kept, unknown both times", async () => {
			expect(await refresh("listed", true)).toEqual({
				seeded: true,
				kept: true,
				shown: ["answered: unknown", "answered: unknown"],
			});
		});

		it("the lookup answers from a proxy that is plain now: cleared, nothing", async () => {
			expect(await refresh("plain", true)).toEqual({
				seeded: true,
				kept: null,
				shown: ["answered: unknown", undefined],
			});
		});
	});

	describe("a failed, aborted or empty turn leaves the footer as it was", () => {
		it("aborted after Devin's opening frame", async () => {
			const pi = await startPi({ ask: false, transport: "sse" });
			try {
				await turn(pi, CLAUDE, "before", { headers: login("claude") });
				plans.set("aborted", { headers: devinLogin() });
				const running = pi.session.prompt("say ok #aborted");
				await until("the request", () => held.has("aborted"));
				heldRequest("aborted").sendHeaders();
				heldRequest("aborted").sendFirst();
				await until("the opening frame", () => pi.firstEvents.includes("aborted"));
				await pi.session.abort();
				await running;
				expect(lastMessage(pi).stopReason).toBe("aborted");
				expect(footer(pi)).toBe("answered: Anthropic sub");
			} finally {
				await pi.dispose();
			}
		});

		it("refused before any stream (HTTP 400 named by Devin), then opened by Devin and failed", async () => {
			const pi = await startPi({ ask: false, transport: "sse" });
			try {
				await turn(pi, GPT, "before", { headers: login("claude") });
				await pi.session.prompt("say ok #refused");
				expect(lastMessage(pi)).toMatchObject({ stopReason: "error", content: [] });
				expect(footer(pi)).toBe("answered: Anthropic sub");
				plans.set("failedstream", { headers: devinLogin() });
				immediate.add("failedstream");
				await pi.session.prompt("say ok #failedstream");
				expect(lastMessage(pi)).toMatchObject({ stopReason: "error", content: [] });
				expect(footer(pi)).toBe("answered: Anthropic sub");
			} finally {
				await pi.dispose();
			}
		});

		it("completed by Devin with nothing in it", async () => {
			const pi = await startPi({ ask: false, transport: "sse" });
			try {
				await turn(pi, CLAUDE, "before", { headers: login("claude") });
				plans.set("empty", { headers: devinLogin() });
				immediate.add("empty");
				await pi.session.prompt("say ok #empty");
				expect(lastMessage(pi)).toMatchObject({ stopReason: "stop", content: [] });
				expect(footer(pi)).toBe("answered: Anthropic sub");
			} finally {
				await pi.dispose();
			}
		});
	});

	it("an answer that ends after another provider was selected does not bring the footer back", async () => {
		const pi = await startPi({ ask: false, transport: "sse" });
		try {
			await turn(pi, CLAUDE, "before", { headers: login("claude") });
			plans.set("late", { headers: devinLogin() });
			const running = pi.session.prompt("say ok #late");
			await until("the request", () => held.has("late"));
			heldRequest("late").sendHeaders();
			heldRequest("late").sendFirst();
			await until("the opening frame", () => pi.firstEvents.includes("late"));
			await pi.session.setModel(pi.session.modelRuntime.getModel("capture", "capture")!);
			expect(footer(pi)).toBeUndefined();
			heldRequest("late").sendBody();
			await running;
			expect(lastMessage(pi)).toMatchObject({ role: "assistant", stopReason: "stop" });
			expect(footer(pi)).toBeUndefined();
			// Back on Provimux: the next answer shows.
			await turn(pi, CLAUDE, "after", { headers: openRouterKey() });
			expect(footer(pi)).toBe("answered: OpenRouter api");
		} finally {
			await pi.dispose();
		}
	});

	it("another extension returns a shallow copy of the message at its end: still named", async () => {
		const pi = await startPi({ copier: true, transport: "sse" });
		try {
			await turn(pi, CLAUDE, "copied", { headers: devinLogin() });
			expect(pi.reports).toEqual([report(CLAUDE, [{ provider: "devin", subscription: true }])]);
			expect(footer(pi)).toBe("answered: Devin sub");
			await turn(pi, GPT, "copiedgpt", { headers: openRouterKey() });
			expect(footer(pi)).toBe("answered: OpenRouter api");
		} finally {
			await pi.dispose();
		}
	});

	describe("the startup model list says whether the proxy names answers", () => {
		it("credentials listed: the very first unnamed answer is unknown, with no other extension", async () => {
			const pi = await startPi({ ask: false, transport: "sse" });
			try {
				const shown: Array<string | undefined> = [];
				await turn(pi, CLAUDE, "first", { headers: {} });
				shown.push(footer(pi));
				await turn(pi, CLAUDE, "second", { headers: devinLogin() });
				shown.push(footer(pi));
				await turn(pi, CLAUDE, "third", { headers: {} });
				shown.push(footer(pi));
				// Only the startup list was asked for: nobody asked for the routes.
				expect(listHits).toBe(1);
				expect(pi.reports).toEqual([]);
				expect(shown).toEqual(["answered: unknown", "answered: Devin sub", "answered: unknown"]);
			} finally {
				await pi.dispose();
			}
		});

		it("no credentials listed (plain CLIProxyAPI): nothing, from the first answer on", async () => {
			listing = "plain";
			const pi = await startPi({ ask: false, transport: "sse" });
			try {
				await turn(pi, CLAUDE, "first", { headers: {} });
				await turn(pi, GPT, "second", { headers: {} });
				expect(listHits).toBe(1);
				expect(pi.statuses.every((status) => status === undefined)).toBe(true);
			} finally {
				await pi.dispose();
			}
		});
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
