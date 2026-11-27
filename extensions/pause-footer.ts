/**
 * The pause in the footer: `paused · /continue` while the saved pause is set, in every Pi window that has this
 * extension. It only displays: it keeps its own mark, and never changes what holds or releases a request (the request
 * guard reads the setting itself) nor anything the elapsed-time accounting reads.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_FILE_NAME } from "./lib.ts";

export const PAUSE_STATUS_KEY = "provimux-pause";
/** How often an idle window reads the saved pause, so a /pause or /continue typed in another window shows here. */
export const PAUSE_FOOTER_POLL_MS = 2_000;
/** From this terminal width on, the footer also says how to end the pause. */
export const PAUSE_WIDE_MIN_COLUMNS = 60;

/** The footer's text for a pause: `paused · /continue`, or `paused` in a narrow terminal. */
export function pauseStatusText(columns: number): string {
	return columns >= PAUSE_WIDE_MIN_COLUMNS ? "paused · /continue" : "paused";
}

/**
 * The saved pause, for the mark: true or false where the file says, undefined where it can't be read now (missing,
 * unreadable, half-written, not an object, or a `pause` that is not a boolean): the mark then stays as it was.
 */
export function readSavedPause(agentDir: string): boolean | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(agentDir, CONFIG_FILE_NAME), "utf8"));
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const pause = (parsed as { pause?: unknown }).pause;
	if (pause === undefined) return false;
	return typeof pause === "boolean" ? pause : undefined;
}

const terminalColumns = (): number =>
	process.stdout.isTTY && process.stdout.columns > 0 ? process.stdout.columns : Number.POSITIVE_INFINITY;

export interface PauseFooter {
	/** Shows the pause as this window just set it (after /pause or /continue here). */
	show(paused: boolean): void;
}

/**
 * Shows the pause in the footer of the interactive session: at the session's start, at once after /pause or /continue
 * here, and within {@link PAUSE_FOOTER_POLL_MS} when another window changed the saved setting.
 */
export function registerPauseFooter(
	pi: ExtensionAPI,
	agentDir: string,
	options: { pollMs?: number; columns?: () => number } = {},
): PauseFooter {
	const pollMs = options.pollMs ?? PAUSE_FOOTER_POLL_MS;
	const columns = options.columns ?? terminalColumns;
	let active: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let paused = false;
	let shown: string | undefined;

	const stop = (): void => {
		if (timer) clearInterval(timer);
		timer = undefined;
		active = undefined;
		shown = undefined;
		process.stdout.off("resize", onResize);
	};
	const render = (): void => {
		const ctx = active;
		if (!ctx) return;
		const text = paused ? pauseStatusText(columns()) : undefined;
		if (text === shown) return;
		try {
			ctx.ui.setStatus(PAUSE_STATUS_KEY, text === undefined ? undefined : ctx.ui.theme.fg("warning", text));
			shown = text;
		} catch {
			// A session replaced since: the next session_start shows it again.
			stop();
		}
	};
	const read = (): void => {
		const saved = readSavedPause(agentDir);
		if (saved !== undefined) paused = saved;
		render();
	};
	const onResize = (): void => render();

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		stop();
		active = ctx;
		read();
		// The first status write failed (a stale interface): nothing is installed.
		if (active !== ctx) return;
		timer = setInterval(read, pollMs);
		timer.unref?.();
		process.stdout.on("resize", onResize);
	});
	pi.on("session_shutdown", () => stop());

	return {
		show: (value) => {
			paused = value;
			render();
		},
	};
}
