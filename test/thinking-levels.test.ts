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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	CLIPROXYAPI_CODEX_API,
	type CliproxyCodexStreams,
	loadCliproxyCodexStreams,
} from "../extensions/codex-stream.ts";
import { toPiModel } from "../extensions/lib.ts";
import {
	clampThinkingLevel,
	PI_LEVELS,
	type PiLevel,
	registerThinkingLevelGuard,
	requestedThinkingLevel,
	supportedThinkingLevels,
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

describe("the level asked on pi's command line", () => {
	it("is --thinking's, else the :level of --model, read as pi reads them", () => {
		expect(
			requestedThinkingLevel(["-p", "--model", "cliproxyapi/nemotron-3-5-super", "--thinking", "low", "hi"]),
		).toEqual({
			level: "low",
			asked: "--thinking low",
		});
		expect(requestedThinkingLevel(["-p", "--model", "cliproxyapi/nemotron-3-5-super:low", "hi"])).toEqual({
			level: "low",
			asked: "--model cliproxyapi/nemotron-3-5-super:low",
		});
		// --thinking wins over the suffix, as in pi (the suffix then stays part of the model id).
		expect(requestedThinkingLevel(["--model", "x:low", "--thinking", "high"])?.level).toBe("high");
		// The last valid --thinking counts; an invalid one is ignored, as pi ignores it.
		expect(requestedThinkingLevel(["--thinking", "low", "--thinking", "bogus"])?.level).toBe("low");
		expect(requestedThinkingLevel(["--model", "openrouter/qwen:free"])).toBeUndefined();
		expect(requestedThinkingLevel(["-p", "--", "--thinking", "low"])).toBeUndefined();
		expect(requestedThinkingLevel(["-p", "hi"])).toBeUndefined();
	});
});

describe("a one-shot run (pi -p) with a level the model lacks", () => {
	type Handler = (event: unknown, ctx: { mode?: string; model?: Model<Api> }) => unknown;
	const setUp = (argv: string[]) => {
		const handlers: Handler[] = [];
		const reports: string[] = [];
		registerThinkingLevelGuard({ on: (_name, handler) => handlers.push(handler) }, "cliproxyapi", argv, (m) =>
			reports.push(m),
		);
		return { handlers, reports };
	};
	const input = { type: "input", text: "hi", source: "interactive" };
	const previousExitCode = process.exitCode;
	afterEach(() => {
		process.exitCode = previousExitCode;
	});

	it("is refused, with the levels it has: nothing is sent and the run exits with 1", () => {
		const { handlers, reports } = setUp(["-p", "--model", "cliproxyapi/nemotron-3-5-super", "--thinking", "low"]);
		expect(handlers).toHaveLength(1);
		const result = handlers[0]!(input, { mode: "print", model: nemotron() });
		expect(result).toEqual({ action: "handled" });
		expect(process.exitCode).toBe(1);
		expect(reports).toEqual([
			'[pi-provimux] cliproxyapi/nemotron-3-5-super has no thinking level "low" (asked with --thinking low); its levels: medium, high. Nothing was sent: run again with --thinking set to one of them.',
		]);
		// A second prompt of the same run is refused too, and said once.
		expect(handlers[0]!(input, { mode: "print", model: nemotron() })).toEqual({ action: "handled" });
		expect(reports).toHaveLength(1);
	});

	it("is refused in JSON mode, and when asked as the :level of --model", () => {
		const { handlers, reports } = setUp(["--mode", "json", "--model", "cliproxyapi/nemotron-3-5-super:minimal"]);
		expect(handlers[0]!(input, { mode: "json", model: nemotron() })).toEqual({ action: "handled" });
		expect(reports[0]).toContain('no thinking level "minimal"');
		expect(reports[0]).toContain("its levels: medium, high");
	});

	it("goes ahead with a level the model has, without a level asked, or with another provider's model", () => {
		expect(setUp(["-p", "--thinking", "high"]).handlers[0]!(input, { mode: "print", model: nemotron() })).toEqual({
			action: "continue",
		});
		expect(setUp(["-p", "hi"]).handlers).toHaveLength(0);
		const other = { ...nemotron(), provider: "openrouter" } as Model<Api>;
		expect(setUp(["-p", "--thinking", "low"]).handlers[0]!(input, { mode: "print", model: other })).toEqual({
			action: "continue",
		});
		expect(process.exitCode).toBe(previousExitCode);
	});

	it("in the TUI and over RPC, pi's own move stays: nothing is refused", () => {
		const { handlers, reports } = setUp(["--thinking", "low"]);
		for (const mode of ["tui", "rpc"]) {
			expect(handlers[0]!(input, { mode, model: nemotron() })).toEqual({ action: "continue" });
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
