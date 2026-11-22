#!/usr/bin/env node
// What an npm release ships, checked against git (docs/FOLLOWING.md 2.1, 4.2). Node's own modules and git only;
// the tarball is read in memory, never unpacked to disk.
//
//   verify FILE INTEGRITY         FILE's sha512 is the registry's integrity ("sha512-<base64>"); exit 0, else 4
//   compare FILE COMMIT SHIPS     the tarball and the commit match both ways: the tarball holds exactly the files of
//                                 SHIPS (what npm packs from COMMIT, one path per line), each a regular file of
//                                 COMMIT with the same bytes; prints one difference per line; exit 0, else 4
//   export COMMIT DIR             writes COMMIT's regular files (no link, no submodule) into DIR, a new folder, so
//                                 that npm can list what it would pack from them; runs nothing of them
//   registered PKGJSON PACKED     every extension package.json registers (pi.extensions) is in PACKED (one path per
//                                 line); exit 0, else 4. Whether they load is load.mjs's, in the test job.
// Exit 1: the check itself failed (unreadable input, git error).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { entries, MAX, safePath } from "./tar.mjs";

const fail = (msg) => {
	console.error(`tarball.mjs: ${msg}`);
	process.exit(1);
};
const show = (s) => JSON.stringify(String(s).slice(0, 200));
const git = (args, opts = {}) => execFileSync("git", args, { maxBuffer: MAX, stdio: ["ignore", "pipe", "pipe"], ...opts });
const lines = (file) =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter((s) => s);

const [cmd, ...args] = process.argv.slice(2);
try {
	if (cmd === "verify") {
		const [file, integrity] = args;
		const want = (integrity ?? "").split(/\s+/).find((s) => /^sha512-[A-Za-z0-9+/]{86}==$/.test(s));
		if (!want) {
			console.log("the registry gives no sha512 integrity");
			process.exit(4);
		}
		const got = `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;
		if (got !== want) {
			console.log(`the tarball's sha512 is ${got}, the registry says ${want}`);
			process.exit(4);
		}
	} else if (cmd === "compare") {
		const [file, commit, shipsFile] = args;
		if (!/^[0-9a-f]{40}$/.test(commit ?? "") || !shipsFile) fail("compare FILE COMMIT SHIPS (a full commit id)");
		const ships = new Set(lines(shipsFile));
		const bad = [];
		const seen = new Set();
		let files = 0;
		for (const e of entries(file)) {
			if (e.type === "5") continue;
			if (!e.path.startsWith("package/")) {
				bad.push(`tarball: ${show(e.path)} is outside package/`);
				continue;
			}
			const p = e.path.slice("package/".length);
			if (!safePath(p)) {
				bad.push(`tarball: ${show(p)} is not a plain relative path`);
				continue;
			}
			if (e.type !== "0" && e.type !== "\0") {
				bad.push(`tarball: ${show(p)} is not a regular file (type ${show(e.type)})`);
				continue;
			}
			if (seen.has(p)) {
				bad.push(`tarball: ${show(p)} is in it twice`);
				continue;
			}
			seen.add(p);
			files++;
			const tree = git(["ls-tree", "-z", commit, "--", p]).toString("utf8");
			const m = /^(\d{6}) (\w+) ([0-9a-f]{40})\t/.exec(tree);
			if (!m) {
				bad.push(`tarball: ${show(p)} is not in the commit`);
				continue;
			}
			if (m[2] !== "blob" || (m[1] !== "100644" && m[1] !== "100755")) {
				bad.push(`tarball: ${show(p)} is not a regular file in the commit`);
				continue;
			}
			const blob = git(["cat-file", "blob", m[3]]);
			if (!blob.equals(e.data)) bad.push(`tarball: ${show(p)} differs from the commit`);
			else if (!ships.has(p)) bad.push(`tarball: ${show(p)} is in it, but npm would not pack it from the commit`);
		}
		// The other way: what npm packs from the commit, the tarball must hold.
		for (const p of ships) if (!seen.has(p)) bad.push(`tarball: the commit ships ${show(p)}, npm's tarball lacks it`);
		if (files === 0 || !seen.has("package.json")) bad.push("tarball: no package/package.json");
		for (const b of bad) console.log(b);
		process.exit(bad.length ? 4 : 0);
	} else if (cmd === "export") {
		const [commit, dir] = args;
		if (!/^[0-9a-f]{40}$/.test(commit ?? "") || !dir) fail("export COMMIT DIR (a full commit id)");
		if (existsSync(dir)) fail(`${dir} exists`);
		mkdirSync(dir, { recursive: true });
		const tree = git(["ls-tree", "-r", "-z", "--full-tree", commit]).toString("utf8");
		for (const rec of tree.split("\0").filter((s) => s)) {
			const m = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.*)$/s.exec(rec);
			if (!m || m[2] !== "blob" || (m[1] !== "100644" && m[1] !== "100755") || !safePath(m[4])) continue;
			const to = join(dir, m[4]);
			mkdirSync(dirname(to), { recursive: true });
			writeFileSync(to, git(["cat-file", "blob", m[3]]));
		}
	} else if (cmd === "registered") {
		const [pkgFile, packedFile] = args;
		if (!pkgFile || !packedFile) fail("registered PKGJSON PACKED");
		const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
		const packed = new Set(lines(packedFile));
		const exts = pkg?.pi?.extensions;
		const bad = [];
		if (!Array.isArray(exts) || exts.length === 0) bad.push("package.json registers no extension (pi.extensions)");
		for (const e of Array.isArray(exts) ? exts : []) {
			const p = posix.normalize(String(e));
			if (!safePath(p)) bad.push(`extension ${show(e)} is not a plain relative path`);
			else if (!packed.has(p)) bad.push(`tarball: ${show(p)}, which pi loads, is not in it`);
		}
		for (const b of bad) console.log(b);
		process.exit(bad.length ? 4 : 0);
	} else fail("usage: tarball.mjs verify|compare|export|registered …");
} catch (e) {
	fail(e instanceof Error ? e.message : String(e));
}
