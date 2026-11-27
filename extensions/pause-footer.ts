/** The pause in the footer: `paused · /continue` while requests are held, in every Pi window that reads the pause. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type PauseController, pauseController, readPauseSetting } from "./pause.ts";

export const PAUSE_STATUS_KEY = "provimux-pause";
/** How often an idle window reads the saved pause, so a /pause or /continue typed in another window shows here. */
export const PAUSE_FOOTER_POLL_MS = 2_000;
/** From this terminal width on, the footer also says how to end the pause. */
export const PAUSE_WIDE_MIN_COLUMNS = 60;

/** The footer's text for a pause: `paused · /continue`, or `paused` in a narrow terminal. */
export function pauseStatusText(columns: number): string {
	return columns >= PAUSE_WIDE_MIN_COLUMNS ? "paused · /continue" : "paused";
}

const terminalColumns = (): number =>
	process.stdout.isTTY && process.stdout.columns > 0 ? process.stdout.columns : Number.POSITIVE_INFINITY;

export interface PauseFooter {
	/** Reads the saved pause and shows it now (after /pause or /continue in this window). */
	refresh(): void;
}

/**
 * Shows the pause in the footer of the interactive session: at the session's start, at once after /pause or /continue
 * here, and within {@link PAUSE_FOOTER_POLL_MS} when another window changed it (each read also tells the request guard's
 * controller, as the guard's own read does).
 */
export function registerPauseFooter(
	pi: ExtensionAPI,
	agentDir: string,
	options: { controller?: PauseController; pollMs?: number; columns?: () => number } = {},
): PauseFooter {
	const controller = options.controller ?? pauseController;
	const pollMs = options.pollMs ?? PAUSE_FOOTER_POLL_MS;
	const columns = options.columns ?? terminalColumns;
	let active: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let shown: string | undefined;

	const show = (): void => {
		const ctx = active;
		if (!ctx) return;
		const text = controller.isEnabled() ? pauseStatusText(columns()) : undefined;
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
		controller.setEnabled(readPauseSetting(agentDir, controller.isEnabled()));
		show();
	};
	const onResize = (): void => show();
	const stop = (): void => {
		if (timer) clearInterval(timer);
		timer = undefined;
		active = undefined;
		shown = undefined;
		process.stdout.off("resize", onResize);
	};

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		stop();
		active = ctx;
		read();
		timer = setInterval(read, pollMs);
		timer.unref?.();
		process.stdout.on("resize", onResize);
	});
	pi.on("session_shutdown", () => stop());

	return { refresh: read };
}
