#!/usr/bin/env node
// What an npm release ships, checked against git (docs/FOLLOWING.md 2.1, 4.2). Node's own modules and git only;
// the tarball is read in memory, never unpacked to disk.
//
//   verify FILE INTEGRITY         FILE's sha512 is the registry's integrity ("sha512-<base64>"); exit 0, else 4
//   compare FILE COMMIT           every file in the tarball is a regular file of COMMIT with the same bytes, and the
//                                 tarball holds only such files; prints one difference per line; exit 0, else 4
//   closure PKGJSON PACKED COMMIT the extensions package.json registers (pi.extensions) and the files they import
//                                 by a relative path are all in PACKED (one path per line); exit 0, else 4
// Exit 1: the check itself failed (unreadable input, git error).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { gunzipSync } from "node:zlib";

const MAX = 64 * 1024 * 1024;
const fail = (msg) => {
	console.error(`tarball.mjs: ${msg}`);
	process.exit(1);
};
const safePath = (p) =>
	typeof p === "string" &&
	p.length > 0 &&
	p.length < 4096 &&
	!p.startsWith("/") &&
	!/[\0\\\n\r]/.test(p) &&
	!p.split("/").some((s) => s === ".." || s === "." || s === "");
const show = (s) => JSON.stringify(String(s).slice(0, 200));
const git = (args, opts = {}) => execFileSync("git", args, { maxBuffer: MAX, stdio: ["ignore", "pipe", "pipe"], ...opts });

// Regular files of a gzipped tar: [{ path, type, data }]. Pax ('x') and GNU long-name ('L') headers name the next
// entry; global pax headers ('g') are skipped.
const entries = (file) => {
	const tar = gunzipSync(readFileSync(file), { maxOutputLength: MAX });
	const out = [];
	let off = 0;
	let longName = null;
	const str = (b) => {
		const i = b.indexOf(0);
		return b.subarray(0, i < 0 ? b.length : i).toString("utf8");
	};
	while (off + 512 <= tar.length) {
		const h = tar.subarray(off, off + 512);
		if (h.every((x) => x === 0)) break;
		const size = Number.parseInt(str(h.subarray(124, 136)).trim() || "0", 8);
		if (!Number.isFinite(size) || size < 0) fail("a tar header with a bad size");
		const type = String.fromCharCode(h[156] || 48);
		const prefix = str(h.subarray(345, 500));
		let name = str(h.subarray(0, 100));
		if (prefix) name = `${prefix}/${name}`;
		const data = tar.subarray(off + 512, off + 512 + size);
		off += 512 + Math.ceil(size / 512) * 512;
		if (type === "x") {
			const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
			if (m) longName = m[1];
			continue;
		}
		if (type === "L") {
			longName = str(data);
			continue;
		}
		if (type === "g") continue;
		if (longName !== null) name = longName;
		longName = null;
		out.push({ path: name, type, data });
	}
	return out;
};

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
		const [file, commit] = args;
		if (!/^[0-9a-f]{40}$/.test(commit ?? "")) fail("compare FILE COMMIT (a full commit id)");
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
		}
		if (files === 0 || !seen.has("package.json")) bad.push("tarball: no package/package.json");
		for (const b of bad) console.log(b);
		process.exit(bad.length ? 4 : 0);
	} else if (cmd === "closure") {
		const [pkgFile, packedFile, commit] = args;
		if (!/^[0-9a-f]{40}$/.test(commit ?? "")) fail("closure PKGJSON PACKED COMMIT");
		const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
		const packed = new Set(
			readFileSync(packedFile, "utf8")
				.split("\n")
				.filter((s) => s),
		);
		const exts = pkg?.pi?.extensions;
		const bad = [];
		if (!Array.isArray(exts) || exts.length === 0) bad.push("package.json registers no extension (pi.extensions)");
		const todo = (Array.isArray(exts) ? exts : []).map((e) => posix.normalize(String(e)));
		const done = new Set();
		const fromCommit = (p) => {
			try {
				return git(["cat-file", "blob", `${commit}:${p}`]).toString("utf8");
			} catch {
				return null;
			}
		};
		while (todo.length) {
			const p = todo.shift();
			if (done.has(p)) continue;
			done.add(p);
			if (!safePath(p)) {
				bad.push(`extension ${show(p)} is not a plain relative path`);
				continue;
			}
			if (!packed.has(p)) {
				bad.push(`tarball: ${show(p)}, which pi loads, is not in it`);
				continue;
			}
			const src = fromCommit(p);
			if (src === null) continue;
			const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;
			for (const m of src.matchAll(re)) {
				const base = posix.normalize(posix.join(posix.dirname(p), m[1]));
				const stem = base.replace(/\.(js|mjs|cjs)$/, "");
				const candidates = [base, `${stem}.ts`, `${stem}.mts`, `${stem}.js`, `${stem}.mjs`, `${base}/index.ts`];
				const hit = candidates.find((c) => fromCommit(c) !== null);
				if (!hit) bad.push(`${show(p)} imports ${show(m[1])}, which the commit does not have`);
				else todo.push(hit);
			}
		}
		for (const b of bad) console.log(b);
		process.exit(bad.length ? 4 : 0);
	} else fail("usage: tarball.mjs verify|compare|closure …");
} catch (e) {
	fail(e instanceof Error ? e.message : String(e));
}
