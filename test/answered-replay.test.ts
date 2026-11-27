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
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
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
import { ANSWERED_EVENT, ENTRY_EVENT, REQUEST_EVENT, UPSTREAMS_EVENT } from "../extensions/upstreams.ts";
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
/** An inner gateway's own fields, passed through on a Codex SSE body's response.created: never the proxy's. */
const INNER_GATEWAY = {
	cpa_auth_kind: "apikey",
	cpa_auth_provider: "openai-compatible-inner",
	cpa_auth_host: "inner.test",
};

const plans = new Map<string, Plan>();
const held = new Map<string, Held>();
/** How many times the proxy was asked for its credential list (`?include=accounts`), and answered it. */
let _listHits = 0;
let _accountsAnswered = 0;
/** The credential list's answer: a failure status instead of the list; held until released. */
let accountsStatus: number | undefined;
let accountsHold: { promise: Promise<void>; resolve: () => void } | undefined;
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
				_listHits++;
				await accountsHold?.promise;
				if (accountsStatus) {
					res.writeHead(accountsStatus, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: { message: "fixture: credential list unavailable" } }));
					_accountsAnswered++;
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
				_accountsAnswered++;
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
						provimux_account: "a.aaaaaaaaaaaaaaaaaaaa",
						provimux_entry: "devin/gpt-5",
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
	/** The entries of the answers (model-upstreams:answered-entry), as other extensions hear them. */
	entries: unknown[];
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
	_listHits = 0;
	_accountsAnswered = 0;
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
	const entries: unknown[] = [];
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
		pi.events.on(ENTRY_EVENT, (said) => {
			entries.push(said);
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
		entries,
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

const report = (model: string, upstreams: unknown[]) => ({ provider: PROVIDER, model, upstreams });

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

// The review's fixture (2026-11-27): the first attempt of a Codex WebSocket turn is opened by Devin and named
// devin/gpt-5, then fails (the proxy lost the previous response); pi replays the conversation on a fresh socket, and
// OpenRouter answers it. What other extensions are told last is the attempt whose answer the user got.
describe("a Codex WebSocket replay: other extensions are told the attempt that answered", { timeout: 25_000 }, () => {
	it("the entry and account told last are the replay's, as the footer shows", async () => {
		const pi = await startPi({ transport: "websocket-cached" });
		try {
			await turn(pi, GPT, "previous", { created: { cpa_auth_kind: "oauth", cpa_auth_provider: "codex" } });
			pi.reports.length = 0;
			await turn(pi, GPT, "wsretry", {
				created: {
					cpa_auth_kind: "apikey",
					cpa_auth_provider: "openai-compatible-openrouter",
					cpa_auth_host: "openrouter.ai",
					provimux_account: "a.bbbbbbbbbbbbbbbbbbbb",
					provimux_entry: "openrouter/openai/gpt-5",
				},
			});
			expect(attempts.get("wsretry")).toBe(2);
			expect(pi.statuses.at(-1)).toBe("answered: OpenRouter api");
			expect(pi.reports.at(-1)).toEqual(report(GPT, [{ provider: "openrouter", subscription: false }]));
			expect(pi.entries.at(-1)).toEqual({
				provider: PROVIDER,
				model: GPT,
				entry: "openrouter/openai/gpt-5",
				account: "a.bbbbbbbbbbbbbbbbbbbb",
			});
		} finally {
			await pi.dispose();
		}
	});
});
