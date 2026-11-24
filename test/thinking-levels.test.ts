/**
 * A thinking level the model does not have: refused in a one-shot run, moved by pi everywhere else, and never sent.
 *
 * The model is a Devin-like one whose catalog lists only medium and high (Nemotron's case).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import {
	type Api,
	type AssistantMessageEvent,
	type Context,
	type Model,
	clampThinkingLevel as piClamp,
	getSupportedThinkingLevels as piSupported,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { resolveCliModel, resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	CLIPROXYAPI_CODEX_API,
	type CliproxyCodexStreams,
	loadCliproxyCodexStreams,
} from "../extensions/codex-stream.ts";
import { toPiModel } from "../extensions/lib.ts";
import {
	clampThinkingLevel,
	type InputGuardContext,
	literalModelReading,
	PI_LEVELS,
	type PiLevel,
	type PiResolvers,
	piModelReading,
	readCommandLine,
	registerThinkingLevelGuard,
	requestedThinkingLevel,
	supportedThinkingLevels,
	withSupportedEfforts,
	withSupportedLevel,
} from "../extensions/thinking-levels.ts";

const NEMOTRON = {
	slug: "nemotron-3-5-super",
	display_name: "Nemotron 3.5 Super",
	supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }],
};

function nemotron(baseUrl = "http://127.0.0.1:1"): Model<Api> {
	const mapped = toPiModel(NEMOTRON);
	if (!mapped) throw new Error("not mapped");
	return { ...mapped, api: CLIPROXYAPI_CODEX_API, provider: "cliproxyapi", baseUrl } as unknown as Model<Api>;
}

describe("the levels a model has, as pi counts them", () => {
	const shapes: Array<Pick<Model<Api>, "reasoning" | "thinkingLevelMap">> = [
		{ reasoning: true, thinkingLevelMap: nemotron().thinkingLevelMap },
		{
			reasoning: true,
			thinkingLevelMap: toPiModel({ slug: "a", supported_reasoning_levels: ["none", "low"] })!.thinkingLevelMap,
		},
		{
			reasoning: true,
			thinkingLevelMap: toPiModel({ slug: "b", supported_reasoning_levels: ["low", "xhigh", "max"] })!
				.thinkingLevelMap,
		},
		{ reasoning: true, thinkingLevelMap: undefined },
		{ reasoning: false, thinkingLevelMap: undefined },
	];
	it("are pi-ai's own, and so is where a missing one goes", () => {
		for (const shape of shapes) {
			const model = { ...nemotron(), ...shape } as Model<Api>;
			expect(supportedThinkingLevels(model)).toEqual(piSupported(model));
			for (const level of PI_LEVELS) expect(clampThinkingLevel(model, level)).toBe(piClamp(model, level));
		}
	});

	it("Nemotron has medium and high; pi moves low, minimal and off up to medium, xhigh down to high", () => {
		const model = nemotron();
		expect(supportedThinkingLevels(model)).toEqual(["medium", "high"]);
		expect(["off", "minimal", "low", "xhigh", "max"].map((l) => clampThinkingLevel(model, l as PiLevel))).toEqual([
			"medium",
			"medium",
			"medium",
			"high",
			"high",
		]);
	});
});

/** A model whose literal id ends in a level suffix, without adjustable reasoning (the review's `local-assistant:high`). */
function literalSuffixModel(): Model<Api> {
	const mapped = toPiModel({ slug: "local-assistant:high", display_name: "local-assistant:high" });
	if (!mapped) throw new Error("not mapped");
	return {
		...mapped,
		api: CLIPROXYAPI_CODEX_API,
		provider: "cliproxyapi",
		baseUrl: "http://127.0.0.1:1",
	} as Model<Api>;
}

/** The session's models as `ctx.modelRegistry` gives them: the two above. */
function registry(models: Model<Api>[] = [nemotron(), literalSuffixModel()]) {
	return { getAll: () => models, getAvailable: () => models, hasConfiguredAuth: () => true };
}

/** pi's own resolvers, from the pi installed for the tests. */
const piReading = (models?: Model<Api>[]) =>
	piModelReading(registry(models), { resolveCliModel, resolveModelScopeWithDiagnostics } as unknown as PiResolvers);

describe("the level asked on pi's command line", () => {
	const ask = (argv: string[], selected: Model<Api> | undefined = nemotron(), continued = false) =>
		requestedThinkingLevel(readCommandLine(argv), selected, piReading(), { reason: "startup", continued });

	it("is --thinking's, else the :level of --model, read as pi reads them", async () => {
		expect(await ask(["-p", "--model", "cliproxyapi/nemotron-3-5-super", "--thinking", "low", "hi"])).toEqual({
			level: "low",
			asked: "--thinking low",
		});
		expect(await ask(["-p", "--model", "cliproxyapi/nemotron-3-5-super:low", "hi"])).toEqual({
			level: "low",
			asked: "--model cliproxyapi/nemotron-3-5-super:low",
		});
		// pi's fuzzy match takes the suffix too, when the full text matches no model.
		expect((await ask(["--model", "nemotron:minimal"]))?.level).toBe("minimal");
		// --thinking wins over the suffix, as in pi (the suffix then stays part of the model id).
		expect((await ask(["--model", "x:low", "--thinking", "high"]))?.level).toBe("high");
		// The last valid --thinking counts; an invalid one is ignored, as pi ignores it.
		expect((await ask(["--thinking", "low", "--thinking", "bogus"]))?.level).toBe("low");
		expect(await ask(["--model", "openrouter/qwen:free"])).toBeUndefined();
		expect(await ask(["-p", "--", "--thinking", "low"])).toBeUndefined();
		expect(await ask(["-p", "hi"])).toBeUndefined();
	});

	it("is none for a model whose literal id ends in :high; the full id is the model, as pi resolves it", async () => {
		const literal = literalSuffixModel();
		expect(await ask(["-p", "--model", "cliproxyapi/local-assistant:high", "ok"], literal)).toBeUndefined();
		expect(await ask(["-p", "--model", "local-assistant:high", "ok"], literal)).toBeUndefined();
		expect(
			await ask(["-p", "--provider", "cliproxyapi", "--model", "local-assistant:high"], literal),
		).toBeUndefined();
		// Only when the full text is no model and the text without the suffix is, the suffix is a level.
		expect(await ask(["-p", "--model", "cliproxyapi/local-assistant:high:high", "ok"], literal)).toEqual({
			level: "high",
			asked: "--model cliproxyapi/local-assistant:high:high",
		});
	});

	it("is the level of the --models pattern that selected the model, in a new session without --model", async () => {
		expect(await ask(["-p", "--models", "cliproxyapi/nemotron-3-5-super:low", "ok"])).toEqual({
			level: "low",
			asked: "--models cliproxyapi/nemotron-3-5-super:low",
		});
		expect(
			(await ask(["-p", "--models", "cliproxyapi/local-assistant:high,cliproxyapi/nemotron-3-5-super:xhigh"]))
				?.level,
		).toBe("xhigh");
		// The literal id in a scope is the model at no level.
		expect(await ask(["-p", "--models", "cliproxyapi/local-assistant:high"], literalSuffixModel())).toBeUndefined();
		// pi keeps a continued session's model and level; --model and --thinking win over the scope.
		expect(await ask(["-p", "--models", "cliproxyapi/nemotron-3-5-super:low"], nemotron(), true)).toBeUndefined();
		expect(
			await ask([
				"-p",
				"--model",
				"cliproxyapi/nemotron-3-5-super",
				"--models",
				"cliproxyapi/nemotron-3-5-super:low",
			]),
		).toBeUndefined();
		expect((await ask(["--models", "cliproxyapi/nemotron-3-5-super:low", "--thinking", "high"]))?.level).toBe("high");
	});

	it("without pi's resolver: the literal reading, the full id first", async () => {
		const literal = literalModelReading([nemotron(), literalSuffixModel()]);
		const read = (argv: string[], selected: Model<Api>) =>
			requestedThinkingLevel(readCommandLine(argv), selected, literal);
		expect(await read(["--model", "cliproxyapi/local-assistant:high"], literalSuffixModel())).toBeUndefined();
		expect((await read(["--model", "cliproxyapi/nemotron-3-5-super:low"], nemotron()))?.level).toBe("low");
		expect((await read(["--models", "cliproxyapi/nemotron-3-5-super:low"], nemotron()))?.asked).toBe(
			"--models cliproxyapi/nemotron-3-5-super:low",
		);
	});
});

describe("a one-shot run (pi -p) with a level the model lacks", () => {
	type Handler = (event: unknown, ctx: InputGuardContext) => unknown;
	const setUp = (argv: string[]) => {
		const handlers = new Map<string, Handler>();
		const reports: string[] = [];
		registerThinkingLevelGuard(
			{ on: (name: string, handler: Handler) => handlers.set(name, handler) } as never,
			"cliproxyapi",
			argv,
			(m) => reports.push(m),
		);
		const input = handlers.get("input");
		return {
			handlers,
			reports,
			input: (ctx: InputGuardContext) => (input ? input({ type: "input", text: "hi" }, ctx) : undefined),
		};
	};
	const previousExitCode = process.exitCode;
	afterEach(() => {
		process.exitCode = previousExitCode;
	});

	it("is refused, with the levels it has: nothing is sent and the run exits with 1", async () => {
		const { input, reports } = setUp(["-p", "--model", "cliproxyapi/nemotron-3-5-super", "--thinking", "low"]);
		expect(await input({ mode: "print", model: nemotron() })).toEqual({ action: "handled" });
		expect(process.exitCode).toBe(1);
		expect(reports).toEqual([
			'[pi-provimux] cliproxyapi/nemotron-3-5-super has no thinking level "low" (asked with --thinking low); its levels: medium, high. Nothing was sent: run again with --thinking set to one of them.',
		]);
		// A second prompt of the same run is refused too, and said once.
		expect(await input({ mode: "print", model: nemotron() })).toEqual({ action: "handled" });
		expect(reports).toHaveLength(1);
	});

	it("is refused in JSON mode, and when asked as the :level of --model", async () => {
		const { input, reports } = setUp(["--mode", "json", "--model", "cliproxyapi/nemotron-3-5-super:minimal"]);
		expect(await input({ mode: "json", model: nemotron(), modelRegistry: registry() })).toEqual({
			action: "handled",
		});
		expect(reports[0]).toContain('no thinking level "minimal"');
		expect(reports[0]).toContain("its levels: medium, high");
	});

	it("goes ahead with the model whose literal id ends in :high: no level was asked", async () => {
		const { input, reports } = setUp(["-p", "--model", "cliproxyapi/local-assistant:high", "ok"]);
		const ctx = { mode: "print", model: literalSuffixModel(), modelRegistry: registry() };
		expect(await input(ctx)).toEqual({ action: "continue" });
		expect(reports).toEqual([]);
		expect(process.exitCode).toBe(previousExitCode);
	});

	it("is refused when the level came from the --models pattern that selected the model", async () => {
		const { handlers, input, reports } = setUp(["-p", "--models", "cliproxyapi/nemotron-3-5-super:low", "ok"]);
		const ctx = {
			mode: "print",
			model: nemotron(),
			modelRegistry: registry(),
			sessionManager: { getBranch: () => [] },
		};
		await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
		expect(await input(ctx)).toEqual({ action: "handled" });
		expect(process.exitCode).toBe(1);
		expect(reports).toEqual([
			'[pi-provimux] cliproxyapi/nemotron-3-5-super has no thinking level "low" (asked with --models cliproxyapi/nemotron-3-5-super:low); its levels: medium, high. Nothing was sent: run again with --thinking set to one of them.',
		]);
	});

	it("goes ahead with --models in a continued session: pi keeps the session's model and level", async () => {
		const { handlers, input } = setUp(["-p", "-c", "--models", "cliproxyapi/nemotron-3-5-super:low", "ok"]);
		const history = [{ type: "model_change" }, { type: "message" }];
		const ctx = {
			mode: "print",
			model: nemotron(),
			modelRegistry: registry(),
			sessionManager: { getBranch: () => history },
		};
		await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
		expect(await input(ctx)).toEqual({ action: "continue" });
	});

	it("goes ahead with a level the model has, without a level asked, or with another provider's model", async () => {
		expect(await setUp(["-p", "--thinking", "high"]).input({ mode: "print", model: nemotron() })).toEqual({
			action: "continue",
		});
		expect(setUp(["-p", "hi"]).handlers.size).toBe(0);
		expect(setUp(["-p", "--model", "cliproxyapi/nemotron-3-5-super"]).handlers.size).toBe(0);
		const other = { ...nemotron(), provider: "openrouter" } as Model<Api>;
		expect(await setUp(["-p", "--thinking", "low"]).input({ mode: "print", model: other })).toEqual({
			action: "continue",
		});
		expect(process.exitCode).toBe(previousExitCode);
	});

	it("in the TUI and over RPC, pi's own move stays: nothing is refused", async () => {
		const { input, reports } = setUp(["--thinking", "low"]);
		for (const mode of ["tui", "rpc"]) {
			expect(await input({ mode, model: nemotron() })).toEqual({ action: "continue" });
		}
		expect(reports).toEqual([]);
	});
});

describe("withSupportedLevel", () => {
	it("moves only a pi level the model lacks, the way pi does", () => {
		const model = nemotron();
		expect(withSupportedLevel(model, { reasoning: "low" })).toEqual({ reasoning: "medium" });
		expect(withSupportedLevel(model, { reasoningEffort: "xhigh" })).toEqual({ reasoningEffort: "high" });
		const kept = { reasoning: "high" as const, reasoningEffort: "medium" };
		expect(withSupportedLevel(model, kept)).toBe(kept);
		expect(withSupportedLevel(model, { reasoningEffort: "none" })).toEqual({ reasoningEffort: "none" });
		expect(withSupportedLevel(model, undefined)).toBeUndefined();
		const noReasoning = { ...model, reasoning: false } as Model<Api>;
		expect(withSupportedLevel(noReasoning, { reasoning: "high" })).toEqual({ reasoning: undefined });
	});
});

describe("withSupportedEfforts: a Codex body's efforts, recovered from the history, against the model as it is now", () => {
	const update = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });
	const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
	const assistant = { type: "message", role: "assistant", content: [] };

	it("moves a first-turn effort the catalog no longer has, as pi moves the level, and drops an update it makes moot", () => {
		// The review's resumed conversation: first turn at low, low then removed, resumed with --thinking medium.
		const body = {
			reasoning: { effort: "low", summary: "auto" },
			input: [user("1"), assistant, update("medium"), user("2")],
		};
		expect(withSupportedEfforts(nemotron(), body)).toEqual({
			reasoning: { effort: "medium", summary: "auto" },
			input: [user("1"), assistant, user("2")],
		});
	});

	it("moves an update of a removed level, and keeps later changes the model has", () => {
		const body = {
			reasoning: { effort: "medium" },
			input: [user("1"), assistant, update("low"), user("2"), assistant, update("high"), user("3")],
		};
		// low goes up to medium, the effort already in force: said nowhere; high stays.
		expect(withSupportedEfforts(nemotron(), body)).toEqual({
			reasoning: { effort: "medium" },
			input: [user("1"), assistant, user("2"), assistant, update("high"), user("3")],
		});
		const xhigh = { reasoning: { effort: "high" }, input: [user("1"), assistant, update("xhigh"), user("2")] };
		expect(withSupportedEfforts(nemotron(), xhigh)).toEqual({
			reasoning: { effort: "high" },
			input: [user("1"), assistant, user("2")],
		});
	});

	it("returns a body whose efforts the model has as it is, and leaves efforts that are no level alone", () => {
		const body = { reasoning: { effort: "medium" }, input: [user("1"), assistant, update("high"), user("2")] };
		expect(withSupportedEfforts(nemotron(), body)).toBe(body);
		const unknown = { reasoning: { effort: "turbo" }, input: [user("1")] };
		expect(withSupportedEfforts(nemotron(), unknown)).toBe(unknown);
		const plain = { input: [user("1")] };
		expect(withSupportedEfforts(nemotron(), plain)).toBe(plain);
		const noReasoning = { ...nemotron(), reasoning: false } as Model<Api>;
		const low = { reasoning: { effort: "low" } };
		expect(withSupportedEfforts(noReasoning, low)).toBe(low);
	});
});

describe("over the wire, a request names a level the model has", () => {
	const efforts: unknown[] = [];
	let server: Server;
	let baseUrl: string;
	let codex: CliproxyCodexStreams;

	const frames = () => {
		const item = { type: "message", id: "msg_1", role: "assistant", status: "completed" };
		return [
			{ type: "response.created", response: { id: "resp_1", status: "in_progress" } },
			{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
			{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "ok" },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { ...item, content: [{ type: "output_text", text: "ok", annotations: [] }] },
			},
			{
				type: "response.completed",
				response: {
					id: "resp_1",
					status: "completed",
					usage: {
						input_tokens: 3,
						output_tokens: 1,
						total_tokens: 4,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
	};

	beforeAll(async () => {
		server = createServer((req: IncomingMessage, res: ServerResponse) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => {
				let raw = Buffer.concat(chunks);
				const encoding = req.headers["content-encoding"];
				if (encoding === "zstd") raw = zstdDecompressSync(raw);
				if (encoding === "gzip") raw = gunzipSync(raw);
				const body = JSON.parse(raw.toString("utf8")) as { reasoning?: { effort?: unknown } };
				efforts.push(body.reasoning?.effort);
				res.writeHead(200, { "content-type": "text/event-stream" });
				for (const frame of frames()) res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
				res.end();
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
		codex = await loadCliproxyCodexStreams(["cliproxyapi"]);
	});

	afterAll(async () => {
		codex?.closeOpenAICodexWebSocketSessions();
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	});

	const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
	const run = async (events: AsyncIterable<AssistantMessageEvent>) => {
		const types: string[] = [];
		for await (const event of events) types.push(event.type);
		return types.at(-1);
	};

	it("streamSimple (pi's turns): low and minimal go as medium, xhigh as high, the levels it has as they are", async () => {
		efforts.length = 0;
		for (const reasoning of ["low", "minimal", "medium", "high", "xhigh"] as const) {
			const options = { apiKey: "sk-test", transport: "sse", reasoning } as SimpleStreamOptions;
			expect(await run(codex.streamSimple(nemotron(baseUrl), context, options))).toBe("done");
		}
		expect(efforts).toEqual(["medium", "medium", "medium", "high", "high"]);
	});

	it("stream (an extension's own request with reasoningEffort): low goes as medium, never as low", async () => {
		efforts.length = 0;
		for (const reasoningEffort of ["low", "high"]) {
			const options = { apiKey: "sk-test", transport: "sse", reasoningEffort } as unknown as SimpleStreamOptions;
			expect(await run(codex.stream(nemotron(baseUrl), context, options))).toBe("done");
			expect(await run(codex.rawStream(nemotron(baseUrl), context, options))).toBe("done");
		}
		expect(efforts).toEqual(["medium", "medium", "high", "high"]);
	});
});
