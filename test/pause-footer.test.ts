import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPauseCommands } from "../extensions/index.ts";
import { saveConfigFile } from "../extensions/lib.ts";
import { PauseController } from "../extensions/pause.ts";
import {
	PAUSE_FOOTER_POLL_MS,
	PAUSE_STATUS_KEY,
	pauseStatusText,
	registerPauseFooter,
} from "../extensions/pause-footer.ts";

const dirs: string[] = [];
const tempAgentDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "pi-provimux-pause-footer-test-"));
	dirs.push(dir);
	return dir;
};

/** One Pi window: the extension's pause footer and commands, a footer that keeps what is set, a terminal `columns` wide. */
function window(agentDir: string, options: { columns?: number; mode?: string; hasUI?: boolean } = {}) {
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
	const setStatus = vi.fn((key: string, text: string | undefined) => statuses.set(key, text));
	const ctx = {
		hasUI: options.hasUI ?? true,
		mode: options.mode ?? "tui",
		ui: {
			setStatus,
			notify: vi.fn(),
			theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
		},
	} as unknown as ExtensionCommandContext;
	// Each window is its own Pi process: its own controller.
	const controller = new PauseController();
	const footer = registerPauseFooter(pi, agentDir, { controller, columns: () => columns });
	registerPauseCommands({ pi, agentDir, pauseMode: controller, onChange: () => footer.refresh() });
	const emit = (event: string) => {
		for (const handler of handlers.get(event) ?? []) handler({}, ctx);
	};
	return {
		start: () => emit("session_start"),
		shutdown: () => emit("session_shutdown"),
		command: (name: string, args = "") => commands.get(name)?.handler(args, ctx),
		footer: () => statuses.get(PAUSE_STATUS_KEY),
		setStatus,
		resize: (width: number) => {
			columns = width;
			process.stdout.emit("resize");
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the pause in the footer", () => {
	it("shows at once in the window that typed /pause, and goes on /continue", async () => {
		const agentDir = tempAgentDir();
		const here = window(agentDir);
		here.start();
		expect(here.footer()).toBeUndefined();

		await here.command("pause");
		expect(here.footer()).toBe("<warning>paused · /continue</warning>");

		await here.command("continue");
		expect(here.footer()).toBeUndefined();
		expect(here.setStatus).toHaveBeenLastCalledWith(PAUSE_STATUS_KEY, undefined);
	});

	it("shows in another, idle window within the poll interval, and goes when a third window continues", async () => {
		const agentDir = tempAgentDir();
		const here = window(agentDir);
		const other = window(agentDir);
		const third = window(agentDir);
		for (const w of [here, other, third]) w.start();

		await here.command("pause");
		expect(other.footer()).toBeUndefined();
		vi.advanceTimersByTime(PAUSE_FOOTER_POLL_MS);
		expect(other.footer()).toBe("<warning>paused · /continue</warning>");

		await third.command("continue");
		expect(third.footer()).toBeUndefined();
		vi.advanceTimersByTime(PAUSE_FOOTER_POLL_MS);
		expect(here.footer()).toBeUndefined();
		expect(other.footer()).toBeUndefined();
	});

	it("shows a pause saved before the window started, at its start", () => {
		const agentDir = tempAgentDir();
		saveConfigFile(agentDir, { pause: true });
		const later = window(agentDir);
		later.start();
		expect(later.footer()).toBe("<warning>paused · /continue</warning>");
	});

	it("says only paused in a narrow terminal, and follows a resize", async () => {
		expect(pauseStatusText(200)).toBe("paused · /continue");
		expect(pauseStatusText(60)).toBe("paused · /continue");
		expect(pauseStatusText(59)).toBe("paused");
		expect(pauseStatusText(20)).toBe("paused");

		const agentDir = tempAgentDir();
		const narrow = window(agentDir, { columns: 40 });
		narrow.start();
		await narrow.command("pause");
		expect(narrow.footer()).toBe("<warning>paused</warning>");
		narrow.resize(100);
		expect(narrow.footer()).toBe("<warning>paused · /continue</warning>");
		narrow.resize(50);
		expect(narrow.footer()).toBe("<warning>paused</warning>");
		narrow.shutdown();
	});

	it("reads nothing after the session ends, and sets nothing outside the TUI", async () => {
		const agentDir = tempAgentDir();
		const here = window(agentDir);
		here.start();
		here.shutdown();
		saveConfigFile(agentDir, { pause: true });
		vi.advanceTimersByTime(PAUSE_FOOTER_POLL_MS * 3);
		expect(here.setStatus).not.toHaveBeenCalled();

		const printMode = window(agentDir, { mode: "print", hasUI: false });
		printMode.start();
		vi.advanceTimersByTime(PAUSE_FOOTER_POLL_MS);
		expect(printMode.setStatus).not.toHaveBeenCalled();
	});
});
