/**
 * pi's own CLI, with this extension loaded, against a fixture proxy: the release review's cases, run on
 * the pi the tests have installed (package-lock.json's).
 *
 * - A lookup of the credential list still out when its session ends (`pi -p` quitting, `/reload`) never ends pi.
 * - The thinking guard reads `--model` as pi does: `local-assistant:high` is a model id, not `local-assistant` at
 *   high; and a level pinned in `--models` that the model lacks is refused like one asked any other way.
 * - A Codex conversation resumed after a catalog refresh took its first turn's level away sends no level the model
 *   lacks.
 *
 * Each run gets its own agent directory and home; nothing is sent anywhere but the fixture on an ephemeral loopback
 * port. The owner's proxy (8317) and its neighbour (8787) are refused at the socket.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FellBack as FELL_BACK } from "./session-route-contract.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXTENSION = join(ROOT, "extensions", "index.ts");
const PI_CLI = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const NEMOTRON = "provimux/nemotron-3-5-super";
const CLAUDE = "provimux/claude-opus-5-5";
const LITERAL = "provimux/local-assistant:high";
const CODEX = "provimux/gpt-catalog-fixture";

/** What another extension does (pi-cache-keeper's part: it asks for the routes, when the case says so), and what the test
 * needs to steer a run. */
const OBSERVER = `import { appendFileSync, existsSync } from "node:fs";
export default function observe(pi: any) {
	const note = (event: string, payload: unknown) =>
		appendFileSync(process.env.OBSERVED!, JSON.stringify({ event, payload }) + "\\n");
	pi.registerCommand("observe-reload", { description: "reload", handler: async (_args: string, ctx: any) => {
		await ctx.reload();
	} });
	// Keeps the replacement session going until the fixture answered the old session's lookup.
	pi.registerCommand("observe-hold", { description: "hold", handler: async () => {
		const deadline = Date.now() + 10_000;
		while (!existsSync(process.env.RELEASED!) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
		note("held", existsSync(process.env.RELEASED!));
	} });
	pi.events.on("model-upstreams", () => note("routes", null));
	// What /model's picker shows: every catalog refreshed, then the available models.
	pi.registerCommand("observe-picker", { description: "picker", handler: async (_args: string, ctx: any) => {
		await ctx.modelRegistry.runtime.refresh({ signal: AbortSignal.timeout(20_000) });
		note("picker", ctx.modelRegistry.getAvailable().map((m: any) => m.provider + "/" + m.id));
	} });
	// What /login's dialog does (pi's modelRuntime.login), answering its prompts: \`<provider> [oauth|api_key]\`, the
	// method being "Sign in with an account" or "Sign in with an API key".
	pi.registerCommand("observe-login", { description: "login", handler: async (args: string, ctx: any) => {
		const [provider, method = "oauth"] = args.trim().split(" ");
		const interaction = {
			signal: AbortSignal.timeout(20_000),
			prompt: async (prompt: any) => (/URL/.test(prompt.message) ? process.env.LOGIN_URL : process.env.LOGIN_KEY),
			notify: () => {},
		};
		try {
			const credential = await ctx.modelRegistry.runtime.login(provider, method, interaction);
			note("login", credential.type);
		} catch (error) {
			note("login", String(error));
		}
		await ctx.modelRegistry.runtime.refresh({ signal: AbortSignal.timeout(20_000) });
		note("picker", ctx.modelRegistry.getAvailable().map((m: any) => m.provider + "/" + m.id));
	} });
	pi.on("session_start", (event: any, ctx: any) => {
		note("start", { reason: event.reason, model: ctx.model?.id, level: pi.getThinkingLevel() });
		if (process.env.ASK_ROUTES) pi.events.emit("model-upstreams:request", {});
	});
	pi.on("session_shutdown", (event: any) => note("shutdown", event.reason));
	// Another provider with a key, when the case asks for one: what pi falls back to if Provimux is not configured.
	if (process.env.OTHER_URL) {
		pi.registerProvider("other-fixture", {
			baseUrl: process.env.OTHER_URL,
			apiKey: "other-key",
			api: "openai-completions",
			models: [{ id: "other-model", name: "other-model", reasoning: false, input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
		});
	}
}
`;

/** Loaded into each pi before anything else: no socket to the owner's proxy or its neighbour. */
const NETWORK_GUARD = `const net = require("node:net");
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
	const first = Array.isArray(args[0]) ? args[0][0] : args[0];
	const port = typeof first === "object" && first !== null ? first.port : first;
	if (String(port) === "8317" || String(port) === "8787") throw new Error("refused: the owner's proxy port");
	return connect.apply(this, args);
};
`;

interface FixtureModel {
	slug: string;
	levels: string[];
	owner: string;
	provider?: string;
	host?: string;
	effortUpdates?: boolean;
}

const MODELS: FixtureModel[] = [
	{ slug: "nemotron-3-5-super", levels: ["medium", "high"], owner: "nvidia", host: "integrate.api.nvidia.com" },
	{ slug: "claude-opus-5-5", levels: ["low", "medium", "high"], owner: "anthropic", provider: "claude" },
	{ slug: "local-assistant:high", levels: [], owner: "community", host: "api.example.test" },
	{
		slug: "gpt-catalog-fixture",
		levels: ["low", "medium", "high"],
		owner: "openai",
		host: "api.openai.com",
		effortUpdates: true,
	},
];

interface SentRequest {
	path: string;
	model: string;
	/** The credential the request carried (`Authorization`, or Claude's `x-api-key`). */
	key?: string;
	/** The `X-Fixture-Tenant` header, which only a models.json override sends. */
	tenant?: string;
	effort?: string;
	updates: string[];
	status: number;
	/** The headers that name a conversation, as sent (pi's Claude format: x-session-affinity; its Codex format: session-id). */
	session?: Record<string, string>;
	/** A session-route request's body. */
	body?: unknown;
}

const SESSION_HEADERS = ["x-session-affinity", "session-id", "x-session-id", "x-client-request-id"];
const sessionHeaders = (req: IncomingMessage): Record<string, string> =>
	Object.fromEntries(
		SESSION_HEADERS.flatMap((name) => (typeof req.headers[name] === "string" ? [[name, req.headers[name]]] : [])),
	);
/** What the session-route paths answer (a contract example), when a case sets it; else they are not there (404). */
let sessionRoute: unknown;

let models: FixtureModel[] = [];
let requests: SentRequest[] = [];
/** Holds the first credential-list request after the session started until the condition on the run's events holds. */
let holdAccounts: { taken?: boolean; until: (events: Observed[]) => boolean } | undefined;
let run: { events: string; released: string } | undefined;

interface Observed {
	event: string;
	payload: any;
}

const observed = (file: string): Observed[] =>
	existsSync(file)
		? readFileSync(file, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Observed)
		: [];

function modelsBody(url: URL) {
	if (url.searchParams.has("client_version"))
		return {
			models: models.map((m) => ({
				slug: m.slug,
				display_name: m.slug,
				input_modalities: ["text"],
				context_window: 160_000,
				max_tokens: 2000,
				...(m.effortUpdates ? { supports_reasoning_effort_updates: true } : {}),
				supported_reasoning_levels: m.levels.map((effort) => ({ effort })),
			})),
		};
	return {
		object: "list",
		data: models.map((m) => ({
			id: m.slug,
			object: "model",
			owned_by: m.owner,
			accounts: [
				m.provider
					? { provider: m.provider, kind: "oauth", priority: 0 }
					: { provider: "openai-compatibility", kind: "apikey", host: m.host, priority: 0 },
			],
		})),
	};
}

function frames(id: string, claude: boolean, model: string) {
	const item = { id: `msg${id}`, type: "message", role: "assistant", status: "completed" };
	return claude
		? [
				{
					type: "message_start",
					message: {
						id,
						type: "message",
						role: "assistant",
						model,
						content: [],
						stop_reason: null,
						usage: { input_tokens: 3, output_tokens: 0 },
					},
				},
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fixture-ok" } },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
				{ type: "message_stop" },
			]
		: [
				{ type: "response.created", response: { id, status: "in_progress" } },
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { ...item, content: [], status: "in_progress" },
				},
				{
					type: "response.content_part.added",
					item_id: item.id,
					output_index: 0,
					content_index: 0,
					part: { type: "output_text", text: "" },
				},
				{
					type: "response.output_text.delta",
					item_id: item.id,
					output_index: 0,
					content_index: 0,
					delta: "fixture-ok",
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { ...item, content: [{ type: "output_text", text: "fixture-ok", annotations: [] }] },
				},
				{
					type: "response.completed",
					response: {
						id,
						status: "completed",
						output: [],
						usage: {
							input_tokens: 3,
							output_tokens: 1,
							total_tokens: 4,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			];
}

/** The credential list, held while the run's events do not yet meet the condition (or until pi hangs up). */
async function answerAccounts(req: IncomingMessage, res: ServerResponse, url: URL) {
	const current = run;
	// The model list's own sources come before the session starts: only the session's lookup is held.
	const held =
		holdAccounts && !holdAccounts.taken && current && observed(current.events).some((e) => e.event === "start")
			? holdAccounts
			: undefined;
	if (held) held.taken = true;
	if (held && current) {
		let closed = false;
		res.on("close", () => {
			closed = true;
		});
		const deadline = Date.now() + 20_000;
		while (!closed && !held.until(observed(current.events)) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		if (closed || res.destroyed) {
			writeFileSync(current.released, "aborted");
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(modelsBody(url)), () => writeFileSync(current.released, "answered"));
		return;
	}
	void req;
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify(modelsBody(url)));
}

async function serve(req: IncomingMessage, res: ServerResponse) {
	const url = new URL(req.url ?? "/", "http://fixture");
	if (url.pathname === "/v1/models") {
		if (url.searchParams.get("include") === "accounts") return answerAccounts(req, res, url);
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(modelsBody(url)));
		return;
	}
	if (url.pathname.startsWith("/v1/provimux/session-route")) {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const authorization = req.headers.authorization;
		requests.push({
			path: url.pathname,
			model: "",
			key: typeof authorization === "string" ? authorization.replace(/^Bearer\s+/i, "") : undefined,
			updates: [],
			status: sessionRoute ? 200 : 404,
			session: sessionHeaders(req),
			body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
		});
		res.writeHead(sessionRoute ? 200 : 404, { "content-type": "application/json" });
		res.end(sessionRoute ? JSON.stringify(sessionRoute) : "");
		return;
	}
	const claude = url.pathname.endsWith("/messages");
	if (url.pathname.startsWith("/other/")) {
		// The other provider's endpoint: recorded, never answered.
		requests.push({ path: url.pathname, model: "", updates: [], status: 500 });
		res.writeHead(500, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "the other provider's fixture" } }));
		return;
	}
	if (!claude && !url.pathname.endsWith("/responses")) {
		res.writeHead(404);
		res.end("{}");
		return;
	}
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const raw = Buffer.concat(chunks);
	const encoding = req.headers["content-encoding"];
	const body = JSON.parse(
		(encoding === "zstd" ? zstdDecompressSync(raw) : encoding === "gzip" ? gunzipSync(raw) : raw).toString("utf8"),
	) as { model: string; reasoning?: { effort?: string }; input?: Array<{ type?: string; reasoning?: any }> };
	const model = models.find((m) => m.slug === body.model);
	const effort = body.reasoning?.effort;
	const updates = (body.input ?? [])
		.filter((item) => item?.type === "configuration_update")
		.map((item) => item.reasoning?.effort as string);
	// As the review's fixture: a level the model does not list is a 400.
	const unsupported =
		!claude &&
		!!model?.effortUpdates &&
		[effort, ...updates].some((value) => value !== undefined && !model.levels.includes(value));
	const authorization = req.headers.authorization ?? req.headers["x-api-key"];
	const key = typeof authorization === "string" ? authorization.replace(/^Bearer\s+/i, "") : undefined;
	const tenant = typeof req.headers["x-fixture-tenant"] === "string" ? req.headers["x-fixture-tenant"] : undefined;
	requests.push({
		path: url.pathname,
		model: body.model,
		key,
		tenant,
		effort,
		updates,
		status: unsupported ? 400 : 200,
		session: sessionHeaders(req),
	});
	if (unsupported) {
		res.writeHead(400, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "fixture rejected an unsupported reasoning effort" } }));
		return;
	}
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"X-CPA-AUTH-KIND": model?.provider ? "oauth" : "apikey",
		"X-CPA-AUTH-PROVIDER": model?.provider ?? "openai-compatibility",
		...(model?.host ? { "X-CPA-AUTH-HOST": model.host } : {}),
	});
	const id = `r${requests.length}`;
	res.end(
		frames(id, claude, body.model)
			.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)
			.join(""),
	);
}

let server: Server;
/** A second proxy, B: answers as the first does, and logs every request it gets (the model list too) with its key. */
let serverB: Server;
let originB: string;
let atB: Array<{ path: string; key?: string }> = [];
let origin: string;
let root: string;
let agentDir: string;
let home: string;
let project: string;
let guard: string;
let observer: string;

beforeAll(async () => {
	server = createServer((req, res) => {
		serve(req, res).catch(() => res.destroy());
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	if (port === 8317 || port === 8787) throw new Error("the fixture got a reserved port");
	origin = `http://127.0.0.1:${port}`;
	serverB = createServer((req, res) => {
		const authorization = req.headers.authorization ?? req.headers["x-api-key"];
		atB.push({
			path: (req.url ?? "/").split("?")[0],
			key: typeof authorization === "string" ? authorization.replace(/^Bearer\s+/i, "") : undefined,
		});
		serve(req, res).catch(() => res.destroy());
	});
	await new Promise<void>((resolve) => serverB.listen(0, "127.0.0.1", resolve));
	const portB = (serverB.address() as AddressInfo).port;
	if (portB === 8317 || portB === 8787) throw new Error("the fixture got a reserved port");
	originB = `http://127.0.0.1:${portB}`;
});

afterAll(async () => {
	for (const one of [server, serverB]) {
		one.closeAllConnections();
		await new Promise((resolve) => one.close(resolve));
	}
});

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-provimux-cli-"));
	agentDir = join(root, "agent");
	home = join(root, "home");
	project = join(root, "project");
	for (const dir of [agentDir, home, project]) mkdirSync(dir, { recursive: true });
	guard = join(root, "network-guard.cjs");
	observer = join(root, "observer.ts");
	writeFileSync(guard, NETWORK_GUARD);
	writeFileSync(observer, OBSERVER);
	writeFileSync(
		join(agentDir, "provimux.json"),
		JSON.stringify({ baseUrl: origin, apiKey: "fixture-only", claudeMessages: "auto" }),
	);
	models = MODELS.map((m) => ({ ...m, levels: [...m.levels] }));
	requests = [];
	holdAccounts = undefined;
	sessionRoute = undefined;
});

afterEach(() => {
	run = undefined;
	rmSync(root, { recursive: true, force: true });
});

interface Run {
	code: number | null;
	stdout: string;
	stderr: string;
	requests: SentRequest[];
	events: Observed[];
	/** RPC responses by command id (`c0`, `c1`, …). */
	responses: Record<string, any>;
}

/** One pi CLI run, with this extension and the observer, in the test's agent directory and home. */
async function pi(
	args: string[],
	options: {
		askRoutes?: boolean;
		env?: Record<string, string>;
		/** RPC commands, sent on stdin (`--mode rpc` among the args); pi is stopped once each has its response. */
		rpc?: Array<Record<string, unknown>>;
	} = {},
): Promise<Run> {
	const label = `run${Math.random().toString(36).slice(2, 8)}`;
	run = { events: join(root, `${label}.events`), released: join(root, `${label}.released`) };
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (/^(PI_|PROVIMUX_|VITEST|NODE_OPTIONS$)/.test(name)) continue;
		env[name] = value;
	}
	Object.assign(env, {
		HOME: home,
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PROVIMUX_TRANSPORT: "sse",
		NODE_OPTIONS: `--require=${guard}`,
		OBSERVED: run.events,
		RELEASED: run.released,
		// Only the lifecycle cases ask for the routes: in the others a lookup's late answer is not what is tested.
		...(options.askRoutes ? { ASK_ROUTES: "1" } : {}),
		...options.env,
	});
	const first = requests.length;
	const child = spawn(process.execPath, [PI_CLI, "-e", EXTENSION, "-e", observer, "--no-tools", ...args], {
		cwd: project,
		env,
		stdio: [options.rpc ? "pipe" : "ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	const responses: Record<string, any> = {};
	if (options.rpc) {
		const commands = options.rpc.map((command, index) => ({ id: `c${index}`, ...command }));
		child.stdin!.write(commands.map((command) => `${JSON.stringify(command)}\n`).join(""));
		let pending = "";
		child.stdout!.on("data", (chunk) => {
			pending += chunk;
			for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
				const line = pending.slice(0, end);
				pending = pending.slice(end + 1);
				try {
					const message = JSON.parse(line);
					if (message?.type === "response" && typeof message.id === "string") responses[message.id] = message;
				} catch {
					// Not a JSON line.
				}
			}
			if (commands.every((command) => responses[command.id])) child.kill("SIGTERM");
		});
	}
	child.stdout!.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr!.on("data", (chunk) => {
		stderr += chunk;
	});
	const code = await new Promise<number | null>((resolve, reject) => {
		const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
		child.once("error", reject);
		child.once("close", (exitCode) => {
			clearTimeout(timer);
			resolve(exitCode);
		});
	});
	return { code, stdout, stderr, requests: requests.slice(first), events: observed(run.events), responses };
}

const STALE = "is stale after session replacement or reload";
const said = (result: Run) => `exit ${result.code}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}`;

describe("pi's CLI with this extension, against a fixture proxy", { timeout: 120_000 }, () => {
	it("pi -p quits while the credential list is still on its way: the late list ends nothing, exit 0", async () => {
		// The list is answered only once the session has shut down (the review's 800 ms delay, as an event).
		holdAccounts = { until: (events) => events.some((e) => e.event === "shutdown") };
		const result = await pi(["-p", "--no-session", "--model", NEMOTRON, "--thinking", "medium", "ok"], {
			askRoutes: true,
		});
		expect(result.code, said(result)).toBe(0);
		expect(result.stdout).toContain("fixture-ok");
		expect(result.stderr).not.toContain(STALE);
		expect(result.events.filter((e) => e.event === "shutdown").map((e) => e.payload)).toEqual(["quit"]);
		expect(result.requests.map((r) => r.model)).toEqual(["nemotron-3-5-super"]);
	});

	it("/reload while the old session's lookup is out: its late answer is dropped, the new session goes on", async () => {
		// The first session's list is answered once the replacement session has started; /observe-hold keeps that
		// session going until then, and the second prompt follows.
		holdAccounts = { until: (events) => events.filter((e) => e.event === "start").length >= 2 };
		const result = await pi(
			["-p", "--no-session", "--model", CLAUDE, "first", "/observe-reload", "/observe-hold", "second"],
			{ askRoutes: true },
		);
		expect(result.code, said(result)).toBe(0);
		expect(result.stderr).not.toContain(STALE);
		expect(result.events.filter((e) => e.event === "held").map((e) => e.payload)).toEqual([true]);
		expect(result.requests.map((r) => r.path)).toEqual(["/v1/messages", "/v1/messages"]);
		expect(result.events.filter((e) => e.event === "start").map((e) => e.payload.reason)).toEqual([
			"startup",
			"reload",
		]);
		// The replacement session's own lookup was answered and told.
		expect(result.events.filter((e) => e.event === "routes")).toHaveLength(1);
	});

	it("--model with a literal id ending in :high selects that model, sends it, exit 0", async () => {
		const result = await pi(["-p", "--no-session", "--model", LITERAL, "ok"]);
		expect(result.code, said(result)).toBe(0);
		expect(result.stderr).not.toContain("has no thinking level");
		expect(result.requests.map((r) => r.model)).toEqual(["local-assistant:high"]);
	});

	it("a level the model lacks, asked as a --model suffix or pinned in --models: refused, nothing sent, exit 1", async () => {
		for (const args of [
			["--model", `${NEMOTRON}:low`],
			["--models", `${NEMOTRON}:low`],
			["--model", NEMOTRON, "--thinking", "low"],
		]) {
			const result = await pi(["-p", "--no-session", ...args, "ok"]);
			expect(result.code, said(result)).toBe(1);
			const asked = args[0] === "--thinking" || args.includes("--thinking") ? "--thinking low" : args.join(" ");
			expect(result.stderr).toContain(`has no thinking level "low" (asked with ${asked})`);
			expect(result.requests).toEqual([]);
		}
		// A level it has, pinned in --models: sent as it is.
		const allowed = await pi(["-p", "--no-session", "--models", `${NEMOTRON}:high`, "ok"]);
		expect(allowed.code, said(allowed)).toBe(0);
		expect(allowed.requests.map((r) => r.effort)).toEqual(["high"]);
	});

	it("a Claude-format model names its conversation by the session's id, a Codex one as before; /provimux-route names it the same way", async () => {
		const session = ["--session-id", "route-fixture-1"];
		const claude = await pi([...session, "--model", CLAUDE, "-p", "say hi"]);
		expect(claude.code, said(claude)).toBe(0);
		expect(claude.requests.map((r) => [r.path, r.session])).toEqual([
			["/v1/messages", { "x-session-affinity": "route-fixture-1" }],
		]);
		// The Codex format already named it; nothing is added there.
		const codex = await pi([...session, "--model", CODEX, "-p", "say hi"]);
		expect(codex.code, said(codex)).toBe(0);
		expect(codex.requests.map((r) => [r.path, r.session])).toEqual([
			[
				"/backend-api/codex/responses",
				{ "session-id": "route-fixture-1", "x-client-request-id": "route-fixture-1" },
			],
		]);

		// The command, in pi's RPC mode, asks with the header the conversation's turns carry.
		sessionRoute = { ...FELL_BACK, model: "claude-opus-5-5" };
		const shown = await pi([...session, "--model", CLAUDE, "--mode", "rpc"], {
			rpc: [{ type: "prompt", message: "/provimux-route" }],
		});
		expect(shown.requests.map((r) => [r.path, r.session, r.body])).toEqual([
			["/v1/provimux/session-route", { "x-session-affinity": "route-fixture-1" }, { model: "claude-opus-5-5" }],
		]);
		const notes = shown.stdout.split("\n").flatMap((line) => {
			try {
				const message = JSON.parse(line);
				return message?.type === "extension_ui_request" && message.method === "notify" ? [message.message] : [];
			} catch {
				return [];
			}
		});
		expect(shown.requests[0]?.key).toBe("fixture-only");
		expect(
			notes.some((note: string) =>
				note.startsWith(
					"Route of this conversation on claude-opus-5-5, as Provimux says now (this check sends nothing to a model and costs nothing):\n• Now on: Anthropic api, since ",
				),
			),
		).toBe(true);

		// A key given on the command line is the one the model's turns use, so the command asks with it too.
		const keyed = await pi([...session, "--model", CLAUDE, "--api-key", "cli-given-key", "--mode", "rpc"], {
			rpc: [{ type: "prompt", message: "/provimux-route" }],
		});
		expect(keyed.requests.map((r) => [r.path, r.key])).toEqual([["/v1/provimux/session-route", "cli-given-key"]]);

		// A release in RPC mode: nothing is sent, and it says why.
		const release = await pi([...session, "--model", CLAUDE, "--mode", "rpc"], {
			rpc: [{ type: "prompt", message: "/provimux-route release" }],
		});
		expect(release.requests).toEqual([]);
		expect(release.stdout).toContain(
			"Nothing was released: /provimux-route release asks before it moves the conversation",
		);

		// A Provimux without the paths: the command says so, and nothing else is sent.
		sessionRoute = undefined;
		const old = await pi([...session, "--model", CLAUDE, "--mode", "rpc"], {
			rpc: [{ type: "prompt", message: "/provimux-route" }],
		});
		expect(old.requests.map((r) => [r.path, r.status])).toEqual([["/v1/provimux/session-route", 404]]);
		expect(old.stdout).toContain("This server has no conversation routes: /provimux-route needs Provimux");
	});

	it("the session's id, and so what names the conversation, on a resume, a compaction and a fork", async () => {
		const session = ["--session-id", "route-life-1"];
		const turn = async (args: string[], text: string) => {
			const sent = await pi([...args, "--model", CLAUDE, "-p", text]);
			expect(sent.code, said(sent)).toBe(0);
			return sent.requests.map((r) => r.session?.["x-session-affinity"]);
		};
		expect(await turn(session, "one")).toEqual(["route-life-1"]);
		// A resume: the same session, the same id.
		expect(await turn(session, "two")).toEqual(["route-life-1"]);

		// A compaction: pi's summary request carries no session id (pi sends it without cache and under a routing id of
		// its own, which the Claude format does not send); the conversation's next turn has the same id as before.
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 0 } }));
		const compacted = await pi([...session, "--model", CLAUDE, "--mode", "rpc"], { rpc: [{ type: "compact" }] });
		expect(compacted.responses.c0?.success, said(compacted)).toBe(true);
		expect(compacted.requests.length).toBeGreaterThan(0);
		for (const request of compacted.requests) expect([request.path, request.session]).toEqual(["/v1/messages", {}]);
		expect(await turn(session, "three")).toEqual(["route-life-1"]);

		// A fork: a new session, with a new id.
		const forked = await turn(["--fork", "route-life-1"], "four");
		expect(forked).toHaveLength(1);
		expect(forked[0]).toMatch(/^[0-9a-f-]{36}$/);
		expect(forked[0]).not.toBe("route-life-1");
	});

	it("a Codex conversation resumed after a refresh took its first level away: no level it lacks is sent", async () => {
		const sessions = ["--session-dir", join(root, "sessions")];
		const first = await pi([...sessions, "--model", CODEX, "-p", "--thinking", "low", "first"]);
		expect(first.code, said(first)).toBe(0);
		expect(first.requests.map((r) => r.effort)).toEqual(["low"]);

		// The proxy drops low from the model; the regular refresh command updates the catalog.
		models.find((m) => m.slug === "gpt-catalog-fixture")!.levels = ["medium", "high"];
		const refresh = await pi(["--no-session", "--model", CODEX, "-p", "/provimux-refresh"]);
		expect(refresh.code, said(refresh)).toBe(0);

		const resumed = await pi([...sessions, "--model", CODEX, "-c", "-p", "--thinking", "medium", "second"]);
		expect(resumed.code, said(resumed)).toBe(0);
		expect(resumed.requests).toHaveLength(1);
		expect(resumed.requests[0]).toMatchObject({ effort: "medium", updates: [], status: 200 });

		// And a later change to a level the model has still rides as an update.
		const third = await pi([...sessions, "--model", CODEX, "-c", "-p", "--thinking", "high", "third"]);
		expect(third.code, said(third)).toBe(0);
		expect(third.requests[0]).toMatchObject({ effort: "medium", updates: ["high"], status: 200 });
	});
});

/**
 * The provider id `provimux`, with pi's own CLI: one provider, under the id the extension resolves. The owner's setup
 * holds `providerId: "provimux"` (written by /login), its key and its URL in provimux.json, and nothing in
 * auth.json.
 */
describe("the provider id, in pi's CLI", { timeout: 300_000 }, () => {
	const OPUS = "claude-opus-5-5";
	const GPT = "gpt-catalog-fixture";
	const FILE_KEY = "fixture-file-key";
	const LOGIN_KEY = "fixture-login-key";
	const CONFIG = () => join(agentDir, "provimux.json");
	const AUTH = () => join(agentDir, "auth.json");
	const all = (provider: string) => MODELS.map((m) => `${provider}/${m.slug}`).sort();
	const listed = (result: Run, command = "c0") =>
		((result.responses[command]?.data?.models ?? []) as Array<{ provider: string; id: string }>).map(
			(model) => `${model.provider}/${model.id}`,
		);
	const listRows = (result: Run) =>
		result.stdout.split("\n").filter((line) => MODELS.some((m) => line.split(/\s+/)[1] === m.slug));
	const picker = (result: Run) =>
		result.events.filter((e) => e.event === "picker").map((e) => [...(e.payload as string[])].sort());

	function ownerShaped() {
		writeFileSync(
			CONFIG(),
			`${JSON.stringify({ baseUrl: origin, apiKey: FILE_KEY, providerId: "provimux", claudeMessages: "auto" }, null, 2)}\n`,
		);
	}

	/** The three views of the model list: the picker's, `--list-models`, rpc `get_available_models` (cold, then warm). */
	async function expectOnly(provider: string, env: Record<string, string> = {}) {
		const shown = await pi(["--no-session", "-p", "/observe-picker"], { env });
		expect(shown.code, said(shown)).toBe(0);
		expect(picker(shown), said(shown)).toEqual([all(provider)]);

		const list = await pi(["--list-models"], { env });
		expect(list.code, said(list)).toBe(0);
		const rows = listRows(list);
		expect(rows, said(list)).toHaveLength(MODELS.length);
		expect(rows.map((row) => row.split(/\s+/).slice(0, 2).join("/")).sort()).toEqual(all(provider));
		for (const other of ["provimux", "acme"].filter((id) => id !== provider))
			expect(list.stdout).not.toMatch(new RegExp(`^${other}\\s`, "m"));

		for (const start of ["cold", "warm"]) {
			const rpc = await pi(["--mode", "rpc", "--no-session"], { env, rpc: [{ type: "get_available_models" }] });
			expect(listed(rpc).sort(), `${start}\n${said(rpc)}`).toEqual(all(provider));
		}
		return { shown, list };
	}

	it("the owner's setup (providerId provimux in the file, no auth.json): only provimux, each model once; a prompt reaches the proxy with the file's key", async () => {
		ownerShaped();
		const before = readFileSync(CONFIG());
		const { shown, list } = await expectOnly("provimux");
		captures.push({ name: "owner: picker rows", text: JSON.stringify(picker(shown)[0], null, 1) });
		captures.push({ name: "owner: --list-models", text: list.stdout });

		for (const [id, path] of [
			[GPT, "/backend-api/codex/responses"],
			[OPUS, "/v1/messages"],
		]) {
			const sent = await pi(["--no-session", "--model", `provimux/${id}`, "-p", "say hi"]);
			expect(sent.code, said(sent)).toBe(0);
			expect(sent.stdout).toContain("fixture-ok");
			expect(sent.requests.map((r) => [r.path, r.model, r.key])).toEqual([[path, id, FILE_KEY]]);
		}
		// No --model: pi picks a model, and the only one it can pick from is provimux.
		const picked = await pi(["--no-session", "-p", "say hi"]);
		expect(picked.code, said(picked)).toBe(0);
		expect(picked.requests.map((r) => r.key)).toEqual([FILE_KEY]);

		// Nothing was rewritten, and no login appeared.
		expect(readFileSync(CONFIG()).equals(before)).toBe(true);
		// pi creates an empty auth.json itself; nothing is stored in it.
		expect(existsSync(AUTH()) ? Object.keys(JSON.parse(readFileSync(AUTH(), "utf8"))) : []).toEqual([]);
	});

	it("PROVIMUX_PROVIDER_ID=acme wins over the file: only acme, and acme/<id> answers", async () => {
		ownerShaped();
		const env = { PROVIMUX_PROVIDER_ID: "acme" };
		const { list } = await expectOnly("acme", env);
		captures.push({ name: "PROVIMUX_PROVIDER_ID=acme: --list-models", text: list.stdout });
		const sent = await pi(["--no-session", "--model", `acme/${GPT}`, "-p", "say hi"], { env });
		expect(sent.code, said(sent)).toBe(0);
		expect(sent.requests.map((r) => [r.model, r.key])).toEqual([[GPT, FILE_KEY]]);
	});

	it("a fresh /login with no provimux.json: saved under provimux, and only provimux is shown", async () => {
		rmSync(CONFIG());
		const empty = await pi(["--mode", "rpc", "--no-session"], { rpc: [{ type: "get_available_models" }] });
		expect(listed(empty), said(empty)).toEqual([]);

		const login = await pi(["--no-session", "-p", "/observe-login provimux"], {
			env: { LOGIN_URL: origin, LOGIN_KEY },
		});
		expect(login.code, said(login)).toBe(0);
		expect(login.events.filter((e) => e.event === "login").map((e) => e.payload)).toEqual(["oauth"]);
		expect(picker(login), said(login)).toEqual([all("provimux")]);

		const config = JSON.parse(readFileSync(CONFIG(), "utf8"));
		expect(config).toMatchObject({
			baseUrl: origin,
			apiKey: LOGIN_KEY,
			providerId: "provimux",
			providerName: "Provimux",
		});
		expect(Object.keys(JSON.parse(readFileSync(AUTH(), "utf8")))).toEqual(["provimux"]);
		captures.push({
			name: "fresh /login: provimux.json",
			text: JSON.stringify({ ...config, baseUrl: "<fixture>" }, null, 2),
		});

		await expectOnly("provimux");
		const sent = await pi(["--no-session", "--model", `provimux/${OPUS}`, "-p", "say hi"]);
		expect(sent.code, said(sent)).toBe(0);
		expect(sent.requests.map((r) => [r.model, r.key])).toEqual([[OPUS, LOGIN_KEY]]);
	});

	for (const method of ["oauth"]) {
		it("/login provimux, an account: works after a restart, and a saved default and a session stay on Provimux with another provider logged in", async () => {
			// The file holds a key and no login is stored: pi's /login provimux offers both methods.
			writeFileSync(CONFIG(), JSON.stringify({ baseUrl: origin, apiKey: FILE_KEY }));
			const env = { OTHER_URL: `${origin}/other/v1` };
			const login = await pi(
				["--no-session", "--model", `provimux/${GPT}`, "-p", `/observe-login provimux ${method}`],
				{
					env: { ...env, LOGIN_URL: origin, LOGIN_KEY },
				},
			);
			expect(
				login.events.filter((e) => e.event === "login").map((e) => e.payload),
				said(login),
			).toEqual([method]);
			expect(JSON.parse(readFileSync(AUTH(), "utf8")).provimux?.type).toBe(method);

			// A restart, with the model named.
			const named = await pi(["--no-session", "--model", `provimux/${GPT}`, "-p", "say hi"], { env });
			expect(named.code, said(named)).toBe(0);
			expect(named.requests.map((r) => [r.path, r.key])).toEqual([["/backend-api/codex/responses", LOGIN_KEY]]);

			// A saved default, with no --model.
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ defaultProvider: "provimux", defaultModel: GPT }),
			);
			const saved = await pi(["--no-session", "-p", "say hi"], { env });
			expect(saved.code, said(saved)).toBe(0);
			expect(saved.requests.map((r) => [r.path, r.model, r.key])).toEqual([
				["/backend-api/codex/responses", GPT, LOGIN_KEY],
			]);

			// A session on provimux/<id>, resumed.
			const sessions = ["--session-dir", join(root, `sessions-${method}`)];
			const first = await pi([...sessions, "--model", `provimux/${OPUS}`, "-p", "first"], { env });
			expect(
				first.requests.map((r) => [r.model, r.key]),
				said(first),
			).toEqual([[OPUS, LOGIN_KEY]]);
			const resumed = await pi([...sessions, "-c", "-p", "second"], { env });
			expect(resumed.code, said(resumed)).toBe(0);
			expect(resumed.stderr).not.toContain("Could not restore");
			expect(resumed.requests.map((r) => [r.model, r.key])).toEqual([[OPUS, LOGIN_KEY]]);
		});
	}

	it('an API-key login (pi\'s "Sign in with an API key") does not survive a restart, as in 105.0.4', async () => {
		writeFileSync(CONFIG(), JSON.stringify({ baseUrl: origin, apiKey: FILE_KEY }));
		const login = await pi(["--no-session", "--model", `provimux/${GPT}`, "-p", "/observe-login provimux api_key"], {
			env: { LOGIN_KEY },
		});
		expect(
			login.events.filter((e) => e.event === "login").map((e) => e.payload),
			said(login),
		).toEqual(["api_key"]);
		const restarted = await pi(["--no-session", "--model", `provimux/${GPT}`, "-p", "say hi"]);
		expect(restarted.code, said(restarted)).toBe(1);
		// pi words this failure in one of two ways (macOS and Linux differ): either says provimux has no usable key.
		expect(restarted.stderr, said(restarted)).toMatch(
			/Provider is not configured: provimux\b|No API key found for "?provimux\b/,
		);
		expect(restarted.requests).toEqual([]);
	});

	it("an API-key login at proxy A, then proxy B's URL and key in the environment or the file: B never gets A's key", async () => {
		const B_KEY = "fixture-b-key";
		// The login: at A, with a key A alone knows.
		writeFileSync(CONFIG(), JSON.stringify({ baseUrl: origin, apiKey: FILE_KEY }));
		const login = await pi(["--no-session", "--model", `provimux/${GPT}`, "-p", "/observe-login provimux api_key"], {
			env: { LOGIN_KEY },
		});
		expect(
			login.events.filter((e) => e.event === "login").map((e) => e.payload),
			said(login),
		).toEqual(["api_key"]);
		const config = readFileSync(CONFIG());
		for (const [how, env] of [
			["environment", { PROVIMUX_BASE_URL: originB, PROVIMUX_API_KEY: B_KEY }],
			["file", {}],
		] as const) {
			if (how === "file") writeFileSync(CONFIG(), JSON.stringify({ baseUrl: originB, apiKey: B_KEY }));
			else writeFileSync(CONFIG(), config);
			atB = [];
			const sent = await pi(["--no-session", "--model", `provimux/${GPT}`, "-p", "say hi"], { env });
			// B was asked (its model list, with its own key), and never with A's key.
			expect(atB.length, `${how}\n${said(sent)}`).toBeGreaterThan(0);
			expect(
				atB.filter((r) => r.path === "/v1/models").map((r) => r.key),
				how,
			).toContain(B_KEY);
			expect(
				atB.filter((r) => r.key === LOGIN_KEY),
				`${how}: requests at B with A's key\n${said(sent)}`,
			).toEqual([]);
		}
	});

	it("settings, --provider, models.json under provimux", async () => {
		ownerShaped();
		const env = { OTHER_URL: `${origin}/other/v1` };
		// settings.json: a default (provider and model apart), and a scope.
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "provimux", defaultModel: GPT, enabledModels: [`provimux/${GPT}`] }),
		);
		// models.json: a block under provimux applies to its models.
		const overrides = { modelOverrides: { [GPT]: { headers: { "X-Fixture-Tenant": "t1" }, contextWindow: 99000 } } };
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { provimux: overrides } }));
		const moved = await pi(["--no-session", "-p", "say hi"], { env });
		expect(moved.code, said(moved)).toBe(0);
		expect(moved.stderr).not.toContain("No models match pattern");
		expect(moved.requests.map((r) => [r.model, r.key, r.tenant])).toEqual([[GPT, FILE_KEY, "t1"]]);
		const list = await pi(["--list-models"]);
		expect(
			listRows(list).find((row) => row.includes(GPT)),
			said(list),
		).toMatch(/\b99K\b/);

		// --provider needs --model; with it, the id alone names the model.
		const alone = await pi(["--no-session", "--provider", "provimux", "-p", "say hi"], { env });
		expect(alone.code).not.toBe(0);
		expect(alone.stderr).toContain("--provider requires --model");
		const both = await pi(["--no-session", "--provider", "provimux", "--model", OPUS, "-p", "say hi"], { env });
		expect(both.code, said(both)).toBe(0);
		expect(both.requests.map((r) => r.model)).toEqual([OPUS]);
	});
});

/** What the provider-id cases saw, for the review: written when CAPTURE_DIR is set. */
const captures: Array<{ name: string; text: string }> = [];
afterAll(() => {
	const dir = process.env.CAPTURE_DIR;
	if (!dir || captures.length === 0) return;
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `cli-captures-${process.env.CAPTURE_LABEL ?? "run"}.txt`),
		captures.map((c) => `### ${c.name}\n${c.text.replaceAll(origin, "<fixture>")}\n`).join("\n"),
	);
});
