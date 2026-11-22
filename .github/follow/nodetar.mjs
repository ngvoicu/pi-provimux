// npm's own tar reader, for tarball.mjs and load.mjs (docs/FOLLOWING.md 2.1, 4.2). No tar format is parsed here: a
// package is read by the node-tar bundled with the npm on PATH, with the options npm's pacote uses when it extracts
// a package on install, into a fresh folder. What the checks see is what npm installs, by construction.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

// The npm on PATH and its bundled node-tar: { tar, tarVersion, npmVersion, tarDir }. Throws when npm, its install
// folder, or the bundled node-tar or its version cannot be found and read; the callers refuse then.
export const npmTar = () => {
	const scratch = mkdtempSync(join(tmpdir(), "follow-npm-"));
	writeFileSync(join(scratch, "user-npmrc"), "");
	writeFileSync(join(scratch, "global-npmrc"), "");
	// npm with an empty environment plus PATH, a throwaway HOME, no user or global configuration and scripts off
	// (as follow.sh's npm_env): no token or prefix of the caller's reaches it; its own install's global root.
	mkdirSync(join(scratch, "home"));
	const env = {
		PATH: process.env.PATH ?? "",
		HOME: join(scratch, "home"),
		npm_config_userconfig: join(scratch, "user-npmrc"),
		npm_config_globalconfig: join(scratch, "global-npmrc"),
		npm_config_ignore_scripts: "true",
		npm_config_registry: "https://registry.npmjs.org/",
	};
	const run = (args) => execFileSync("npm", args, { cwd: scratch, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	const npmVersion = run(["--version"]);
	const npmDir = join(run(["root", "-g"]), "npm");
	const npmPkg = JSON.parse(readFileSync(join(npmDir, "package.json"), "utf8"));
	if (npmPkg.name !== "npm" || npmPkg.version !== npmVersion)
		throw new Error(`${npmDir} is not the npm on PATH (${npmVersion})`);
	const tarDir = realpathSync(join(npmDir, "node_modules", "tar"));
	const tarPkg = JSON.parse(readFileSync(join(tarDir, "package.json"), "utf8"));
	if (tarPkg.name !== "tar" || typeof tarPkg.version !== "string" || !/^\d+\.\d+\.\d+/.test(tarPkg.version))
		throw new Error(`no readable version of node-tar at ${tarDir}`);
	const req = createRequire(join(npmDir, "package.json"));
	const resolved = realpathSync(req.resolve("tar"));
	if (!resolved.startsWith(tarDir + sep)) throw new Error(`npm's require("tar") is ${resolved}, not ${tarDir}`);
	const tar = req("tar");
	rmSync(scratch, { recursive: true, force: true });
	if (typeof tar.x !== "function" || typeof tar.t !== "function") throw new Error("node-tar has no x or t");
	return { tar, tarVersion: tarPkg.version, npmVersion, tarDir };
};

// extractLikeNpm(tar, FILE, DIR): DIR (new, empty) gets what npm installs from FILE: tar.x with pacote's options
// (pacote 21, lib/fetcher.js #tarxOptions): strip 1, no chmod, no mtime, no owner, links filtered out, .gitignore
// read as .npmignore unless one is there. Returns { entries, warnings, files, others }: every entry node-tar parsed
// ({ path, type }, before strip), node-tar's warnings, the regular files written (relative paths), and anything
// written that is neither a file nor a folder.
export const extractLikeNpm = (tar, file, dir) => {
	const entries = [];
	const warnings = [];
	const onwarn = (code, msg) => warnings.push(`${code}: ${msg}`);
	// onentry: node-tar 6 (npm 10) knows only that name; node-tar 7 (npm 11) takes it as onReadEntry.
	tar.t({ file, sync: true, onwarn, onentry: (e) => entries.push({ path: e.path, type: e.type }) });
	const sawIgnores = new Set();
	mkdirSync(dir, { recursive: true });
	tar.x({
		file,
		sync: true,
		cwd: dir,
		noChmod: true,
		noMtime: true,
		strip: 1,
		preserveOwner: false,
		onwarn,
		filter: (_name, entry) => {
			if (/Link$/.test(entry.type)) return false;
			if (/File$/.test(entry.type)) {
				const base = entry.path.split("/").pop();
				if (base === ".npmignore") sawIgnores.add(entry.path);
				else if (base === ".gitignore") {
					const ni = entry.path.replace(/\.gitignore$/, ".npmignore");
					if (sawIgnores.has(ni)) return false;
					entry.path = ni;
				}
				return true;
			}
		},
	});
	const files = [];
	const others = [];
	const walk = (d) => {
		for (const n of readdirSync(d)) {
			const p = join(d, n);
			const st = lstatSync(p);
			if (st.isDirectory()) walk(p);
			else if (st.isFile()) files.push(relative(dir, p).split(sep).join("/"));
			else others.push(relative(dir, p).split(sep).join("/"));
		}
	};
	if (existsSync(dir)) walk(dir);
	return { entries, warnings, files: files.sort(), others };
};

// What a package's entries must be, as tarball.mjs and load.mjs refuse them: under package/, and only regular
// files and folders (npm drops links without a word; they are refused here).
export const entryProblems = (entries) => {
	const bad = [];
	for (const e of entries) {
		if (!String(e.path).startsWith("package/")) bad.push(`${JSON.stringify(String(e.path).slice(0, 200))} is outside package/`);
		else if (!/^(File|OldFile|ContiguousFile|Directory)$/.test(e.type))
			bad.push(`${JSON.stringify(String(e.path).slice(0, 200))} is a ${e.type}, not a regular file`);
	}
	return bad;
};
