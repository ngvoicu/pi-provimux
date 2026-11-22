/**
 * A thinking level the model does not have.
 *
 * Each model's levels come from the proxy's `supported_reasoning_levels`; the others are `null` in its
 * `thinkingLevelMap`. pi moves a level the model lacks to the nearest one it has (up first, then down), the same in
 * every mode, and says nothing. So:
 * - in a one-shot run (`pi -p`, `--mode json`), a level asked on the command line (`--thinking`, or the `:level`
 *   suffix of `--model`) that the model lacks is refused, with the levels it has, and nothing is sent;
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
	/** How it was asked: `--thinking low` or `--model x:low`. */
	asked: string;
}

/**
 * The level asked on pi's command line, read as pi reads it: the last valid `--thinking <level>`; without one, the
 * `:<level>` suffix of the last `--model`. Arguments after `--` are messages.
 */
export function requestedThinkingLevel(argv: readonly string[]): RequestedLevel | undefined {
	let thinking: PiLevel | undefined;
	let model: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") break;
		if (arg === "--thinking" && i + 1 < argv.length) {
			const value = argv[++i];
			if (isPiLevel(value)) thinking = value;
		} else if (arg === "--model" && i + 1 < argv.length) {
			model = argv[++i];
		}
	}
	if (thinking) return { level: thinking, asked: `--thinking ${thinking}` };
	if (model) {
		const colon = model.lastIndexOf(":");
		const suffix = colon === -1 ? "" : model.slice(colon + 1);
		if (isPiLevel(suffix)) return { level: suffix, asked: `--model ${model}` };
	}
	return undefined;
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

interface InputGuardContext {
	mode?: string;
	model?: LevelModel;
}

interface InputGuardApi {
	on(event: "input", handler: (event: unknown, ctx: InputGuardContext) => unknown): void;
}

/**
 * In a one-shot run, a level asked on the command line that this provider's model lacks is refused: the message goes
 * to stderr, the run exits with 1, and no prompt is sent. Interactive and RPC sessions keep pi's own move.
 */
export function registerThinkingLevelGuard(
	pi: InputGuardApi,
	providerId: string,
	argv: readonly string[] = process.argv.slice(2),
	report: (message: string) => void = (message) => console.error(message),
): void {
	const requested = requestedThinkingLevel(argv);
	if (!requested) return;
	let reported = false;
	pi.on("input", (_event, ctx) => {
		if (!ONE_SHOT_MODES.has(ctx.mode ?? "")) return { action: "continue" };
		const model = ctx.model;
		if (!model || model.provider !== providerId) return { action: "continue" };
		if (supportedThinkingLevels(model).includes(requested.level)) return { action: "continue" };
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
