/**
 * A thinking level the model does not have.
 *
 * Each model's levels come from the proxy's `supported_reasoning_levels`; the others are `null` in its
 * `thinkingLevelMap`. pi moves a level the model lacks to the nearest one it has (up first, then down), the same in
 * every mode, and says nothing. So:
 * - in a one-shot run (`pi -p`, `--mode json`), a level asked on the command line (`--thinking`, the `:level` suffix
 *   of `--model`, or that of the `--models` pattern pi selected the model with) that the model lacks is refused, with
 *   the levels it has, and nothing is sent. A suffix is a level only when pi read it as one: a model whose id ends in
 *   `:high` (`local-assistant:high`) is that model, at no level;
 * - everywhere else pi's move stays, and a request never names a level the model lacks: the Codex-format stream moves
 *   it the way pi does before sending it, so the proxy never picks a variant of its own.
 */

/** pi's thinking levels, in its order (pi-ai's `clampThinkingLevel` walks this list). */
export const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PiLevel = (typeof PI_LEVELS)[number];

export interface LevelModel {
	provider?: string;
	id?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<string, string | null | undefined>>;
}

export function isPiLevel(value: unknown): value is PiLevel {
	return typeof value === "string" && (PI_LEVELS as readonly string[]).includes(value);
}

/** The levels pi offers for the model (pi-ai's `getSupportedThinkingLevels`). */
export function supportedThinkingLevels(model: LevelModel): PiLevel[] {
	if (!model.reasoning) return ["off"];
	return PI_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/** Where pi moves a level the model lacks (pi-ai's `clampThinkingLevel`): the next one up, else the next one down. */
export function clampThinkingLevel(model: LevelModel, level: PiLevel): PiLevel {
	const available = supportedThinkingLevels(model);
	if (available.includes(level)) return level;
	const index = PI_LEVELS.indexOf(level);
	for (let i = index; i < PI_LEVELS.length; i++) {
		if (available.includes(PI_LEVELS[i])) return PI_LEVELS[i];
	}
	for (let i = index - 1; i >= 0; i--) {
		if (available.includes(PI_LEVELS[i])) return PI_LEVELS[i];
	}
	return available[0] ?? "off";
}

export interface RequestedLevel {
	level: PiLevel;
	/** How it was asked: `--thinking low`, `--model x:low` or `--models x:low`. */
	asked: string;
}

/** The flags of pi's command line that choose the model and its level, as pi's own parser keeps them. */
export interface CommandLine {
	/** The last valid `--thinking`. */
	thinking?: PiLevel;
	/** The last `--model`. */
	model?: string;
	/** The last `--provider`. */
	provider?: string;
	/** The last `--models`, as given, and its patterns. */
	models?: { given: string; patterns: string[] };
}

/** pi's command line as pi reads it: the last of each flag; arguments after `--` are messages. */
export function readCommandLine(argv: readonly string[]): CommandLine {
	const line: CommandLine = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") break;
		if (i + 1 >= argv.length) continue;
		if (arg === "--thinking") {
			const value = argv[++i];
			if (isPiLevel(value)) line.thinking = value;
		} else if (arg === "--model") {
			line.model = argv[++i];
		} else if (arg === "--provider") {
			line.provider = argv[++i];
		} else if (arg === "--models") {
			const given = argv[++i]!;
			const patterns = given
				.split(",")
				.map((pattern) => pattern.trim())
				.filter((pattern) => pattern.length > 0);
			line.models = { given, patterns };
		}
	}
	return line;
}

/** Whether the command line may ask for a level at all: without one of these flags, nothing is looked at. */
function mayAskLevel(line: CommandLine): boolean {
	return !!line.thinking || !!line.model?.includes(":") || !!line.models?.patterns.some((p) => p.includes(":"));
}

/** A model as pi's resolver returns it. */
export interface ModelRef {
	provider: string;
	id: string;
	name?: string;
}

/**
 * How pi reads the model flags: `--model` (with `--provider`) and the `--models` patterns, each to a model and the
 * level of a `:level` suffix pi took as a level (undefined when the suffix is part of the id, or there is none).
 */
export interface ModelReading {
	model(text: string, provider: string | undefined): { model?: ModelRef; thinkingLevel?: string } | undefined;
	scope(patterns: string[]): Promise<Array<{ model: ModelRef; thinkingLevel?: string }>>;
}

const sameModel = (a: ModelRef | undefined, b: ModelRef | undefined) =>
	!!a && !!b && a.provider === b.provider && a.id === b.id;

/**
 * Without pi's resolver (a pi that does not export it): the full text first, as a model id or `provider/id`; only when
 * that is no model and the text without a `:level` suffix is, the suffix is a level.
 */
export function literalModelReading(models: readonly ModelRef[]): ModelReading {
	const find = (text: string, provider: string | undefined) => {
		const lower = text.trim().toLowerCase();
		const pool = provider ? models.filter((m) => m.provider.toLowerCase() === provider.toLowerCase()) : models;
		return pool.find((m) => m.id.toLowerCase() === lower || `${m.provider}/${m.id}`.toLowerCase() === lower);
	};
	const read = (text: string, provider: string | undefined) => {
		const whole = find(text, provider);
		if (whole) return { model: whole };
		const colon = text.lastIndexOf(":");
		const suffix = colon === -1 ? "" : text.slice(colon + 1);
		if (!isPiLevel(suffix)) return undefined;
		const base = find(text.slice(0, colon), provider);
		return base ? { model: base, thinkingLevel: suffix } : undefined;
	};
	return {
		model: read,
		scope: async (patterns) =>
			patterns.flatMap((pattern) => {
				const found = read(pattern, undefined);
				return found?.model ? [{ model: found.model, thinkingLevel: found.thinkingLevel }] : [];
			}),
	};
}

/** The session's models, as `ctx.modelRegistry` gives them. */
export interface RegistryLike {
	getAll(): readonly ModelRef[];
	getAvailable?(): readonly ModelRef[] | Promise<readonly ModelRef[]>;
	hasConfiguredAuth?(model: ModelRef): boolean;
}

/** pi's own resolver functions (`resolveCliModel`, `resolveModelScopeWithDiagnostics`), when this pi exports them. */
export interface PiResolvers {
	resolveCliModel?: (options: { cliProvider?: string; cliModel?: string; modelRuntime: never }) => {
		model?: ModelRef;
		thinkingLevel?: string;
		error?: string;
	};
	resolveModelScopeWithDiagnostics?: (
		patterns: string[],
		modelRuntime: never,
	) => Promise<{ scopedModels: Array<{ model: ModelRef; thinkingLevel?: string }> }>;
}

/**
 * How pi reads the model flags against the session's models: with pi's own resolver (fuzzy matching, a custom id,
 * a `:level` suffix taken only when the full text is no model), else `literalModelReading`.
 */
export function piModelReading(registry: RegistryLike, resolvers: PiResolvers): ModelReading {
	const literal = literalModelReading(registry.getAll());
	const models = () => [...registry.getAll()];
	const hasConfiguredAuth = (provider: string) => {
		const model = registry.getAll().find((m) => m.provider === provider);
		return !!model && (registry.hasConfiguredAuth?.(model) ?? true);
	};
	const { resolveCliModel, resolveModelScopeWithDiagnostics } = resolvers;
	return {
		model: (text, provider) => {
			if (typeof resolveCliModel !== "function") return literal.model(text, provider);
			const runtime = { getModels: models, hasConfiguredAuth };
			const resolved = resolveCliModel({ cliProvider: provider, cliModel: text, modelRuntime: runtime as never });
			return resolved.model ? { model: resolved.model, thinkingLevel: resolved.thinkingLevel } : undefined;
		},
		scope: async (patterns) => {
			if (typeof resolveModelScopeWithDiagnostics !== "function") return literal.scope(patterns);
			const available = async () => [...((await registry.getAvailable?.()) ?? registry.getAll())];
			const runtime = { getAvailable: available };
			return (await resolveModelScopeWithDiagnostics(patterns, runtime as never)).scopedModels;
		},
	};
}

/** How the session started, as far as pi's choice of a level from the command line goes. */
export interface SessionStart {
	/** pi's `session_start` reason; a level from `--models` is only taken at startup. */
	reason?: string;
	/** Whether the session had messages already (`-c`, `--session`): pi then keeps its model, not `--models`'. */
	continued: boolean;
}

/**
 * The level asked on pi's command line for the selected model, decided as pi decides it (`buildSessionOptions`): the
 * last valid `--thinking`; without one, the level pi read from `--model`'s `:level` suffix; without `--model`, at the
 * start of a new session, the level of the `--models` pattern that selected the model. A suffix pi took as part of a
 * model id (`local-assistant:high`) asks for no level.
 */
export async function requestedThinkingLevel(
	line: CommandLine,
	selected: ModelRef | undefined,
	reading: ModelReading,
	start: SessionStart = { continued: false },
): Promise<RequestedLevel | undefined> {
	if (line.thinking) return { level: line.thinking, asked: `--thinking ${line.thinking}` };
	if (line.model) {
		const read = reading.model(line.model, line.provider);
		if (read?.model) {
			return isPiLevel(read.thinkingLevel)
				? { level: read.thinkingLevel, asked: `--model ${line.model}` }
				: undefined;
		}
	}
	if (!line.models || !selected || start.continued || (start.reason && start.reason !== "startup")) return undefined;
	if (!line.models.patterns.some((pattern) => pattern.includes(":"))) return undefined;
	const scoped = (await reading.scope(line.models.patterns)).find((entry) => sameModel(entry.model, selected));
	return isPiLevel(scoped?.thinkingLevel)
		? { level: scoped.thinkingLevel, asked: `--models ${line.models.given}` }
		: undefined;
}

/** Why a one-shot run with a level the model lacks is refused, naming the levels it has. */
export function unsupportedLevelMessage(model: LevelModel, requested: RequestedLevel): string {
	const name = model.provider && model.id ? `${model.provider}/${model.id}` : (model.id ?? "the model");
	const levels = supportedThinkingLevels(model);
	return (
		`[pi-provimux] ${name} has no thinking level "${requested.level}" (asked with ${requested.asked}); ` +
		`its levels: ${levels.join(", ")}. Nothing was sent: run again with --thinking set to one of them.`
	);
}

/** The modes that run the prompts on the command line once and exit. */
const ONE_SHOT_MODES = new Set(["print", "json"]);

export interface InputGuardContext {
	mode?: string;
	model?: LevelModel;
	modelRegistry?: RegistryLike;
	sessionManager?: { getBranch?(): ReadonlyArray<{ type?: string }> };
}

interface InputGuardApi {
	on(event: "input", handler: (event: unknown, ctx: InputGuardContext) => unknown): void;
	on(event: "session_start", handler: (event: { reason?: string }, ctx: InputGuardContext) => unknown): void;
}

/** Entries that make a session one pi continues (`buildSessionContext` has messages). */
const CONTEXT_ENTRIES = new Set(["message", "custom_message", "compaction", "branch_summary"]);

/** pi's own resolvers, from the pi that loaded the extension; none on a pi that does not export them. */
async function loadPiResolvers(): Promise<PiResolvers> {
	try {
		const module = (await import("@earendil-works/pi-coding-agent")) as unknown as PiResolvers;
		return {
			resolveCliModel: module.resolveCliModel,
			resolveModelScopeWithDiagnostics: module.resolveModelScopeWithDiagnostics,
		};
	} catch {
		return {};
	}
}

/**
 * In a one-shot run, a level asked on the command line that this provider's model lacks is refused: the message goes
 * to stderr, the run exits with 1, and no prompt is sent. Interactive and RPC sessions keep pi's own move.
 * What was asked is decided once, at the first prompt, against the session's models (`requestedThinkingLevel`).
 */
export function registerThinkingLevelGuard(
	pi: InputGuardApi,
	providerId: string,
	argv: readonly string[] = process.argv.slice(2),
	report: (message: string) => void = (message) => console.error(message),
	resolvers: () => Promise<PiResolvers> = loadPiResolvers,
): void {
	const line = readCommandLine(argv);
	if (!mayAskLevel(line)) return;
	let start: SessionStart | undefined;
	pi.on("session_start", (event, ctx) => {
		if (start) return;
		let continued = false;
		try {
			continued = !!ctx.sessionManager?.getBranch?.().some((entry) => CONTEXT_ENTRIES.has(entry.type ?? ""));
		} catch {
			// No branch to read: a new session.
		}
		start = { reason: event?.reason, continued };
	});
	let requestedOnce: Promise<RequestedLevel | undefined> | undefined;
	let reported = false;
	pi.on("input", async (_event, ctx) => {
		if (!ONE_SHOT_MODES.has(ctx.mode ?? "")) return { action: "continue" };
		const model = ctx.model;
		if (!model || model.provider !== providerId) return { action: "continue" };
		requestedOnce ??= (async () => {
			const selected = model.id ? { provider: model.provider ?? providerId, id: model.id } : undefined;
			const registry = ctx.modelRegistry;
			const literal = () => literalModelReading(registry?.getAll() ?? (selected ? [selected] : []));
			try {
				const reading = registry ? piModelReading(registry, await resolvers()) : literal();
				return await requestedThinkingLevel(line, selected, reading, start);
			} catch {
				// pi's resolver changed shape: the literal reading.
				return requestedThinkingLevel(line, selected, literal(), start);
			}
		})().catch(() => undefined);
		const requested = await requestedOnce;
		if (!requested || supportedThinkingLevels(model).includes(requested.level)) return { action: "continue" };
		if (!reported) {
			reported = true;
			report(unsupportedLevelMessage(model, requested));
		}
		process.exitCode = 1;
		return { action: "handled" };
	});
}

/**
 * The options of a Codex-format request with no level the model lacks: `reasoning` (streamSimple) and
 * `reasoningEffort` (stream) are moved the way pi moves them, so the request names the moved level and the proxy
 * never picks a variant itself. Levels the model has, and efforts that are not pi levels, are left as they are.
 */
export function withSupportedLevel<O extends object | undefined>(model: LevelModel, options: O): O {
	if (!options) return options;
	const record = options as Record<string, unknown>;
	let next: Record<string, unknown> | undefined;
	for (const key of ["reasoning", "reasoningEffort"] as const) {
		const value = record[key];
		if (!isPiLevel(value) || value === "off") continue;
		if (supportedThinkingLevels(model).includes(value)) continue;
		const moved = clampThinkingLevel(model, value);
		next ??= { ...record };
		next[key] = moved === "off" ? undefined : moved;
	}
	return (next ?? options) as O;
}

/** What a level is sent as: its `thinkingLevelMap` entry, else its name (off: "none"); undefined when it is not sent. */
function effortOfLevel(model: LevelModel, level: PiLevel): string | undefined {
	const mapped = model.thinkingLevelMap?.[level];
	if (level === "off") return mapped === undefined ? "none" : (mapped ?? undefined);
	return mapped ?? level;
}

/** The level an effort on the wire stands for: the one the model's map sends as it, else the level of that name. */
function levelOfEffort(model: LevelModel, effort: string): PiLevel | undefined {
	const mapped = PI_LEVELS.find((level) => model.thinkingLevelMap?.[level] === effort);
	if (mapped) return mapped;
	if (effort === "none") return "off";
	return isPiLevel(effort) ? effort : undefined;
}

/** An effort the model has: as it is; one it lacks, moved the way pi moves its level. Not a level: as it is. */
export function supportedEffort(model: LevelModel, effort: string): string | undefined {
	const level = levelOfEffort(model, effort);
	if (!level || supportedThinkingLevels(model).includes(level)) return effort;
	return effortOfLevel(model, clampThinkingLevel(model, level));
}

interface EffortItem {
	type?: unknown;
	reasoning?: { effort?: unknown };
}

/**
 * A Codex-format body with no effort the model lacks, wherever the effort came from. With mid-conversation changes
 * (`configuration_update`), the request-level `reasoning.effort` is the first turn's, recovered from the history, and
 * each update the level a later turn ran at: after a catalog refresh took a level away, a resumed conversation would
 * send it again. Each is moved the way pi moves a level the model lacks, and an update that then names the effort
 * already in force says nothing and is left out. A body with no effort to move is returned as it is.
 */
export function withSupportedEfforts<T extends Record<string, unknown>>(model: LevelModel, body: T): T {
	if (!model.reasoning) return body;
	let moved = false;
	const reasoning = body.reasoning as { effort?: unknown } | undefined;
	let nextReasoning = reasoning;
	let inForce: string | undefined;
	if (reasoning && typeof reasoning === "object" && typeof reasoning.effort === "string") {
		inForce = supportedEffort(model, reasoning.effort);
		if (inForce !== reasoning.effort) {
			moved = true;
			nextReasoning = { ...reasoning, effort: inForce };
		}
	}
	const input = Array.isArray(body.input) ? (body.input as EffortItem[]) : undefined;
	const nextInput: EffortItem[] = [];
	for (const item of input ?? []) {
		const effort = item?.type === "configuration_update" ? item.reasoning?.effort : undefined;
		if (typeof effort !== "string") {
			nextInput.push(item);
			continue;
		}
		const next = supportedEffort(model, effort);
		if (next !== effort) moved = true;
		if (next === undefined || (inForce !== undefined && next === inForce)) continue;
		nextInput.push(next === effort ? item : { ...item, reasoning: { ...item.reasoning, effort: next } });
		inForce = next;
	}
	if (!moved) return body;
	return {
		...body,
		...(nextReasoning !== reasoning ? { reasoning: nextReasoning } : {}),
		...(input ? { input: nextInput } : {}),
	};
}
