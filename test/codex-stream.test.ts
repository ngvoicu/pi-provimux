import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	computePatchedModuleCachePath,
	loadProvimuxCodexStreams,
	MID_CONVO_BASELINE_EFFORT,
	patchCodexSource,
	reshapeConfigurationUpdates,
	resolveCodexModuleFromNodeEntry,
	resolveOriginalCodexModulePath,
	wellKnownCodexModuleCandidates,
	writePatchedModuleCache,
} from "../extensions/codex-stream.ts";

/** The developer item pi-ai builds from the system prompt. */
function piDeveloperItem(text: string) {
	return { role: "developer", content: text };
}

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

function tempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

function writeFile(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents, "utf8");
}

const CODEX_RELATIVE = join("node_modules", "@earendil-works", "pi-ai", "dist", "api", "openai-codex-responses.js");

function failingResolveSpecifier(): string {
	throw Object.assign(new Error("Cannot find package '@earendil-works/pi-ai'"), { code: "ERR_MODULE_NOT_FOUND" });
}

/** A host whose argv[1] is no Node entry (a native binary). */
function writeNativeHost(root: string): string {
	const entryPath = join(root, "pi-native");
	writeFile(entryPath, "\x00native");
	return entryPath;
}

function writePartialJsonPackage(nodeModulesDir: string): string {
	const packageDir = join(nodeModulesDir, "partial-json");
	writeFile(
		join(packageDir, "package.json"),
		JSON.stringify({
			name: "partial-json",
			type: "module",
			exports: "./index.js",
		}),
	);
	writeFile(join(packageDir, "index.js"), `export function parse(text) {\n\treturn { ok: true, text };\n}\n`);
	return join(packageDir, "index.js");
}

function writeAgentNpmCodexTree(home: string): { codexPath: string; jsonParsePath: string; partialJsonPath: string } {
	const pluginsNodeModules = join(home, ".pi", "agent", "npm", "node_modules");
	const codexPath = join(home, ".pi", "agent", "npm", CODEX_RELATIVE);
	const jsonParsePath = join(dirname(dirname(codexPath)), "utils", "json-parse.js");
	writeFile(
		codexPath,
		`import { parsePartial } from "../utils/json-parse.js";\nexport function streamSimple() {\n\treturn parsePartial('{"ok":');\n}\nexport function stream() {\n\treturn streamSimple();\n}\n`,
	);
	writeFile(
		jsonParsePath,
		`import { parse } from "partial-json";\nexport function parsePartial(text) {\n\treturn parse(text);\n}\n`,
	);
	const partialJsonPath = writePartialJsonPackage(pluginsNodeModules);
	return { codexPath, jsonParsePath, partialJsonPath };
}

describe("wellKnownCodexModuleCandidates", () => {
	it("lists HOME/.pi and global package roots without host-specific paths", () => {
		const candidates = wellKnownCodexModuleCandidates("/home/user");
		expect(candidates).toEqual([
			join("/home/user", ".pi", "agent", "npm", CODEX_RELATIVE),
			join(
				"/home/user",
				".pi",
				"agent",
				"npm",
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
				CODEX_RELATIVE,
			),
			join("/home/user", ".bun", "install", "global", CODEX_RELATIVE),
			join(
				"/home/user",
				".bun",
				"install",
				"global",
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
				CODEX_RELATIVE,
			),
			join("/home/user", ".npm-global", CODEX_RELATIVE),
			join("/home/user", ".npm-global", "lib", CODEX_RELATIVE),
			join("/home/user", ".npm-global", "lib", "node_modules", "@earendil-works", "pi-coding-agent", CODEX_RELATIVE),
			join("/home/user", "Library", "pnpm", "global", "5", CODEX_RELATIVE),
			join(
				"/home/user",
				"Library",
				"pnpm",
				"global",
				"5",
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
				CODEX_RELATIVE,
			),
			join("/home/user", ".local", "share", "pnpm", "global", "5", CODEX_RELATIVE),
			join(
				"/home/user",
				".local",
				"share",
				"pnpm",
				"global",
				"5",
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
				CODEX_RELATIVE,
			),
			join("/usr", "local", "lib", CODEX_RELATIVE),
			join("/usr", "local", "lib", "node_modules", "@earendil-works", "pi-coding-agent", CODEX_RELATIVE),
			join("/opt", "homebrew", "lib", CODEX_RELATIVE),
			join("/opt", "homebrew", "lib", "node_modules", "@earendil-works", "pi-coding-agent", CODEX_RELATIVE),
		]);
		expect(candidates.join("\n")).not.toMatch(/\/Users\/|\/home\/(?!user\b)|Ravi|tailscale/i);
	});
});

describe("resolveOriginalCodexModulePath", () => {
	it("still resolves the installed package when import.meta.resolve works", () => {
		const resolved = resolveOriginalCodexModulePath();
		expect(resolved.path).toMatch(/openai-codex-responses\.js$/);
		expect(existsSync(resolved.path)).toBe(true);
		expect(resolved.dir).toBe(dirname(resolved.path));
	});

	it("prefers host nodeEntry over import.meta.resolve candidate to keep module identity aligned with host", () => {
		const hostRoot = tempDir("pi-cpa-host-root-");
		const cliEntry = join(hostRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
		const hostCodex = join(
			hostRoot,
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			"node_modules",
			"@earendil-works",
			"pi-ai",
			"dist",
			"api",
			"openai-codex-responses.js",
		);
		writeFile(cliEntry, "");
		writeFile(hostCodex, "");

		const otherDir = tempDir("pi-cpa-specifier-root-");
		const otherCodex = join(otherDir, "openai-codex-responses.js");
		writeFile(otherCodex, "");

		const resolved = resolveOriginalCodexModulePath({
			nodeEntry: cliEntry,
			resolveSpecifier: () => pathToFileURL(otherCodex).href,
		});

		expect(resolved.path).toBe(hostCodex);
	});

	it("prefers import.meta.resolve over a HOME/.pi/agent/npm candidate when nodeEntry is not a Node host", () => {
		const home = tempDir("pi-cpa-home-shadow-");
		writeAgentNpmCodexTree(home);

		const resolved = resolveOriginalCodexModulePath({ homeDirectory: home, nodeEntry: undefined });
		expect(resolved.path).not.toBe(join(home, ".pi", "agent", "npm", CODEX_RELATIVE));
		expect(resolved.path).toMatch(
			/[\\/]node_modules[\\/]@earendil-works[\\/]pi-ai[\\/]dist[\\/]api[\\/]openai-codex-responses\.js$/,
		);
	});

	it("resolves a nested HOME/.pi/agent/npm candidate for the bundled pi host", () => {
		const home = tempDir("pi-cpa-pi-home-");
		const hostDir = tempDir("pi-cpa-pi-host-");
		const nested = join(
			home,
			".pi",
			"agent",
			"npm",
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			CODEX_RELATIVE,
		);
		writeFile(nested, "export {}\n");

		const resolved = resolveOriginalCodexModulePath({
			resolveSpecifier: failingResolveSpecifier,
			nodeEntry: writeNativeHost(hostDir),
			homeDirectory: home,
		});

		expect(resolved.path).toBe(nested);
	});

	it("resolves bundled host module through wrapper script importing target CLI entry", () => {
		const hostRoot = tempDir("pi-cpa-wrapper-root-");
		const targetCli = join(hostRoot, "bundle", "cli.js");
		const codexModule = join(
			hostRoot,
			"bundle",
			"node_modules",
			"@earendil-works",
			"pi-ai",
			"dist",
			"api",
			"openai-codex-responses.js",
		);
		const wrapper = join(hostRoot, "bin", "pi");

		writeFile(targetCli, "export {}\n");
		writeFile(codexModule, "export {}\n");
		writeFile(
			wrapper,
			`import { join } from "node:path";\nconst cliPath = ${JSON.stringify(targetCli)};\nawait import(cliPath);\n`,
		);

		expect(resolveCodexModuleFromNodeEntry(wrapper)).toBe(codexModule);
	});

	it("resolves multi-argument join(homedir(), '.pi', 'wrapped', ...) and USERPROFILE wrapper scripts", () => {
		const home = tempDir("pi-cpa-home-join-");
		const userProfile = tempDir("pi-cpa-userprofile-join-");
		const wrappedCli = join(
			home,
			".pi",
			"wrapped",
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			"dist",
			"cli.js",
		);
		const wrappedCodex = join(
			home,
			".pi",
			"wrapped",
			"node_modules",
			"@earendil-works",
			"pi-ai",
			"dist",
			"api",
			"openai-codex-responses.js",
		);
		const profileCli = join(
			userProfile,
			".pi",
			"wrapped",
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			"dist",
			"cli.js",
		);
		const profileCodex = join(
			userProfile,
			".pi",
			"wrapped",
			"node_modules",
			"@earendil-works",
			"pi-ai",
			"dist",
			"api",
			"openai-codex-responses.js",
		);
		const homedirWrapper = join(home, "bin", "pi-homedir");
		const envHomeWrapper = join(home, "bin", "pi-env-home");
		const userProfileWrapper = join(home, "bin", "pi-userprofile");
		writeFile(wrappedCli, "export {}\n");
		writeFile(wrappedCodex, "export {}\n");
		writeFile(profileCli, "export {}\n");
		writeFile(profileCodex, "export {}\n");
		writeFile(
			homedirWrapper,
			`import { homedir } from "node:os";\nimport { join } from "node:path";\nconst entry = join(homedir(), ".pi", "wrapped", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");\nawait import(entry);\n`,
		);
		writeFile(
			envHomeWrapper,
			`import { join } from "node:path";\nconst entry = join(process.env.HOME, ".pi", "wrapped", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");\nawait import(entry);\n`,
		);
		writeFile(
			userProfileWrapper,
			`import { join } from "node:path";\nconst entry = join(process.env.USERPROFILE, ".pi", "wrapped", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");\nawait import(entry);\n`,
		);

		const prevHome = process.env.HOME;
		const prevUserProfile = process.env.USERPROFILE;
		try {
			process.env.HOME = home;
			process.env.USERPROFILE = home;
			expect(resolveCodexModuleFromNodeEntry(homedirWrapper)).toBe(wrappedCodex);

			process.env.HOME = home;
			process.env.USERPROFILE = userProfile;
			expect(resolveCodexModuleFromNodeEntry(envHomeWrapper)).toBe(wrappedCodex);
			expect(resolveCodexModuleFromNodeEntry(userProfileWrapper)).toBe(profileCodex);
		} finally {
			if (prevHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = prevHome;
			}
			if (prevUserProfile === undefined) {
				delete process.env.USERPROFILE;
			} else {
				process.env.USERPROFILE = prevUserProfile;
			}
		}
	});

	it("resolves physical pi-ai module when pi aliases @earendil-works/pi-ai to pi-ai-extension-view.js", () => {
		const hostRoot = tempDir("pi-cpa-pi15-root-");
		const runnerRoot = tempDir("pi-cpa-pi15-runner-");
		const extensionView = join(
			hostRoot,
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			"dist",
			"core",
			"extensions",
			"pi-ai-extension-view.js",
		);
		const hostCodex = join(
			hostRoot,
			"node_modules",
			"@earendil-works",
			"pi-ai",
			"dist",
			"api",
			"openai-codex-responses.js",
		);
		const subagentRunner = join(runnerRoot, "subagent-runner", "runner.js");
		writeFile(extensionView, "export {}\n");
		writeFile(hostCodex, "export {}\n");
		writeFile(subagentRunner, "export {}\n");

		const resolvedSpecifiers: string[] = [];
		const resolved = resolveOriginalCodexModulePath({
			nodeEntry: subagentRunner,
			homeDirectory: tempDir("pi-cpa-empty-home-"),
			resolveSpecifier: (specifier) => {
				resolvedSpecifiers.push(specifier);
				if (specifier === "@earendil-works/pi-ai") {
					return pathToFileURL(extensionView).href;
				}
				throw Object.assign(new Error(`Cannot find module '${specifier}'`), { code: "ERR_MODULE_NOT_FOUND" });
			},
		});

		expect(resolvedSpecifiers).toContain("@earendil-works/pi-ai");
		expect(resolved.path).toBe(hostCodex);
	});

	it("resolves managed Pi installation under HOME/.pi/agent/install/releases/<current-version> and launcher script", () => {
		const home = tempDir("pi-cpa-managed-home-");
		const runnerRoot = tempDir("pi-cpa-managed-runner-");
		const subagentRunner = join(runnerRoot, "runner.js");
		const managedLauncher = join(home, ".pi", "agent", "bin", "pi");
		const managedVersionFile = join(home, ".pi", "agent", "install", "current-version");
		const managedPackageJson = join(home, ".pi", "agent", "install", "releases", "1.5.0", "package.json");
		const managedCodex = join(
			home,
			".pi",
			"agent",
			"install",
			"releases",
			"1.5.0",
			"node_modules",
			"@earendil-works",
			"pi-ai",
			"dist",
			"api",
			"openai-codex-responses.js",
		);
		writeFile(subagentRunner, "export {}\n");
		writeFile(managedLauncher, "#!/bin/sh\n");
		writeFile(managedVersionFile, "1.5.0\n");
		writeFile(managedPackageJson, "{}\n");
		writeFile(managedCodex, "export {}\n");

		expect(resolveCodexModuleFromNodeEntry(managedLauncher)).toBe(managedCodex);

		const resolved = resolveOriginalCodexModulePath({
			resolveSpecifier: failingResolveSpecifier,
			nodeEntry: subagentRunner,
			homeDirectory: home,
		});

		expect(resolved.path).toBe(managedCodex);
	});
});

describe("writePatchedModuleCache", () => {
	it("rewrites a bare partial-json import so a tmpdir cache can load it", async () => {
		const home = tempDir("pi-cpa-bare-home-");
		const cacheDir = tempDir("pi-cpa-bare-cache-");
		const { codexPath, partialJsonPath } = writeAgentNpmCodexTree(home);
		const cachePath = join(cacheDir, "patched-bare.mjs");

		writePatchedModuleCache(
			cachePath,
			`import { parse } from "partial-json";\nexport const parsed = parse("x");\n`,
			codexPath,
		);

		const rewritten = readFileSync(cachePath, "utf8");
		expect(rewritten).toContain(pathToFileURL(partialJsonPath).href);
		expect(rewritten).not.toContain('from "partial-json"');

		const loaded = (await import(pathToFileURL(cachePath).href)) as { parsed: { ok: boolean; text: string } };
		expect(loaded.parsed).toEqual({ ok: true, text: "x" });
	});

	it("resolves partial-json after locating openai-codex-responses via HOME/.pi/agent/npm and writing the cache outside that tree", async () => {
		const home = tempDir("pi-cpa-graph-home-");
		const hostDir = tempDir("pi-cpa-graph-host-");
		const cacheDir = tempDir("pi-cpa-graph-cache-");
		const { codexPath, jsonParsePath } = writeAgentNpmCodexTree(home);

		const resolved = resolveOriginalCodexModulePath({
			resolveSpecifier: failingResolveSpecifier,
			nodeEntry: writeNativeHost(hostDir),
			homeDirectory: home,
		});
		expect(resolved.path).toBe(codexPath);

		const cachePath = join(cacheDir, "openai-codex-responses-cpa-test.mjs");
		writePatchedModuleCache(cachePath, readFileSync(resolved.path, "utf8"), resolved.path);

		const entrySource = readFileSync(cachePath, "utf8");
		expect(entrySource).not.toContain('from "../utils/json-parse.js"');
		expect(entrySource).toContain(pathToFileURL(jsonParsePath).href);

		const loaded = (await import(pathToFileURL(cachePath).href)) as {
			streamSimple: () => { ok: boolean; text: string };
		};
		expect(loaded.streamSimple()).toEqual({ ok: true, text: '{"ok":' });
	});

	it("preserves shared module identity so session-resources cleanup reaches patched streams", async () => {
		const home = tempDir("pi-cpa-shared-home-");
		const cacheDir = tempDir("pi-cpa-shared-cache-");
		const codexPath = join(home, ".pi", "agent", "npm", CODEX_RELATIVE);
		const sessionResourcesPath = join(dirname(dirname(codexPath)), "session-resources.js");

		writeFile(
			sessionResourcesPath,
			`export const cleanups = new Set();
export function registerCleanup(fn) { cleanups.add(fn); }
export function runCleanups() { for (const fn of cleanups) fn(); }
`,
		);

		writeFile(
			codexPath,
			`import { registerCleanup } from "../session-resources.js";
export function registerHook(fn) { registerCleanup(fn); }
`,
		);

		const cachePath = join(cacheDir, "openai-codex-responses-cpa-test.mjs");
		writePatchedModuleCache(cachePath, readFileSync(codexPath, "utf8"), codexPath);

		// Host imports original module directly
		const hostModule = (await import(pathToFileURL(sessionResourcesPath).href)) as {
			cleanups: Set<() => void>;
			runCleanups: () => void;
		};

		// Patched cache module registers into session resources
		const patchedModule = (await import(pathToFileURL(cachePath).href)) as {
			registerHook: (fn: () => void) => void;
		};

		let cleanedUp = false;
		patchedModule.registerHook(() => {
			cleanedUp = true;
		});

		expect(hostModule.cleanups.size).toBe(1);
		hostModule.runCleanups();
		expect(cleanedUp).toBe(true);
	});

	it("isolates cache keys across different installation paths using production hashing", async () => {
		const homeA = tempDir("pi-cpa-inst-a-");
		const homeB = tempDir("pi-cpa-inst-b-");
		const { codexPath: codexPathA } = writeAgentNpmCodexTree(homeA);
		const { codexPath: codexPathB } = writeAgentNpmCodexTree(homeB);

		// Same content, different locations
		expect(readFileSync(codexPathA, "utf8")).toBe(readFileSync(codexPathB, "utf8"));

		const cacheDir = tempDir("pi-cpa-dual-cache-");
		const source = readFileSync(codexPathA, "utf8");

		const outPathA = computePatchedModuleCachePath(codexPathA, source, cacheDir);
		const outPathB = computePatchedModuleCachePath(codexPathB, source, cacheDir);

		// Cache paths must be different because originalPath is hashed
		expect(outPathA).not.toBe(outPathB);

		writePatchedModuleCache(outPathA, source, codexPathA);
		writePatchedModuleCache(outPathB, source, codexPathB);

		const sourceA = readFileSync(outPathA, "utf8");
		const sourceB = readFileSync(outPathB, "utf8");

		expect(sourceA).not.toBe(sourceB);
		expect(sourceA).toContain(pathToFileURL(homeA).href);
		expect(sourceB).toContain(pathToFileURL(homeB).href);

		// Removing install A does not affect install B
		rmSync(homeA, { recursive: true, force: true });
		const loadedB = (await import(pathToFileURL(outPathB).href)) as {
			streamSimple: () => { ok: boolean; text: string };
		};
		expect(loadedB.streamSimple()).toEqual({ ok: true, text: '{"ok":' });
	});
});

describe("patchCodexSource", () => {
	function installedSource(): string {
		const { path } = resolveOriginalCodexModulePath();
		return readFileSync(path, "utf8");
	}

	it("keeps pi's own configuration_update wiring and adds none of its own", () => {
		const patched = patchCodexSource(installedSource(), ["provimux"]);
		expect(patched).toContain("const configurationUpdateEffort = getConfigurationUpdateEffort(");
		expect(patched).not.toContain("cpaGetConfigurationUpdateEffort");
		expect(patched).not.toContain("CPA_CONFIGURATION_UPDATE_REQUEST_EFFORT");
	});

	it("adds the provider ids to CODEX_TOOL_CALL_PROVIDERS", () => {
		const patched = patchCodexSource(installedSource(), ["provimux-getConfigurationUpdateEffort"]);
		expect(patched).toMatch(
			/const CODEX_TOOL_CALL_PROVIDERS = new Set\(\[[^\]]*"provimux-getConfigurationUpdateEffort"\]\);/,
		);
	});
});

interface CapturedRequest {
	url: string;
	body: Record<string, any>;
}

function cannedSseFetch(captured: CapturedRequest[]): typeof fetch {
	return async (input, init) => {
		const rawBody = init?.body;
		let text: string;
		if (typeof rawBody === "string") {
			text = rawBody;
		} else if (rawBody instanceof Uint8Array) {
			const { zstdDecompressSync } = await import("node:zlib");
			text = zstdDecompressSync(rawBody).toString("utf8");
		} else {
			text = "{}";
		}
		captured.push({ url: String(input), body: JSON.parse(text) });

		const messageItem = {
			type: "message",
			id: `msg_turn_${captured.length}`,
			role: "assistant",
			content: [{ type: "output_text", text: `reply ${captured.length}`, annotations: [] }],
			status: "completed",
		};
		const events = [
			{ type: "response.output_item.done", output_index: 0, item: messageItem },
			{
				type: "response.completed",
				response: {
					id: `resp_turn_${captured.length}`,
					status: "completed",
					output: [messageItem],
					usage: {
						input_tokens: 12,
						output_tokens: 3,
						total_tokens: 15,
						input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
						output_tokens_details: { reasoning_tokens: 1 },
					},
				},
			},
		];
		const payload = `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
		return new Response(payload, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
}

function midConvoModel(supportsMidConvoEffort: boolean): any {
	return {
		id: "gpt-6-sol",
		name: "GPT-6 Sol",
		api: "provimux-codex-responses",
		provider: "provimux",
		baseUrl: "http://127.0.0.1:8317",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
		thinkingLevelMap: { off: "none", low: "low", medium: "medium", high: "high" },
		...(supportsMidConvoEffort ? { compat: { supportsMidConvoEffort: true } } : {}),
	};
}

function systemMessage(): any {
	return { role: "system", content: "You are a test harness.", timestamp: 0 };
}

function userMessage(text: string): any {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function developerItem(text: string) {
	return { type: "message", role: "developer", content: [{ type: "input_text", text }] };
}

function configurationUpdates(body: Record<string, any>): string[] {
	const input = Array.isArray(body.input) ? body.input : [];
	return input.filter((item: any) => item?.type === "configuration_update").map((item: any) => item.reasoning?.effort);
}

function configurationUpdateIndices(body: Record<string, any>): number[] {
	const input = Array.isArray(body.input) ? body.input : [];
	return input.flatMap((item: any, index: number) => (item?.type === "configuration_update" ? [index] : []));
}

function userItemIndex(body: Record<string, any>, text: string): number {
	const input = Array.isArray(body.input) ? body.input : [];
	return input.findIndex((item: any) => item?.role === "user" && JSON.stringify(item).includes(text));
}

function wireUserItemIndex(body: Record<string, any>, text: string): number {
	const input = Array.isArray(body.input) ? body.input : [];
	return input.findIndex((item: any) => {
		if (item?.role === "user") return JSON.stringify(item).includes(text);
		return (
			Array.isArray(item?.content) &&
			item.content.some((c: any) => c?.type === "input_text" && String(c.text ?? "").includes(text))
		);
	});
}

describe("reshapeConfigurationUpdates", () => {
	const update = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });
	const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
	const assistant = (text: string) => ({
		type: "message",
		role: "assistant",
		content: [{ type: "output_text", text }],
	});

	it("promotes the first turn effort to the request level", () => {
		// OpenAI documentation example shape: first user turn runs at the
		// request-level effort, the follow-up switches via configuration_update.
		const body = reshapeConfigurationUpdates({
			model: "gpt-6-astra",
			reasoning: { effort: MID_CONVO_BASELINE_EFFORT, summary: "auto" },
			input: [
				user("Draft a database migration plan."),
				update("low"),
				assistant("ok"),
				update("high"),
				user("Analyze failure modes"),
			],
		});
		expect(body.reasoning).toEqual({ effort: "low", summary: "auto" });
		expect(configurationUpdates(body)).toEqual(["high"]);
		expect(configurationUpdateIndices(body)).toEqual([2]);
		expect(userItemIndex(body, "Analyze failure modes")).toBe(3);
	});

	it("collapses repeated efforts and pulls the trailing change before its user message", () => {
		const body = reshapeConfigurationUpdates({
			model: "gpt-6-sol",
			reasoning: { effort: MID_CONVO_BASELINE_EFFORT },
			input: [
				user("one"),
				update("high"),
				assistant("a1"),
				update("high"),
				user("two"),
				update("high"),
				assistant("a2"),
				update("xhigh"),
				user("three"),
				update("xhigh"),
			],
		});
		expect(body.reasoning).toEqual({ effort: "high" });
		expect(configurationUpdates(body)).toEqual(["xhigh"]);
		expect(configurationUpdateIndices(body)).toEqual([4]);

		const trailingChange = reshapeConfigurationUpdates({
			model: "gpt-6-sol",
			reasoning: { effort: MID_CONVO_BASELINE_EFFORT },
			input: [user("one"), update("high"), assistant("a1"), user("two"), update("xhigh")],
		});
		expect(configurationUpdates(trailingChange)).toEqual(["xhigh"]);
		expect(configurationUpdateIndices(trailingChange)).toEqual([2]);
		expect(userItemIndex(trailingChange, "two")).toBe(3);
	});

	it("leaves bodies without configuration updates untouched", () => {
		const body = { model: "m", reasoning: { effort: "high" }, input: [user("one")] };
		expect(reshapeConfigurationUpdates(body)).toBe(body);
	});

	it("reshapes the captured request log shape with a tool turn", () => {
		// Mirrors a captured request log: converter layout for turns run at
		// high then xhigh, the second turn ending in tool output.
		const body = reshapeConfigurationUpdates({
			model: "gpt-6-sol",
			reasoning: { effort: MID_CONVO_BASELINE_EFFORT, summary: "auto" },
			input: [
				user("hello"),
				update("high"),
				assistant("a1"),
				user("model?"),
				update("xhigh"),
				{ type: "function_call", call_id: "c1", name: "whoami", arguments: "{}" },
				{ type: "function_call_output", call_id: "c1", output: "gpt" },
				update("xhigh"),
			],
		});
		expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
		expect(configurationUpdates(body)).toEqual(["xhigh"]);
		// The surviving update sits immediately before the second user item.
		expect(configurationUpdateIndices(body)).toEqual([2]);
		expect(userItemIndex(body, "model?")).toBe(3);
		expect((body.input as any[]).map((item: any) => item.type ?? item.role)).toEqual([
			"user",
			"message",
			"configuration_update",
			"user",
			"function_call",
			"function_call_output",
		]);
	});

	it("keeps a bare function_call turn's update on its own user item", () => {
		const body = reshapeConfigurationUpdates({
			model: "gpt-6-sol",
			reasoning: { effort: MID_CONVO_BASELINE_EFFORT },
			input: [
				user("one"),
				update("high"),
				assistant("a1"),
				user("two"),
				update("xhigh"),
				{ type: "function_call", call_id: "c1", name: "t", arguments: "{}" },
				{ type: "function_call_output", call_id: "c1", output: "o" },
				user("three"),
				update("xhigh"),
			],
		});
		expect(body.reasoning).toEqual({ effort: "high" });
		expect(configurationUpdates(body)).toEqual(["xhigh"]);
		const updateIndex = configurationUpdateIndices(body)[0];
		expect(userItemIndex(body, "two")).toBe(updateIndex + 1);
	});

	it("keeps a mid-tool-loop change at the end instead of rewriting history", () => {
		const body = reshapeConfigurationUpdates({
			model: "gpt-6-sol",
			reasoning: { effort: MID_CONVO_BASELINE_EFFORT },
			input: [
				user("one"),
				update("low"),
				{ type: "function_call", call_id: "c1", name: "t", arguments: "{}" },
				{ type: "function_call_output", call_id: "c1", output: "o" },
				update("high"),
			],
		});
		expect(body.reasoning).toEqual({ effort: "low" });
		expect(configurationUpdates(body)).toEqual(["high"]);
		const items = body.input as any[];
		expect(items[items.length - 1].type).toBe("configuration_update");
		expect(userItemIndex(body, "one")).toBe(0);
	});

	it("preserves a return to an earlier effort in docs-shaped input", () => {
		const body = reshapeConfigurationUpdates({
			model: "gpt-6-astra",
			reasoning: { effort: "low" },
			input: [
				user("one"),
				update("low"),
				assistant("a1"),
				update("high"),
				user("two"),
				assistant("a2"),
				user("three"),
				update("low"),
			],
		});
		expect(body.reasoning).toEqual({ effort: "low" });
		expect(configurationUpdates(body)).toEqual(["high", "low"]);
		const indices = configurationUpdateIndices(body);
		expect(userItemIndex(body, "two")).toBe(indices[0] + 1);
		expect(userItemIndex(body, "three")).toBe(indices[1] + 1);
	});

	it("replays a tool-continuation update after its tool-output block", () => {
		// Request N+1 form of the mid-tool-loop change: the update must stay
		// after the tool outputs so the transmitted prefix never changes.
		const body = reshapeConfigurationUpdates({
			model: "gpt-6-sol",
			reasoning: { effort: MID_CONVO_BASELINE_EFFORT },
			input: [
				user("one"),
				update("low"),
				{ type: "function_call", call_id: "c1", name: "t", arguments: "{}" },
				{ type: "function_call_output", call_id: "c1", output: "o" },
				update("high"),
				assistant("a1"),
				user("two"),
				update("high"),
			],
		});
		expect(body.reasoning).toEqual({ effort: "low" });
		expect(configurationUpdates(body)).toEqual(["high"]);
		expect((body.input as any[]).map((item: any) => item.type ?? item.role)).toEqual([
			"user",
			"function_call",
			"function_call_output",
			"configuration_update",
			"message",
			"user",
		]);
	});

	it("keeps tool-continuation updates after trailing metadata on replay", () => {
		const developer = { role: "developer", content: [{ type: "input_text", text: "meta" }] };
		const body = reshapeConfigurationUpdates({
			model: "gpt-6-sol",
			reasoning: { effort: MID_CONVO_BASELINE_EFFORT },
			input: [
				user("one"),
				update("low"),
				{ type: "function_call", call_id: "c1", name: "t", arguments: "{}" },
				{ type: "function_call_output", call_id: "c1", output: "o" },
				developer,
				update("high"),
				assistant("a1"),
				user("two"),
				update("high"),
			],
		});
		expect(body.reasoning).toEqual({ effort: "low" });
		expect(configurationUpdates(body)).toEqual(["high"]);
		expect((body.input as any[]).map((item: any) => item.type ?? item.role)).toEqual([
			"user",
			"function_call",
			"function_call_output",
			"developer",
			"configuration_update",
			"message",
			"user",
		]);
	});

	it("keeps orphan updates at their chronological boundaries", () => {
		const body = reshapeConfigurationUpdates({
			model: "gpt-6-sol",
			reasoning: { effort: MID_CONVO_BASELINE_EFFORT },
			input: [
				update("low"),
				assistant("a0"),
				update("high"),
				assistant("a1"),
				user("one"),
				update("low"),
				assistant("a2"),
				update("low"),
			],
		});
		expect(body.reasoning).toEqual({ effort: "low" });
		expect(configurationUpdates(body)).toEqual(["high", "low"]);
		// The orphan high update stays between the two leading assistant items.
		expect((body.input as any[]).map((item: any) => item.type ?? item.role)).toEqual([
			"message",
			"configuration_update",
			"message",
			"configuration_update",
			"user",
			"message",
		]);
	});

	it("does not treat typed user messages as assistant output", () => {
		const body = reshapeConfigurationUpdates({
			model: "gpt-6-sol",
			reasoning: { effort: MID_CONVO_BASELINE_EFFORT },
			input: [
				user("one"),
				update("low"),
				assistant("a1"),
				update("high"),
				{ type: "message", role: "user", content: [{ type: "output_text", text: "two" }] },
				update("high"),
			],
		});
		expect(body.reasoning).toEqual({ effort: "low" });
		expect(configurationUpdates(body)).toEqual(["high"]);
		const updateIndex = configurationUpdateIndices(body)[0];
		expect(userItemIndex(body, "two")).toBe(updateIndex + 1);
		// The update must not move before the first user item.
		expect(userItemIndex(body, "one")).toBe(0);
	});

	it("seeds effort tracking from orphan updates", () => {
		const body = reshapeConfigurationUpdates({
			model: "gpt-6-sol",
			reasoning: { effort: MID_CONVO_BASELINE_EFFORT },
			input: [
				update("low"),
				assistant("a0"),
				update("high"),
				assistant("a1"),
				user("one"),
				update("low"),
				assistant("a2"),
				update("low"),
			],
		});
		expect(body.reasoning).toEqual({ effort: "low" });
		expect(configurationUpdates(body)).toEqual(["high", "low"]);
		const updateIndex = configurationUpdateIndices(body)[1];
		expect(userItemIndex(body, "one")).toBe(updateIndex + 1);
	});

	it("promotes a lone trailing update to the request level", () => {
		// First request of a session whose first turn is still in a tool loop:
		// the only update is the first turn's effort, so it becomes the
		// request-level effort and no update item remains.
		const body = reshapeConfigurationUpdates({
			model: "gpt-6-sol",
			reasoning: { effort: MID_CONVO_BASELINE_EFFORT },
			input: [
				user("one"),
				{ type: "function_call", call_id: "c1", name: "t", arguments: "{}" },
				{ type: "function_call_output", call_id: "c1", output: "o" },
				update("high"),
			],
		});
		expect(body.reasoning).toEqual({ effort: "high" });
		expect(configurationUpdates(body)).toEqual([]);
	});

	it("falls back to the baseline when the first effort is missing", () => {
		const body = reshapeConfigurationUpdates({
			model: "m",
			input: [user("one"), { type: "configuration_update", reasoning: {} }, assistant("a1")],
		});
		expect((body as { reasoning?: unknown }).reasoning).toEqual({
			effort: MID_CONVO_BASELINE_EFFORT,
			summary: "auto",
		});
		expect(configurationUpdates(body)).toEqual([]);
	});
});

describe("GPT Responses prompt caching", () => {
	const systemPrompt = "  Follow the project's rules.\n\n";
	const sseOptions = (captured: CapturedRequest[]): SimpleStreamOptions => ({
		apiKey: "sk-test",
		transport: "sse",
		fetch: cannedSseFetch(captured),
		sessionId: "gpt-prompt-test",
	});

	it.each([
		{ id: "  GpT-6-sol  ", prompt: systemPrompt },
		{ id: "gpt-6-sol", prompt: " \n\t" },
		{ id: "custom-gpt-6-sol", prompt: systemPrompt },
	])("serializes the base prompt for $id", async ({ id, prompt }) => {
		const streams = await loadProvimuxCodexStreams();
		const captured: CapturedRequest[] = [];
		const result = await streams
			.streamSimple(
				{ ...midConvoModel(false), id },
				{
					systemPrompt: prompt,
					messages: [userMessage("question")],
					tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }],
				},
				sseOptions(captured),
			)
			.result();

		expect(result.errorMessage).toBeUndefined();
		expect(captured).toHaveLength(1);
		const { body } = captured[0];
		expect(body.model).toBe(id);
		expect(body.prompt_cache_key).toBe("gpt-prompt-test");
		expect(body.tools).toEqual([expect.objectContaining({ type: "function", name: "read" })]);
		const user = { role: "user", content: [{ type: "input_text", text: "question" }] };
		// pi puts the prompt, as given, in its own leading developer item for every model; it is sent as is.
		expect(body).not.toHaveProperty("instructions");
		expect(body.input).toEqual([piDeveloperItem(prompt), user]);
	});

	it.each(["priority", "ultrafast"] as const)("applies %s before the caller's SSE payload hook", async (tier) => {
		const streams = await loadProvimuxCodexStreams(["provimux"], { resolveServiceTier: () => tier });
		const captured: CapturedRequest[] = [];
		const leading = [developerItem("first rule"), developerItem("second rule")];
		const update = developerItem("mid-session rule");
		const result = await streams
			.stream(
				{ ...midConvoModel(false), id: "other-model" },
				{ messages: [userMessage("first"), userMessage("second")] },
				{
					...sseOptions(captured),
					onPayload: async (payload) => {
						const body = payload as Record<string, any>;
						expect(body.service_tier).toBe(tier);
						const [first, second] = body.input;
						return {
							...body,
							model: "gpt-hook-model",
							instructions: systemPrompt,
							service_tier: "default",
							input: [...leading, first, update, second],
						};
					},
				},
			)
			.result();

		expect(result.errorMessage).toBeUndefined();
		const { body } = captured[0];
		expect(body.model).toBe("gpt-hook-model");
		expect(body.service_tier).toBe("default");
		expect(body).not.toHaveProperty("instructions");
		expect(body.input).toEqual([
			developerItem(systemPrompt),
			...leading,
			{ role: "user", content: [{ type: "input_text", text: "first" }] },
			update,
			{ role: "user", content: [{ type: "input_text", text: "second" }] },
		]);
	});

	it("honours a hook that deletes instructions before an existing transcript developer message", async () => {
		const streams = await loadProvimuxCodexStreams();
		const captured: CapturedRequest[] = [];
		const extra = "Keep answers concise.";
		const result = await streams
			.rawStreamSimple(
				{ ...midConvoModel(false), compat: { supportsMidConvoSystemMessages: true } },
				{
					messages: [
						{ ...systemMessage(), content: systemPrompt },
						{ ...systemMessage(), content: extra },
						userMessage("question"),
					],
				},
				{
					...sseOptions(captured),
					onPayload: (payload) => {
						const body = payload as Record<string, any>;
						delete body.instructions;
						return { ...body, input: body.input.map((item: object) => ({ ...item })) };
					},
				},
			)
			.result();

		expect(result.errorMessage).toBeUndefined();
		const { body } = captured[0];
		expect(body).not.toHaveProperty("instructions");
		expect(body.input).toEqual([
			// pi builds no instructions: the base prompt is already its first input item, which the hook kept.
			piDeveloperItem(systemPrompt),
			{ role: "developer", content: extra },
			{ role: "user", content: [{ type: "input_text", text: "question" }] },
		]);
	});

	it("sends only a hook's replacement when it removes instructions and supplies its own developer message", async () => {
		const streams = await loadProvimuxCodexStreams();
		const captured: CapturedRequest[] = [];
		const replacement = developerItem("Replacement prompt.");
		const result = await streams
			.streamSimple(
				midConvoModel(false),
				{ systemPrompt, messages: [userMessage("question")] },
				{
					...sseOptions(captured),
					onPayload: (payload) => {
						const { instructions, ...rest } = payload as Record<string, any>;
						expect(instructions).toBeUndefined();
						return { ...rest, input: [replacement, ...rest.input] };
					},
				},
			)
			.result();

		expect(result.errorMessage).toBeUndefined();
		const { body } = captured[0];
		expect(body).not.toHaveProperty("instructions");
		expect(body.input).toEqual([
			replacement,
			// The base prompt is pi's own input item, which this hook keeps.
			piDeveloperItem(systemPrompt),
			{ role: "user", content: [{ type: "input_text", text: "question" }] },
		]);
	});

	it("still moves the base prompt when a hook rewrites the body but leaves instructions as built", async () => {
		const streams = await loadProvimuxCodexStreams();
		const captured: CapturedRequest[] = [];
		const result = await streams
			.streamSimple(
				midConvoModel(false),
				{ systemPrompt, messages: [userMessage("question")] },
				{
					...sseOptions(captured),
					onPayload: (payload) => ({ ...(payload as object), metadata: { tagged: "yes" } }),
				},
			)
			.result();

		expect(result.errorMessage).toBeUndefined();
		const { body } = captured[0];
		expect(body).not.toHaveProperty("instructions");
		expect(body.metadata).toEqual({ tagged: "yes" });
		expect(body.input).toEqual([
			piDeveloperItem(systemPrompt),
			{ role: "user", content: [{ type: "input_text", text: "question" }] },
		]);
	});

	const additionalTools = { type: "additional_tools", role: "developer", tools: [] };
	const explicitDeveloper = developerItem(systemPrompt);
	const implicitDeveloper = { role: "developer", content: systemPrompt };
	// The hook finds no instructions and pi's developer item first: what it adds goes before that
	// item, which stays. When the first item is then not a developer message (the tool item), the extension puts its
	// default base prompt in front, as it does for any GPT request that starts without one.
	const piBase = piDeveloperItem(systemPrompt);
	const defaultBase = developerItem("You are a helpful assistant.");
	it.each([
		{ name: "instructions are deleted", remove: true, prefix: [], expected: [piBase] },
		{
			name: "instructions are unset and a developer-role tool item leads",
			prefix: [additionalTools],
			expected: [defaultBase, additionalTools, piBase],
		},
		{
			name: "the base is moved to a typed developer message",
			prefix: [explicitDeveloper],
			expected: [explicitDeveloper, piBase],
		},
		{
			name: "the base is moved to an untyped developer message",
			prefix: [implicitDeveloper],
			expected: [implicitDeveloper, piBase],
		},
	])("sends what an in-place hook left when $name", async ({ remove, prefix, expected }) => {
		const streams = await loadProvimuxCodexStreams();
		const captured: CapturedRequest[] = [];
		const result = await streams
			.rawStreamSimple(
				midConvoModel(false),
				{ systemPrompt, messages: [userMessage("question")] },
				{
					...sseOptions(captured),
					onPayload: (payload) => {
						const body = payload as Record<string, any>;
						if (remove) delete body.instructions;
						else body.instructions = undefined;
						body.input.unshift(...prefix);
					},
				},
			)
			.result();

		expect(result.errorMessage).toBeUndefined();
		const { body } = captured[0];
		expect(body).not.toHaveProperty("instructions");
		expect(body.input).toEqual([...expected, { role: "user", content: [{ type: "input_text", text: "question" }] }]);
	});

	it("keeps text input supplied by a raw stream payload hook", async () => {
		const streams = await loadProvimuxCodexStreams();
		const captured: CapturedRequest[] = [];
		const result = await streams
			.rawStream(
				midConvoModel(false),
				{ messages: [] },
				{
					...sseOptions(captured),
					onPayload: (payload) => ({ ...(payload as object), instructions: systemPrompt, input: "question" }),
				},
			)
			.result();

		expect(result.errorMessage).toBeUndefined();
		const { body } = captured[0];
		expect(body).not.toHaveProperty("instructions");
		expect(body.input).toEqual([
			developerItem(systemPrompt),
			{ role: "user", content: [{ type: "input_text", text: "question" }] },
		]);
	});
});

describe("mid-convo effort streams", () => {
	it("promotes the first effort to the request level and keeps later changes before their user message", async () => {
		const streams = await loadProvimuxCodexStreams(["provimux"]);
		const captured: CapturedRequest[] = [];
		const fetchImpl = cannedSseFetch(captured);
		const model = midConvoModel(true);

		const first = await streams
			.streamSimple(model, { messages: [systemMessage(), userMessage("first question")] }, {
				apiKey: "sk-test",
				transport: "sse",
				reasoning: "low",
				fetch: fetchImpl,
				sessionId: "mid-convo-test",
			} as any)
			.result();

		expect(first.errorMessage).toBeUndefined();
		expect(first.providerThinkingLevel).toBe("low");
		expect(captured).toHaveLength(1);
		expect(captured[0].body.reasoning?.effort).toBe("low");
		expect(configurationUpdates(captured[0].body)).toEqual([]);
		expect(captured[0].body.prompt_cache_key).toBe("mid-convo-test");

		const second = await streams
			.streamSimple(
				model,
				{ messages: [systemMessage(), userMessage("first question"), first, userMessage("second question")] },
				{
					apiKey: "sk-test",
					transport: "sse",
					reasoning: "high",
					fetch: fetchImpl,
					sessionId: "mid-convo-test",
				} as any,
			)
			.result();

		expect(second.errorMessage).toBeUndefined();
		expect(second.providerThinkingLevel).toBe("high");
		expect(captured).toHaveLength(2);
		expect(captured[1].body.reasoning?.effort).toBe("low");
		expect(configurationUpdates(captured[1].body)).toEqual(["high"]);
		const updateIndex = configurationUpdateIndices(captured[1].body)[0];
		expect(wireUserItemIndex(captured[1].body, "second question")).toBe(updateIndex + 1);
		expect(captured[1].body.prompt_cache_key).toBe("mid-convo-test");

		const third = await streams
			.streamSimple(
				model,
				{
					messages: [
						systemMessage(),
						userMessage("first question"),
						first,
						userMessage("second question"),
						second,
						userMessage("third question"),
					],
				},
				{
					apiKey: "sk-test",
					transport: "sse",
					reasoning: "high",
					fetch: fetchImpl,
					sessionId: "mid-convo-test",
				} as any,
			)
			.result();

		expect(third.errorMessage).toBeUndefined();
		expect(captured).toHaveLength(3);
		expect(captured[2].body.reasoning?.effort).toBe("low");
		expect(configurationUpdates(captured[2].body)).toEqual(["high"]);
		const replayedUpdateIndex = configurationUpdateIndices(captured[2].body)[0];
		expect(wireUserItemIndex(captured[2].body, "second question")).toBe(replayedUpdateIndex + 1);
	});

	it("a resumed conversation whose first effort the catalog no longer has: moved as pi moves it, never sent", async () => {
		// The review's case: the first turn ran at low; a catalog refresh then took low away from the model, and the
		// conversation resumes with medium. pi recovers low from the history as the request-level effort.
		const streams = await loadProvimuxCodexStreams(["provimux"]);
		const captured: CapturedRequest[] = [];
		const fetchImpl = cannedSseFetch(captured);
		const before = midConvoModel(true);
		const options = (reasoning: string) =>
			({ apiKey: "sk-test", transport: "sse", reasoning, fetch: fetchImpl, sessionId: "refreshed-catalog" }) as any;
		const first = await streams
			.streamSimple(before, { messages: [systemMessage(), userMessage("first question")] }, options("low"))
			.result();
		expect(first.providerThinkingLevel).toBe("low");

		const after = midConvoModel(true);
		after.thinkingLevelMap = { off: null, minimal: null, low: null, medium: "medium", high: "high", xhigh: null };
		const history = [systemMessage(), userMessage("first question"), first, userMessage("second question")];
		const resumed = await streams.streamSimple(after, { messages: history }, options("medium")).result();
		expect(resumed.errorMessage).toBeUndefined();
		expect(captured).toHaveLength(2);
		expect(captured[1].body.reasoning?.effort).toBe("medium");
		expect(configurationUpdates(captured[1].body)).toEqual([]);

		// A later change to a level the model has still goes as an update.
		const third = await streams
			.streamSimple(after, { messages: [...history, resumed, userMessage("third question")] }, options("high"))
			.result();
		expect(third.errorMessage).toBeUndefined();
		expect(captured[2].body.reasoning?.effort).toBe("medium");
		expect(configurationUpdates(captured[2].body)).toEqual(["high"]);
		for (const request of captured.slice(1)) {
			const efforts = [request.body.reasoning?.effort, ...configurationUpdates(request.body)];
			expect(efforts.filter((effort) => !["medium", "high"].includes(effort))).toEqual([]);
		}
	});

	it("keeps request-level effort for models without the compat flag", async () => {
		const streams = await loadProvimuxCodexStreams(["provimux"]);
		const captured: CapturedRequest[] = [];
		const result = await streams
			.streamSimple(midConvoModel(false), { messages: [systemMessage(), userMessage("question")] }, {
				apiKey: "sk-test",
				transport: "sse",
				reasoning: "high",
				fetch: cannedSseFetch(captured),
				sessionId: "classic-test",
			} as any)
			.result();

		expect(result.errorMessage).toBeUndefined();
		expect(result.providerThinkingLevel).toBeUndefined();
		expect(captured).toHaveLength(1);
		expect(captured[0].body.reasoning?.effort).toBe("high");
		expect(configurationUpdates(captured[0].body)).toEqual([]);
	});

	it("keeps request-level effort when thinking is off", async () => {
		const streams = await loadProvimuxCodexStreams(["provimux"]);
		const captured: CapturedRequest[] = [];
		const result = await streams
			.streamSimple(midConvoModel(true), { messages: [systemMessage(), userMessage("question")] }, {
				apiKey: "sk-test",
				transport: "sse",
				reasoning: "off",
				fetch: cannedSseFetch(captured),
				sessionId: "off-test",
			} as any)
			.result();

		expect(result.errorMessage).toBeUndefined();
		// pi records the level it sent, "none", on the reply.
		expect(result.providerThinkingLevel).toBe("none");
		expect(captured).toHaveLength(1);
		expect(captured[0].body.reasoning?.effort).toBe("none");
		expect(configurationUpdates(captured[0].body)).toEqual([]);
	});

	it("does not emit an update for a raw none effort when off is unsupported", async () => {
		const streams = await loadProvimuxCodexStreams(["provimux"]);
		const captured: CapturedRequest[] = [];
		const model = midConvoModel(true);
		model.thinkingLevelMap = { off: null, low: "low", medium: "medium", high: "high" };
		const result = await streams
			.stream(model, { messages: [systemMessage(), userMessage("question")] }, {
				apiKey: "sk-test",
				transport: "sse",
				reasoningEffort: "none",
				fetch: cannedSseFetch(captured),
				sessionId: "none-test",
			} as any)
			.result();

		expect(result.errorMessage).toBeUndefined();
		expect(result.providerThinkingLevel).toBeUndefined();
		expect(captured).toHaveLength(1);
		expect(captured[0].body.reasoning).toBeUndefined();
		expect(configurationUpdates(captured[0].body)).toEqual([]);
	});

	it("carries a raw none effort through a nonidentity off mapping", async () => {
		const streams = await loadProvimuxCodexStreams(["provimux"]);
		const captured: CapturedRequest[] = [];
		const model = midConvoModel(true);
		model.thinkingLevelMap = { off: "low", low: "low", medium: "medium", high: "high" };
		const result = await streams
			.stream(model, { messages: [systemMessage(), userMessage("question")] }, {
				apiKey: "sk-test",
				transport: "sse",
				reasoningEffort: "none",
				fetch: cannedSseFetch(captured),
				sessionId: "none-mapped-test",
			} as any)
			.result();

		expect(result.errorMessage).toBeUndefined();
		expect(result.providerThinkingLevel).toBe("low");
		expect(captured).toHaveLength(1);
		expect(captured[0].body.reasoning?.effort).toBe("low");
		expect(configurationUpdates(captured[0].body)).toEqual([]);
	});

	it("continues websocket on reasoning changes but resends full input on a developer prompt or model change", async () => {
		const sentFrames: Array<Record<string, any>> = [];
		let connections = 0;
		class FakeWebSocket extends EventTarget {
			readyState = 0;

			constructor(_url: string, _options?: unknown) {
				super();
				connections += 1;
				queueMicrotask(() => {
					this.readyState = 1;
					this.dispatchEvent(new Event("open"));
				});
			}

			send(data: string): void {
				const frame = JSON.parse(data) as Record<string, any>;
				sentFrames.push(frame);
				const turn = sentFrames.length;
				const messageItem = {
					type: "message",
					id: `msg_ws_${turn}`,
					role: "assistant",
					content: [{ type: "output_text", text: `ws reply ${turn}`, annotations: [] }],
					status: "completed",
				};
				const events = [
					{ type: "response.output_item.done", output_index: 0, item: messageItem },
					{
						type: "response.completed",
						response: {
							id: `resp_ws_${turn}`,
							status: "completed",
							output: [messageItem],
							usage: {
								input_tokens: 9,
								output_tokens: 2,
								total_tokens: 11,
								input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
								output_tokens_details: { reasoning_tokens: 1 },
							},
						},
					},
				];
				queueMicrotask(() => {
					for (const event of events) {
						this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
					}
				});
			}

			close(): void {
				this.readyState = 3;
			}
		}

		const originalWebSocket = globalThis.WebSocket;
		const originalTransport = process.env.PROVIMUX_TRANSPORT;
		(globalThis as any).WebSocket = FakeWebSocket;
		process.env.PROVIMUX_TRANSPORT = "websocket-cached";
		try {
			const streams = await loadProvimuxCodexStreams(["provimux"], { resolveServiceTier: () => "ultrafast" });
			try {
				const model = midConvoModel(true);
				const sessionId = `ws-mid-convo-${Date.now()}`;
				const history: Context["messages"] = [];
				let prompt = "You are a test harness.";
				const turn = async (question: string, reasoning: "low" | "high", turnModel = model) => {
					history.push(userMessage(question));
					const context = { systemPrompt: prompt, messages: history };
					const result = await streams
						.streamSimple(turnModel, context, { apiKey: "sk-test", sessionId, reasoning })
						.result();
					expect(result.errorMessage).toBeUndefined();
					expect(result.providerThinkingLevel).toBe(reasoning);
					history.push(result);
					const frame = sentFrames.at(-1)!;
					expect(frame).not.toHaveProperty("instructions");
					expect(frame.prompt_cache_key).toBe(sessionId);
					expect(frame.service_tier).toBe("ultrafast");
					return frame;
				};

				const first = await turn("first question", "low");
				expect(first.type).toBe("response.create");
				expect(first.reasoning?.effort).toBe("low");
				expect(configurationUpdates(first)).toEqual([]);
				expect(first).not.toHaveProperty("previous_response_id");
				const baseItem = piDeveloperItem;
				expect(first.input[0]).toEqual(baseItem(prompt));
				expect(wireUserItemIndex(first, "first question")).toBe(1);

				const second = await turn("second question", "high");
				expect(second.previous_response_id).toBe("resp_ws_1");
				expect(second.reasoning?.effort).toBe("low");
				expect(second.input).toHaveLength(2);
				expect(configurationUpdates(second)).toEqual(["high"]);
				expect(wireUserItemIndex(second, "second question")).toBe(1);

				prompt = "A changed base prompt.";
				const third = await turn("third question", "high");
				const fourth = await turn("fourth question", "high", { ...model, id: "gpt-other-model" });
				expect(fourth.model).toBe("gpt-other-model");
				for (const [frame, latestQuestion] of [
					[third, "third question"],
					[fourth, "fourth question"],
				] as const) {
					expect(frame).not.toHaveProperty("previous_response_id");
					expect(frame.input[0]).toEqual(baseItem(prompt));
					expect(wireUserItemIndex(frame, "first question")).toBe(1);
					expect(wireUserItemIndex(frame, latestQuestion)).toBe(frame.input.length - 1);
				}
				expect(sentFrames).toHaveLength(4);
				expect(connections).toBe(1);
			} finally {
				streams.closeOpenAICodexWebSocketSessions();
			}
		} finally {
			(globalThis as any).WebSocket = originalWebSocket;
			if (originalTransport === undefined) {
				delete process.env.PROVIMUX_TRANSPORT;
			} else {
				process.env.PROVIMUX_TRANSPORT = originalTransport;
			}
		}
	});
});

describe("loadProvimuxCodexStreams", () => {
	it("still loads the patched module from the installed package graph", async () => {
		const streams = await loadProvimuxCodexStreams(["provimux"]);
		expect(typeof streams.streamSimple).toBe("function");
		expect(typeof streams.stream).toBe("function");
		expect(streams.api).toBe("provimux-codex-responses");
	});
});
