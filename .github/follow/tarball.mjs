#!/usr/bin/env node
// What an npm release ships, checked against git (docs/FOLLOWING.md 2.1, 4.2). Node's own modules, git, and the
// tar reader bundled with the npm on PATH (nodetar.mjs): the tarball is extracted as npm extracts it on install, into
// a fresh temporary folder, and nothing in it is run.
//
//   verify FILE INTEGRITY         FILE's sha512 is the registry's integrity ("sha512-<base64>"); exit 0, else 4
//   compare FILE COMMIT SHIPS     the tarball and the commit match both ways: the tarball holds exactly the files of
//                                 SHIPS (what npm packs from COMMIT, one path per line), each a regular file of
//                                 COMMIT with the same bytes, as npm's own node-tar extracts it with pacote's
//                                 options; prints one difference per line; exit 0, else 4. First, independent of
//                                 any node-tar version, every tar header must pass a strict pre-scan
//                                 (headers.mjs: plain ustar files and folders under package/, per-file PAX headers
//                                 with only npm pack's keys); anything else is refused before extraction. Also
//                                 refused: a link, an entry outside package/, any node-tar warning (an entry it
//                                 skips), files node-tar writes other than the scanned ones, and no bundled
//                                 node-tar or no readable version of it
//   export COMMIT DIR             writes COMMIT's regular files (no link, no submodule) into DIR, a new folder, so
//                                 that npm can list what it would pack from them; runs nothing of them
//   registered PKGJSON PACKED     every extension package.json registers (pi.extensions) is in PACKED (one path per
//                                 line); exit 0, else 4. Whether they load is load.mjs's, in the test job.
// Exit 1: the check itself failed (unreadable input, git error).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { expectedFiles, scanHeaders } from "./headers.mjs";
import { entryProblems, extractLikeNpm, npmTar } from "./nodetar.mjs";

const MAX = 64 * 1024 * 1024;
const safePath = (p) =>
	typeof p === "string" &&
	p.length > 0 &&
	p.length < 4096 &&
	!p.startsWith("/") &&
	!/[\0\\\n\r]/.test(p) &&
	!p.split("/").some((s) => s === ".." || s === "." || s === "");

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
		// The headers, classified before any extraction: what two node-tar versions could read differently is refused.
		const scan = scanHeaders(file);
		if (scan.problems.length) {
			for (const p of scan.problems) console.log(`tarball: refused before extraction: ${p}`);
			process.exit(4);
		}
		// npm's own reader, or a refusal: no file's bytes are taken from the pre-scan.
		let nt;
		try {
			nt = npmTar();
		} catch (e) {
			console.log(`tarball: npm's bundled node-tar cannot be found or read: ${e instanceof Error ? e.message : e}`);
			process.exit(4);
		}
		const dir = mkdtempSync(join(tmpdir(), "follow-release-"));
		let got;
		try {
			got = extractLikeNpm(nt.tar, file, join(dir, "package"));
		} catch (e) {
			rmSync(dir, { recursive: true, force: true });
			console.log(`tarball: npm's node-tar ${nt.tarVersion} cannot read it: ${e instanceof Error ? e.message : e}`);
			process.exit(4);
		}
		for (const b of entryProblems(got.entries)) bad.push(`tarball: ${b}`);
		for (const w of got.warnings) bad.push(`tarball: npm's node-tar ${nt.tarVersion} warns: ${w.slice(0, 300)}`);
		for (const p of got.others) bad.push(`tarball: ${show(p)} is not a regular file once extracted`);
		// node-tar must have written exactly the files the pre-scan classified.
		const want = new Set(expectedFiles(scan.files));
		for (const p of got.files) if (!want.has(p)) bad.push(`tarball: npm's node-tar wrote ${show(p)}, which the header scan did not see`);
		for (const p of want) if (!got.files.includes(p)) bad.push(`tarball: npm's node-tar did not write ${show(p)}, which the header scan saw`);
		const seen = new Set(got.files);
		for (const p of got.files) {
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
			if (!blob.equals(readFileSync(join(dir, "package", p)))) bad.push(`tarball: ${show(p)} differs from the commit`);
			else if (!ships.has(p)) bad.push(`tarball: ${show(p)} is in it, but npm would not pack it from the commit`);
		}
		// The other way: what npm packs from the commit, npm must install from the tarball.
		for (const p of ships) if (!seen.has(p)) bad.push(`tarball: the commit ships ${show(p)}, npm's tarball lacks it`);
		if (!seen.has("package.json")) bad.push("tarball: no package/package.json");
		rmSync(dir, { recursive: true, force: true });
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
