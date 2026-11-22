// A gzipped tar read in memory (docs/FOLLOWING.md 2.1, 4.2), for tarball.mjs and load.mjs. Node's own modules only.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

export const MAX = 64 * 1024 * 1024;

export const safePath = (p) =>
	typeof p === "string" &&
	p.length > 0 &&
	p.length < 4096 &&
	!p.startsWith("/") &&
	!/[\0\\\n\r]/.test(p) &&
	!p.split("/").some((s) => s === ".." || s === "." || s === "");

// Entries of a gzipped tar: [{ path, type, data }]. Pax ('x') and GNU long-name ('L') headers name the next entry;
// global pax headers ('g') are skipped. Throws on a header it cannot read.
export const entries = (file) => {
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
		if (!Number.isFinite(size) || size < 0) throw new Error("a tar header with a bad size");
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

// The package's regular files: [{ path (relative to package/), data }], or throws naming what is not one.
export const packageFiles = (file) => {
	const out = [];
	const seen = new Set();
	for (const e of entries(file)) {
		if (e.type === "5") continue;
		if (!e.path.startsWith("package/")) throw new Error(`${JSON.stringify(e.path)} is outside package/`);
		const p = e.path.slice("package/".length);
		if (!safePath(p)) throw new Error(`${JSON.stringify(p)} is not a plain relative path`);
		if (e.type !== "0" && e.type !== "\0") throw new Error(`${JSON.stringify(p)} is not a regular file`);
		if (seen.has(p)) throw new Error(`${JSON.stringify(p)} is in it twice`);
		seen.add(p);
		out.push({ path: p, data: e.data });
	}
	return out;
};
