import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FastModeController } from "../extensions/fast.ts";
import { FastFooterController } from "../extensions/fast-footer.ts";
import { registerPauseCommands, registerPauseGuard } from "../extensions/index.ts";
import { resolvePauseDefault, saveConfigFile } from "../extensions/lib.ts";
import { PAUSE_POLL_INTERVAL_MS, PauseController } from "../extensions/pause.ts";
import { PAUSE_STATUS_KEY, pauseStatusText, registerPauseFooter } from "../extensions/pause-footer.ts";

const dirs: string[] = [];
const tempAgentDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "pi-provimux-pause-footer-test-"));
	dirs.push(dir);
	return dir;
};
const WIDE = "<warning>paused · /continue</warning>";

/**
 * One Pi window, wired as the extension wires it: its own pause controller (each window is its own Pi process),
 * read from the saved setting at load; the request guard; the footer mark; the commands; and the original project's
 * model-name formatter with its orange `paused`. A footer that keeps what is set; a terminal `columns` wide.
 * `footer: false` leaves the mark out.
 */
function window(
	agentDir: string,
	options: {
		columns?: number;
		mode?: string;
		hasUI?: boolean;
		stale?: boolean;
		footer?: boolean;
		/** Reads the terminal's width (a fault injected here). */
		measure?: () => number;
		/** Whether setStatus throws now (a fault injected after the start). */
		failStatus?: () => boolean;
	} = {},
) {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
			handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) =>
			commands.set(name, command),
	} as unknown as ExtensionAPI;
	let columns = options.columns ?? 120;
	const statuses = new Map<string, string | undefined>();
	const setStatus = vi.fn((key: string, text: string | undefined) => {
		if (options.stale || options.failStatus?.()) throw new Error("stale context");
		statuses.set(key, text);
	});
	const ctx = {
		hasUI: options.hasUI ?? true,
		mode: options.mode ?? "tui",
		ui: {
			setStatus,
			notify: vi.fn(),
			theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
		},
	} as unknown as ExtensionCommandContext;
	const controller = new PauseController(resolvePauseDefault(agentDir));
	if (options.footer !== false) registerPauseFooter(pi, controller, { columns: options.measure ?? (() => columns) });
	registerPauseCommands({ pi, agentDir, pauseMode: controller });
	registerPauseGuard({ pi, agentDir, pauseMode: controller });
	const modelStatus = new FastFooterController("provimux", new FastModeController(false), () => undefined, controller);
	const emit = (event: string) => {
		for (const handler of handlers.get(event) ?? []) handler({}, ctx);
	};
	let held = 0;
	return {
		controller,
		handlers,
		ctx,
		start: () => emit("session_start"),
		shutdown: () => emit("session_shutdown"),
		command: (name: string, args = "") => commands.get(name)?.handler(args, ctx),
		/** A request reaching the guard: resolves when the guard lets it go. */
		request: () => {
			held++;
			return Promise.resolve(handlers.get("before_provider_request")?.[0]({}, ctx)).finally(() => held--);
		},
		held: () => held,
		footer: () => statuses.get(PAUSE_STATUS_KEY),
		/** The original project's orange label: the model's name in the footer. */
		label: () => modelStatus.formatModelStatus("fixture model", false, "off"),
		setStatus,
		resize: (width: number) => {
			columns = width;
			process.stdout.emit("resize");
		},
	};
}
type Window = ReturnType<typeof window>;

const windows: Window[] = [];
const open = (...args: Parameters<typeof window>): Window => {
	const w = window(...args);
	windows.push(w);
	return w;
};

/** The mark and the orange label say the same thing, and it is what the window's guard believes. */
const shows = (w: Window): boolean => {
	const mark = w.footer() !== undefined;
	expect(w.label().includes("paused")).toBe(mark);
	expect(w.controller.isEnabled()).toBe(mark);
	return mark;
};

let resizeListeners = 0;
beforeEach(() => {
	vi.useFakeTimers();
	resizeListeners = process.stdout.listenerCount("resize");
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("unexpected fetch");
		}),
	);
});
afterEach(() => {
	for (const w of windows.splice(0)) w.shutdown();
	expect(process.stdout.listenerCount("resize")).toBe(resizeListeners);
	vi.unstubAllGlobals();
	vi.useRealTimers();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the pause mark follows the request guard", () => {
	it("agrees with the orange label in every state of the reviewer's probe, and after it", async () => {
		const agentDir = tempAgentDir();
		const [first, other] = [open(agentDir), open(agentDir)];
		first.start();
		other.start();
		expect([shows(first), shows(other)]).toEqual([false, false]);

		await first.command("pause");
		expect(first.footer()).toBe(WIDE);
		// The other window is idle and has not checked: both of its indicators say nothing, however long it waits.
		await vi.advanceTimersByTimeAsync(60_000);
		expect([shows(first), shows(other)]).toEqual([true, false]);

		// Its next request is held: then it shows the mark, and the orange label with it.
		const request = other.request();
		await vi.advanceTimersByTimeAsync(0);
		expect(other.held()).toBe(1);
		expect([shows(first), shows(other)]).toEqual([true, true]);

		// /continue in the other window: there at once; the first window is idle and keeps both until it checks.
		await other.command("continue");
		expect([shows(first), shows(other)]).toEqual([true, false]);
		await vi.advanceTimersByTimeAsync(PAUSE_POLL_INTERVAL_MS);
		await request;
		expect(other.held()).toBe(0);
		await vi.advanceTimersByTimeAsync(60_000);
		expect([shows(first), shows(other)]).toEqual([true, false]);

		// The first window's next request: its guard reads the setting, lets it go, and both indicators go together.
		await first.request();
		expect([shows(first), shows(other)]).toEqual([false, false]);
	});

	it("a held request's window clears both when another window continues, at the guard's next check", async () => {
		const agentDir = tempAgentDir();
		const [here, away] = [open(agentDir), open(agentDir)];
		here.start();
		away.start();
		await here.command("pause");
		let released = false;
		const request = here.request().then(() => {
			released = true;
		});
		await vi.advanceTimersByTimeAsync(PAUSE_POLL_INTERVAL_MS * 3);
		expect([released, shows(here)]).toEqual([false, true]);
		await away.command("continue");
		expect(shows(here)).toBe(true);
		await vi.advanceTimersByTimeAsync(PAUSE_POLL_INTERVAL_MS);
		await request;
		expect([released, shows(here)]).toEqual([true, false]);
	});

	it("agrees with the guard while the file is half-written, unreadable, invalid or missing", async () => {
		const agentDir = tempAgentDir();
		const path = join(agentDir, "provimux.json");
		const here = open(agentDir);
		here.start();
		await here.command("pause");
		let released = false;
		const request = here.request().then(() => {
			released = true;
		});
		for (const put of [
			() => writeFileSync(path, "{"),
			() => writeFileSync(path, '{"pause": tr'),
			() => writeFileSync(path, '{"pause": "yes"}'),
			() => {
				rmSync(path);
				mkdirSync(path);
			},
			() => writeFileSync(join(path, "x"), ""),
		]) {
			put();
			await vi.advanceTimersByTimeAsync(PAUSE_POLL_INTERVAL_MS);
			// The guard keeps what it believed when it can't read the setting: so does the mark.
			expect([released, shows(here)]).toEqual([false, true]);
		}
		// No provimux.json at all: the original guard reads "not paused" and lets the request go; both indicators go.
		rmSync(path, { recursive: true });
		await vi.advanceTimersByTimeAsync(PAUSE_POLL_INTERVAL_MS);
		await request;
		expect([released, shows(here)]).toEqual([true, false]);
	});

	it("shows from the start in a Pi started while paused", () => {
		const agentDir = tempAgentDir();
		saveConfigFile(agentDir, { pause: true });
		const later = open(agentDir);
		later.start();
		expect(later.footer()).toBe(WIDE);
		expect(shows(later)).toBe(true);
	});

	it("says only paused in a narrow terminal, and follows a resize", async () => {
		expect(pauseStatusText(200)).toBe("paused · /continue");
		expect(pauseStatusText(60)).toBe("paused · /continue");
		expect(pauseStatusText(59)).toBe("paused");
		expect(pauseStatusText(20)).toBe("paused");
		const narrow = open(tempAgentDir(), { columns: 40 });
		narrow.start();
		await narrow.command("pause");
		expect(narrow.footer()).toBe("<warning>paused</warning>");
		narrow.resize(100);
		expect(narrow.footer()).toBe(WIDE);
		narrow.resize(50);
		expect(narrow.footer()).toBe("<warning>paused</warning>");
	});
});

describe("nothing of its own", () => {
	it("no timer and no file read: an idle window never changes its mark by itself", async () => {
		const agentDir = tempAgentDir();
		const idle = open(agentDir);
		idle.start();
		expect(vi.getTimerCount()).toBe(0);
		saveConfigFile(agentDir, { pause: true });
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(idle.setStatus).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		// Only the resize handling is added to what the original project listens to.
		expect(process.stdout.listenerCount("resize")).toBe(resizeListeners + 1);
	});

	it("stops following after the session ends, and sets nothing outside the TUI or on a stale interface", async () => {
		const agentDir = tempAgentDir();
		const here = open(agentDir);
		here.start();
		here.shutdown();
		expect(process.stdout.listenerCount("resize")).toBe(resizeListeners);
		await here.command("pause");
		expect(here.controller.isEnabled()).toBe(true);
		expect(here.setStatus).not.toHaveBeenCalled();

		const printMode = open(agentDir, { mode: "print", hasUI: false });
		printMode.start();
		await printMode.command("continue");
		expect(printMode.setStatus).not.toHaveBeenCalled();

		saveConfigFile(agentDir, { pause: true });
		const stale = open(agentDir, { stale: true });
		stale.start();
		expect(stale.setStatus).toHaveBeenCalledTimes(2);
		await stale.command("continue");
		expect(stale.setStatus).toHaveBeenCalledTimes(2);
		expect(process.stdout.listenerCount("resize")).toBe(resizeListeners);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("a new session on the same controller follows it once, as a reload would", async () => {
		const agentDir = tempAgentDir();
		const here = open(agentDir);
		here.start();
		here.start();
		await here.command("pause");
		expect(here.setStatus).toHaveBeenCalledTimes(1);
		expect(process.stdout.listenerCount("resize")).toBe(resizeListeners + 1);
	});

	it("the guard lets a request go at the same moments with the mark as without it", async () => {
		const states = ["{", '{"pause": tr', "unreadable", '{"pause":"yes"}', '{"pause":true}', '{"pause":false}'];
		const run = async (footer: boolean): Promise<boolean[]> => {
			const agentDir = tempAgentDir();
			const path = join(agentDir, "provimux.json");
			const w = open(agentDir, { footer });
			w.start();
			await w.command("pause");
			let released = false;
			const request = w.request().then(() => {
				released = true;
			});
			const seen: boolean[] = [];
			for (const content of states) {
				rmSync(path, { recursive: true, force: true });
				if (content === "unreadable") mkdirSync(path);
				else writeFileSync(path, content);
				for (let t = 0; t < PAUSE_POLL_INTERVAL_MS * 2; t += 100) {
					await vi.advanceTimersByTimeAsync(100);
					seen.push(released);
				}
			}
			await request;
			return seen;
		};
		const without = await run(false);
		const withMark = await run(true);
		expect(withMark).toEqual(without);
		expect(without.slice(0, -4).every((r) => !r)).toBe(true);
		expect(without.at(-1)).toBe(true);
	});
});

describe("a fault while drawing the mark never reaches the request guard", () => {
	type Faults = { measure?: () => number; failStatus?: () => boolean; footer?: boolean; afterStart?: () => void };
	/**
	 * A paused window's request through Pi 1.6.0's own request-hook runner (which sends a request at once when a hook
	 * throws), held while the setting says paused and let go after it says otherwise. Returns, every 100 ms, whether the
	 * request was let go, and the runner's errors.
	 */
	const heldRequest = async (faults: Faults, checks: (w: Window) => void = () => {}) => {
		const agentDir = tempAgentDir();
		const w = open(agentDir, faults);
		w.start();
		faults.afterStart?.();
		saveConfigFile(agentDir, { pause: true });
		const errors: unknown[] = [];
		const runner = {
			extensions: [{ path: "pi-provimux", handlers: w.handlers }],
			createContext: () => w.ctx,
			emitError: (error: unknown) => errors.push(error),
		};
		const payload = { model: "fixture" };
		let released = false;
		const sent = ExtensionRunner.prototype.emitBeforeProviderRequest.call(runner as never, payload).then((out) => {
			released = true;
			return out;
		});
		const seen: boolean[] = [];
		for (let t = 0; t < PAUSE_POLL_INTERVAL_MS * 5; t += 100) {
			await vi.advanceTimersByTimeAsync(100);
			seen.push(released);
		}
		// Held: the guard believes requests are paused, and the orange label says so.
		expect(w.controller.isEnabled()).toBe(true);
		expect(w.label()).toContain("paused");
		checks(w);
		saveConfigFile(agentDir, { pause: false });
		for (let t = 0; t < PAUSE_POLL_INTERVAL_MS * 2; t += 100) {
			await vi.advanceTimersByTimeAsync(100);
			seen.push(released);
		}
		expect(await sent).toBe(payload);
		expect(w.controller.isEnabled()).toBe(false);
		expect(w.label()).not.toContain("paused");
		return { seen, errors };
	};

	const asOnMain = async (faults: Faults, checks?: (w: Window) => void) => {
		const without = await heldRequest({ footer: false });
		const faulty = await heldRequest(faults, checks);
		// The same moments as with no mark at all (main's guard), and no error reached Pi's runner.
		expect(faulty.seen).toEqual(without.seen);
		expect(faulty.seen.slice(0, (PAUSE_POLL_INTERVAL_MS * 5) / 100).every((r) => !r)).toBe(true);
		expect(faulty.seen.at(-1)).toBe(true);
		expect(faulty.errors).toEqual([]);
		expect(without.errors).toEqual([]);
	};

	it("an exception from reading the terminal's width", async () => {
		await asOnMain(
			{
				measure: () => {
					throw new Error("fixture terminal width failed");
				},
			},
			(w) => expect(w.footer()).toBeUndefined(),
		);
	});

	it("an exception from setStatus", async () => {
		let failing = false;
		await asOnMain({ failStatus: () => failing }, (w) => {
			failing = true;
			expect(w.setStatus).toHaveBeenCalled();
		});
		// And from the first draw while held: the guard holds all the same.
		await asOnMain({ failStatus: () => true });
	});

	it("an exception from the cleanup after a failed draw", async () => {
		let failing = false;
		let off: ReturnType<typeof vi.spyOn> | undefined;
		try {
			await asOnMain({
				failStatus: () => failing,
				afterStart: () => {
					failing = true;
					off = vi.spyOn(process.stdout, "off").mockImplementation(() => {
						throw new Error("fixture cleanup failed");
					});
				},
			});
			expect(off).toHaveBeenCalled();
		} finally {
			off?.mockRestore();
		}
	});

	it("setEnabled's own result and exceptions pass through the wrapper unchanged", () => {
		const agentDir = tempAgentDir();
		const w = open(agentDir);
		w.start();
		w.controller.setEnabled(true, 1_000);
		w.controller.setEnabled(false, 1_250);
		expect(w.controller.getPausedDurationMs(5_000)).toBe(250);
		expect(w.controller.setEnabled(true)).toBeUndefined();
		// A controller whose own setEnabled throws, followed by the mark: the same exception reaches the caller.
		const x = open(agentDir);
		vi.spyOn(x.controller, "setEnabled").mockImplementation(() => {
			throw new Error("fixture controller failure");
		});
		x.start();
		expect(() => x.controller.setEnabled(true)).toThrow("fixture controller failure");
	});
});
