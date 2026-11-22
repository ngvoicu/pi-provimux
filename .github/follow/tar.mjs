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

// Entries of a gzipped tar: [{ path, type, data }], read only where this reader and npm's node-tar agree exactly.
// Anything else throws, and the caller refuses the tarball:
// - every header is plain POSIX ustar (magic "ustar\0", version "00") with a valid checksum: no GNU header,
//   whose prefix field node-tar reads as times;
// - its type is a regular file ('0') or a directory ('5'): no PAX ('x', 'g') or GNU ('L', 'K') extended header,
//   whose fields (a path, a size) node-tar applies and this reader would not, no link, no other type;
// - its size is plain octal (no base-256), a directory's 0, and the data lies inside the archive;
// - after the first zero block the archive is zeros to its end (node-tar would read on past a single one).
export const entries = (file) => {
	const tar = gunzipSync(readFileSync(file), { maxOutputLength: MAX });
	const out = [];
	let off = 0;
	const str = (b) => {
		const i = b.indexOf(0);
		return b.subarray(0, i < 0 ? b.length : i).toString("utf8");
	};
	const bad = (why) => {
		throw new Error(`a tar header at ${off} that is not read as npm reads it: ${why}`);
	};
	if (tar.length % 512 !== 0) bad("the archive is not whole 512-byte blocks");
	while (off + 512 <= tar.length) {
		const h = tar.subarray(off, off + 512);
		if (h.every((x) => x === 0)) {
			if (!tar.subarray(off).every((x) => x === 0)) bad("data after a zero block");
			return out;
		}
		if (h.subarray(257, 265).toString("latin1") !== "ustar\u000000") bad("not a POSIX ustar header");
		let sum = 0;
		for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
		const ck = h.subarray(148, 156).toString("latin1").replace(/[\0 ]+$/, "");
		if (!/^[0-7]{1,7}$/.test(ck) || Number.parseInt(ck, 8) !== sum) bad("a bad checksum");
		const type = String.fromCharCode(h[156]);
		if (type !== "0" && type !== "5") bad(`type ${JSON.stringify(type)} (only regular files and directories)`);
		if (h[124] & 0x80) bad("a base-256 size");
		const sz = h.subarray(124, 136).toString("latin1").replace(/^ +/, "").replace(/[\0 ]+$/, "");
		if (!/^[0-7]{1,11}$/.test(sz)) bad("a size that is not octal");
		const size = Number.parseInt(sz, 8);
		if (type === "5" && size !== 0) bad("a directory with data");
		if (off + 512 + Math.ceil(size / 512) * 512 > tar.length) bad("data past the end");
		const prefix = str(h.subarray(345, 500));
		let name = str(h.subarray(0, 100));
		if (prefix) name = `${prefix}/${name}`;
		out.push({ path: name, type, data: tar.subarray(off + 512, off + 512 + size) });
		off += 512 + Math.ceil(size / 512) * 512;
	}
	bad("no end-of-archive zero block");
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
