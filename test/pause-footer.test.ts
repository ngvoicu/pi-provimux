import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPauseCommands, registerPauseGuard } from "../extensions/index.ts";
import { saveConfigFile } from "../extensions/lib.ts";
import { PAUSE_POLL_INTERVAL_MS, PauseController } from "../extensions/pause.ts";
import {
	PAUSE_FOOTER_POLL_MS,
	PAUSE_STATUS_KEY,
	pauseStatusText,
	readSavedPause,
	registerPauseFooter,
} from "../extensions/pause-footer.ts";

const dirs: string[] = [];
const tempAgentDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "pi-provimux-pause-footer-test-"));
	dirs.push(dir);
	return dir;
};
const WIDE = "<warning>paused · /continue</warning>";

/**
 * One Pi window: its own pause controller (each window is its own Pi process), the request guard, the footer mark and
 * the commands; a footer that keeps what is set; a terminal `columns` wide. `footer: false` leaves the mark out.
 */
function window(
	agentDir: string,
	options: { columns?: number; mode?: string; hasUI?: boolean; stale?: boolean; footer?: boolean } = {},
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
		if (options.stale) throw new Error("stale context");
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
	const controller = new PauseController();
	registerPauseGuard({ pi, agentDir, pauseMode: controller });
	const footer = options.footer === false ? undefined : registerPauseFooter(pi, agentDir, { columns: () => columns });
	registerPauseCommands({ pi, agentDir, pauseMode: controller, onChange: (paused) => footer?.show(paused) });
	const emit = (event: string) => {
		for (const handler of handlers.get(event) ?? []) handler({}, ctx);
	};
	return {
		controller,
		start: () => emit("session_start"),
		shutdown: () => emit("session_shutdown"),
		command: (name: string, args = "") => commands.get(name)?.handler(args, ctx),
		/** A request reaching the guard: resolves when the guard lets it go. */
		request: () => Promise.resolve(handlers.get("before_provider_request")?.[0]({}, ctx)),
		footer: () => statuses.get(PAUSE_STATUS_KEY),
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

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	for (const w of windows.splice(0)) w.shutdown();
	vi.useRealTimers();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the pause in the footer", () => {
	it("shows at once in the window that typed /pause, and goes on /continue", async () => {
		const here = open(tempAgentDir());
		here.start();
		expect(here.footer()).toBeUndefined();
		await here.command("pause");
		expect(here.footer()).toBe(WIDE);
		await here.command("continue");
		expect(here.footer()).toBeUndefined();
		expect(here.setStatus).toHaveBeenLastCalledWith(PAUSE_STATUS_KEY, undefined);
	});

	it("shows in another, idle window within the poll interval, and goes when a third window continues", async () => {
		const agentDir = tempAgentDir();
		const [here, other, third] = [open(agentDir), open(agentDir), open(agentDir)];
		for (const w of [here, other, third]) w.start();
		await here.command("pause");
		expect(other.footer()).toBeUndefined();
		vi.advanceTimersByTime(PAUSE_FOOTER_POLL_MS);
		expect(other.footer()).toBe(WIDE);
		await third.command("continue");
		expect(third.footer()).toBeUndefined();
		vi.advanceTimersByTime(PAUSE_FOOTER_POLL_MS);
		expect(here.footer()).toBeUndefined();
		expect(other.footer()).toBeUndefined();
	});

	it("shows a pause saved before the window started, at its start", () => {
		const agentDir = tempAgentDir();
		saveConfigFile(agentDir, { pause: true });
		const later = open(agentDir);
		later.start();
		expect(later.footer()).toBe(WIDE);
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

	it("reads nothing after the session ends, and sets nothing outside the TUI", () => {
		const agentDir = tempAgentDir();
		const here = open(agentDir);
		here.start();
		here.shutdown();
		saveConfigFile(agentDir, { pause: true });
		vi.advanceTimersByTime(PAUSE_FOOTER_POLL_MS * 3);
		expect(here.setStatus).not.toHaveBeenCalled();
		const printMode = open(agentDir, { mode: "print", hasUI: false });
		printMode.start();
		vi.advanceTimersByTime(PAUSE_FOOTER_POLL_MS);
		expect(printMode.setStatus).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("the mark only displays", () => {
	it("a missing, unreadable or half-written provimux.json leaves the mark as it was", async () => {
		const agentDir = tempAgentDir();
		const path = join(agentDir, "provimux.json");
		const [here, away] = [open(agentDir), open(agentDir)];
		here.start();
		away.start();
		await here.command("pause");
		vi.advanceTimersByTime(PAUSE_FOOTER_POLL_MS);
		expect([here.footer(), away.footer()]).toEqual([WIDE, WIDE]);
		const valid = readFileSync(path, "utf8");
		for (const damage of [
			() => writeFileSync(path, "{"),
			() => writeFileSync(path, '{"pause": tr'),
			() => writeFileSync(path, '{"pause": "yes"}'),
			() => {
				unlinkSync(path);
				mkdirSync(path);
			},
			() => rmSync(path, { recursive: true }),
		]) {
			damage();
			vi.advanceTimersByTime(PAUSE_FOOTER_POLL_MS);
			expect([here.footer(), away.footer()]).toEqual([WIDE, WIDE]);
		}
		writeFileSync(path, valid);
		expect(readSavedPause(agentDir)).toBe(true);
		writeFileSync(path, '{"pause": false}');
		vi.advanceTimersByTime(PAUSE_FOOTER_POLL_MS);
		expect([here.footer(), away.footer()]).toEqual([undefined, undefined]);
	});

	it("never changes what the request guard or the elapsed-time accounting reads", async () => {
		const agentDir = tempAgentDir();
		const [here, away] = [open(agentDir), open(agentDir)];
		here.start();
		away.start();
		await here.command("pause");
		vi.advanceTimersByTime(PAUSE_FOOTER_POLL_MS * 5);
		// The other window shows the pause, and its controller (the guard's state, and what elapsed time reads) is as it was.
		expect(away.footer()).toBe(WIDE);
		expect(away.controller.isEnabled()).toBe(false);
		expect(away.controller.getPausedDurationMs()).toBe(0);
		// A missing file for a tick does not clear the pause in the window that set it.
		const path = join(agentDir, "provimux.json");
		unlinkSync(path);
		vi.advanceTimersByTime(PAUSE_FOOTER_POLL_MS);
		expect(here.controller.isEnabled()).toBe(true);
	});

	it("a request held by the pause stays held while the file is missing for a poll and then half-written", async () => {
		const agentDir = tempAgentDir();
		const path = join(agentDir, "provimux.json");
		const here = open(agentDir);
		here.start();
		await here.command("pause");
		unlinkSync(path);
		vi.advanceTimersByTime(PAUSE_FOOTER_POLL_MS);
		writeFileSync(path, "{");
		let released = false;
		const held = here.request().then(() => {
			released = true;
		});
		await vi.advanceTimersByTimeAsync(PAUSE_FOOTER_POLL_MS * 3);
		expect(released).toBe(false);
		writeFileSync(path, '{"pause":false}');
		await vi.advanceTimersByTimeAsync(PAUSE_POLL_INTERVAL_MS);
		await held;
		expect(released).toBe(true);
	});

	it("the guard lets a request go at the same moment with the mark's poll running as without it", async () => {
		// Before the request: the file missing, then half-written, while only the mark's poll reads it (the case where the
		// poll used to clear the pause). Then the request, held across malformed, half-written and unreadable files, until
		// the file says the pause is off.
		const before: Array<[string, number]> = [
			["missing", PAUSE_FOOTER_POLL_MS * 2],
			["{", PAUSE_FOOTER_POLL_MS],
		];
		const after: Array<[string, number]> = [
			["{", PAUSE_FOOTER_POLL_MS * 2],
			['{"pause": tr', PAUSE_FOOTER_POLL_MS],
			["unreadable", PAUSE_FOOTER_POLL_MS],
			['{"pause":"yes"}', PAUSE_FOOTER_POLL_MS],
			['{"pause":true}', PAUSE_FOOTER_POLL_MS],
			['{"pause":false}', PAUSE_POLL_INTERVAL_MS * 2],
		];
		const run = async (footer: boolean): Promise<boolean[]> => {
			const agentDir = tempAgentDir();
			const path = join(agentDir, "provimux.json");
			const w = open(agentDir, { footer });
			w.start();
			await w.command("pause");
			const put = (content: string) => {
				rmSync(path, { recursive: true, force: true });
				if (content === "unreadable") mkdirSync(path);
				else if (content !== "missing") writeFileSync(path, content);
			};
			for (const [content, ms] of before) {
				put(content);
				await vi.advanceTimersByTimeAsync(ms);
			}
			let released = false;
			const request = w.request().then(() => {
				released = true;
			});
			const seen: boolean[] = [];
			for (const [content, ms] of after) {
				put(content);
				for (let t = 0; t < ms; t += 100) {
					await vi.advanceTimersByTimeAsync(100);
					seen.push(released);
				}
			}
			await request;
			return seen;
		};
		const without = await run(false);
		const withPoll = await run(true);
		expect(withPoll).toEqual(without);
		// Held until the file said the pause is off, then let go.
		const offAt = without.length - (PAUSE_POLL_INTERVAL_MS * 2) / 100;
		expect(without.slice(0, offAt).every((r) => !r)).toBe(true);
		expect(without.at(-1)).toBe(true);
	});

	it("a stale interface at the start installs no timer and no resize listener", () => {
		const agentDir = tempAgentDir();
		saveConfigFile(agentDir, { pause: true });
		const listeners = process.stdout.listenerCount("resize");
		const w = open(agentDir, { stale: true });
		w.start();
		expect(vi.getTimerCount()).toBe(0);
		expect(process.stdout.listenerCount("resize")).toBe(listeners);
	});
});
