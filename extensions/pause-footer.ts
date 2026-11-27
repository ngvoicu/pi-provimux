/**
 * The pause in the footer: `paused · /continue` exactly while this window's request guard believes requests are paused.
 * It reads the same state as the orange `paused` beside the model's name (the window's PauseController), and draws
 * again each time that state is set: at the start, by /pause or /continue here, and by the guard when a request
 * reaches it (and while it holds one). It reads no file and keeps no state of its own, so the two can't disagree.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PauseController } from "./pause.ts";

export const PAUSE_STATUS_KEY = "provimux-pause";
/** From this terminal width on, the footer also says how to end the pause. */
export const PAUSE_WIDE_MIN_COLUMNS = 60;

/** The footer's text for a pause: `paused · /continue`, or `paused` in a narrow terminal. */
export function pauseStatusText(columns: number): string {
	return columns >= PAUSE_WIDE_MIN_COLUMNS ? "paused · /continue" : "paused";
}

const terminalColumns = (): number =>
	process.stdout.isTTY && process.stdout.columns > 0 ? process.stdout.columns : Number.POSITIVE_INFINITY;

const SET_ENABLED_FOLLOWERS = Symbol.for("pi-provimux/pause-set-enabled-followers");
type Followed = PauseController & { [SET_ENABLED_FOLLOWERS]?: Set<() => void> };

/**
 * Calls `follower` after every `setEnabled` of this controller, wherever it comes from (the start, the commands, the
 * guard). The controller is the original project's and stays as it is: its own `setEnabled` runs first, unchanged.
 * Returns the function that stops following.
 */
function followSetEnabled(controller: PauseController, follower: () => void): () => void {
	const followed = controller as Followed;
	let followers = followed[SET_ENABLED_FOLLOWERS];
	if (!followers) {
		const own = new Set<() => void>();
		followers = own;
		followed[SET_ENABLED_FOLLOWERS] = own;
		const setEnabled = controller.setEnabled.bind(controller);
		controller.setEnabled = (enabled: boolean, now?: number): void => {
			setEnabled(enabled, now);
			for (const follow of [...own]) follow();
		};
	}
	followers.add(follower);
	return () => followers.delete(follower);
}

/** Shows the pause in the footer of the interactive session, as `pauseMode` (this window's guard state) holds it. */
export function registerPauseFooter(
	pi: ExtensionAPI,
	pauseMode: PauseController,
	options: { columns?: () => number } = {},
): void {
	const columns = options.columns ?? terminalColumns;
	let active: ExtensionContext | undefined;
	let shown: string | undefined;
	let unfollow: (() => void) | undefined;

	const stop = (): void => {
		unfollow?.();
		unfollow = undefined;
		active = undefined;
		shown = undefined;
		process.stdout.off("resize", render);
	};
	function render(): void {
		const ctx = active;
		if (!ctx) return;
		const text = pauseMode.isEnabled() ? pauseStatusText(columns()) : undefined;
		if (text === shown) return;
		try {
			ctx.ui.setStatus(PAUSE_STATUS_KEY, text === undefined ? undefined : ctx.ui.theme.fg("warning", text));
			shown = text;
		} catch {
			// A session replaced since: the next session_start shows it again.
			stop();
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		stop();
		active = ctx;
		render();
		// The first status write failed (a stale interface): nothing is installed.
		if (active !== ctx) return;
		unfollow = followSetEnabled(pauseMode, render);
		process.stdout.on("resize", render);
	});
	pi.on("session_shutdown", () => stop());
}
