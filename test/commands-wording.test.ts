// pi-provimux's own wording of what /pause, /continue, /fast and /ultrafast say, beside the original tests (which keep
// theirs, with only the texts changed).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FastModeController } from "../extensions/fast.ts";
import { registerFastCommands, registerPauseCommands } from "../extensions/index.ts";
import { loadConfigFile } from "../extensions/lib.ts";
import { PauseController } from "../extensions/pause.ts";

const dirs: string[] = [];
const tempAgentDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "pi-provimux-wording-test-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const commandsOf = () => {
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	const pi = {
		registerCommand: vi.fn((name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
			commands.set(name, options);
		}),
	} as unknown as ExtensionAPI;
	return { pi, commands };
};

describe("what /pause and /continue say", () => {
	it("says when nothing changed, and refuses an argument saying the command did not run", async () => {
		const agentDir = tempAgentDir();
		const { pi, commands } = commandsOf();
		const controller = new PauseController();
		registerPauseCommands({ pi, agentDir, pauseMode: controller });
		const notify = vi.fn();
		const ctx = { ui: { notify } } as unknown as ExtensionCommandContext;

		await commands.get("continue")?.handler("", ctx);
		expect(notify).toHaveBeenLastCalledWith("Requests were not paused.", "info");
		await commands.get("pause")?.handler("", ctx);
		await commands.get("pause")?.handler("", ctx);
		expect(controller.isEnabled()).toBe(true);
		expect(notify).toHaveBeenLastCalledWith("Requests were already paused. Type /continue to let them go.", "info");

		await commands.get("pause")?.handler("now", ctx);
		expect(notify).toHaveBeenLastCalledWith(
			"/pause takes no arguments, so it did not run. Type /pause on its own.",
			"error",
		);
		await commands.get("continue")?.handler("all", ctx);
		expect(notify).toHaveBeenLastCalledWith(
			"/continue takes no arguments, so it did not run. Type /continue on its own.",
			"error",
		);
		expect(controller.isEnabled()).toBe(true);
		expect(loadConfigFile(agentDir)).toEqual({ pause: true });
	});
});

describe("what /fast and /ultrafast say", () => {
	const supported = { id: "gpt-5.6-sol", provider: "provimux" } as Model<Api>;

	it("says the tier asked for, what it replaced, and when it is off", async () => {
		const agentDir = tempAgentDir();
		const { pi, commands } = commandsOf();
		const fastMode = new FastModeController(false);
		fastMode.setSupportedModelIds([supported.id]);
		registerFastCommands({ pi, agentDir, providerId: "provimux", fastMode, onStatusChange: vi.fn() });
		const notify = vi.fn();
		const ctx = { model: supported, ui: { notify } } as unknown as ExtensionCommandContext;

		for (const name of ["fast", "ultrafast", "fast", "ultrafast", "ultrafast"])
			await commands.get(name)?.handler("", ctx);
		expect(notify.mock.calls).toEqual([
			[
				"Fast mode is on, saved for later starts: requests to gpt-5.6-sol ask the server for its priority service tier, which can cost more. Type /fast again to turn it off.",
				"info",
			],
			[
				"Ultra Fast mode is on, saved for later starts (in place of Fast mode): requests to gpt-5.6-sol ask the server for its Ultra Fast service tier, which can cost more. Type /ultrafast again to turn it off.",
				"info",
			],
			[
				"Fast mode is on, saved for later starts (in place of Ultra Fast mode): requests to gpt-5.6-sol ask the server for its priority service tier, which can cost more. Type /fast again to turn it off.",
				"info",
			],
			[
				"Ultra Fast mode is on, saved for later starts (in place of Fast mode): requests to gpt-5.6-sol ask the server for its Ultra Fast service tier, which can cost more. Type /ultrafast again to turn it off.",
				"info",
			],
			["Ultra Fast mode is off, saved for later starts: requests no longer ask for a faster service tier.", "info"],
		]);
	});

	it("says when no model is selected", async () => {
		const agentDir = tempAgentDir();
		const { pi, commands } = commandsOf();
		const fastMode = new FastModeController(false);
		registerFastCommands({ pi, agentDir, providerId: "provimux", fastMode });
		const notify = vi.fn();
		await commands.get("fast")?.handler("", { ui: { notify } } as unknown as ExtensionCommandContext);
		expect(notify).toHaveBeenLastCalledWith(
			"Fast mode is on, saved for later starts, but no model is selected. It applies to the Provimux models whose server entry lists a service tier, except those sent in Claude's own format. Type /fast again to turn it off.",
			"warning",
		);
	});
});
