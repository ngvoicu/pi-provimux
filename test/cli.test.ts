/**
 * pi's own CLI, with this extension loaded, against a fixture proxy: the release review's cases, run on
 * whichever pi the tests have installed (1.3.0 from package-lock.json, 1.6.0 in CI's second pass).
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

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXTENSION = join(ROOT, "extensions", "index.ts");
const PI_CLI = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const NEMOTRON = "cliproxyapi/nemotron-3-5-super";
const CLAUDE = "cliproxyapi/claude-opus-5-5";
const LITERAL = "cliproxyapi/local-assistant:high";
const CODEX = "cliproxyapi/gpt-catalog-fixture";

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
	pi.on("session_start", (event: any, ctx: any) => {
		note("start", { reason: event.reason, model: ctx.model?.id, level: pi.getThinkingLevel() });
		if (process.env.ASK_ROUTES) pi.events.emit("model-upstreams:request", {});
	});
	pi.on("session_shutdown", (event: any) => note("shutdown", event.reason));
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
	effort?: string;
	updates: string[];
	status: number;
}

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
	const claude = url.pathname.endsWith("/messages");
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
	requests.push({ path: url.pathname, model: body.model, effort, updates, status: unsupported ? 400 : 200 });
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
});

afterAll(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
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
		join(agentDir, "cliproxyapi.json"),
		JSON.stringify({ baseUrl: origin, apiKey: "fixture-only", claudeMessages: "auto" }),
	);
	models = MODELS.map((m) => ({ ...m, levels: [...m.levels] }));
	requests = [];
	holdAccounts = undefined;
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
}

/** One pi CLI run, with this extension and the observer, in the test's agent directory and home. */
async function pi(args: string[], options: { askRoutes?: boolean } = {}): Promise<Run> {
	const label = `run${Math.random().toString(36).slice(2, 8)}`;
	run = { events: join(root, `${label}.events`), released: join(root, `${label}.released`) };
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (/^(PI_|CLIPROXYAPI_|VITEST|NODE_OPTIONS$)/.test(name)) continue;
		env[name] = value;
	}
	Object.assign(env, {
		HOME: home,
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		CLIPROXYAPI_TRANSPORT: "sse",
		NODE_OPTIONS: `--require=${guard}`,
		OBSERVED: run.events,
		RELEASED: run.released,
		// Only the lifecycle cases ask for the routes: in the others a lookup's late answer is not what is tested.
		...(options.askRoutes ? { ASK_ROUTES: "1" } : {}),
	});
	const first = requests.length;
	const child = spawn(process.execPath, [PI_CLI, "-e", EXTENSION, "-e", observer, "--no-tools", ...args], {
		cwd: project,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
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
	return { code, stdout, stderr, requests: requests.slice(first), events: observed(run.events) };
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
