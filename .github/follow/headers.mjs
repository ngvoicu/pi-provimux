// A strict pre-scan of a release tarball's tar headers (docs/FOLLOWING.md 2.1), before npm's node-tar extracts it
// (nodetar.mjs). It reads the headers only to classify them, never to take a file's bytes. It refuses anything that
// two versions of node-tar could read differently, whatever node-tar is on PATH. Different node-tar versions do
// read some headers differently: npm 10's node-tar 6 and npm 11's node-tar 7 give a global PAX size and a per-file
// PAX size different precedence.
//
// Allowed, and nothing else:
//   - one gzip member (no name, extra or comment field) holding the whole file;
//   - plain ustar headers ("ustar\0" "00", valid checksum, plain octal numbers, no link target) of a regular file
//     ("0") or a directory ("5", size 0), under package/;
//   - a per-file PAX header ("x") with only the keys npm pack writes (node-tar's WriteEntry with pacote's
//     portable: true): path, mtime, and size, which must equal the following header's own size. It must be
//     followed by the regular file or directory it describes;
//   - the two zero end blocks, then only zero padding.
// Refused: global PAX headers ("g"), GNU long names and link names ("L", "K"), links of any kind, every other type,
// any other PAX key (linkpath, uid, gid, uname, gname, atime, ctime, charset, comment, ...), a path that is not a
// plain relative path under package/, a file twice, and trailing data.
import { readFileSync } from "node:fs";
import { gunzipSync, inflateRawSync } from "node:zlib";

const MAX_TAR = 256 * 1024 * 1024;
const MAX_PAX = 64 * 1024;
const PAX_KEYS = new Set(["path", "mtime", "size"]);
const show = (s) => JSON.stringify(String(s).slice(0, 200));

// A NUL-terminated field: its text, or null when anything but NULs follows the first NUL.
const field = (h, at, len) => {
	const b = h.subarray(at, at + len);
	const end = b.indexOf(0);
	if (end >= 0 && b.subarray(end).some((x) => x !== 0)) return null;
	return b.subarray(0, end < 0 ? len : end);
};
// A plain octal number field: octal digits, then only spaces or NULs; or, if empty is allowed, all NULs.
const octal = (h, at, len, emptyOk = false) => {
	const s = h.subarray(at, at + len).toString("latin1");
	if (emptyOk && /^\0+$/.test(s)) return 0;
	const m = /^([0-7]+)[ \0]+$/.exec(s);
	return m ? Number.parseInt(m[1], 8) : null;
};
// A plain path under package/: no empty, "." or ".." segment, no NUL, backslash, CR or LF, and something after
// package/. A directory may end with one "/".
const plainPath = (p, dir) => {
	const q = dir && p.endsWith("/") ? p.slice(0, -1) : p;
	if (!q.startsWith("package/") || /[\0\\\n\r]/.test(q)) return false;
	return q
		.split("/")
		.slice(1)
		.every((s) => s !== "" && s !== "." && s !== "..");
};

// The tar inside FILE, or a reason it is refused.
const tarOf = (file) => {
	const gz = readFileSync(file);
	if (gz.length < 18 || gz[0] !== 0x1f || gz[1] !== 0x8b || gz[2] !== 8)
		return { why: "it is not a gzip file (npm writes one gzip member)" };
	if (gz[3] !== 0) return { why: "its gzip header has flags (a name, extra field or comment); npm writes none" };
	let member;
	try {
		member = inflateRawSync(gz.subarray(10), { info: true, maxOutputLength: MAX_TAR });
	} catch (e) {
		return { why: `its gzip data cannot be read: ${e instanceof Error ? e.message : e}` };
	}
	if (10 + member.engine.bytesWritten + 8 !== gz.length) return { why: "it is not exactly one gzip member: more follows the first" };
	let tar;
	try {
		tar = gunzipSync(gz, { maxOutputLength: MAX_TAR });
	} catch (e) {
		return { why: `its gzip data cannot be read: ${e instanceof Error ? e.message : e}` };
	}
	if (!tar.equals(member.buffer)) return { why: "its gzip member does not read the same twice" };
	return { tar };
};

// scanHeaders(FILE): { problems, files, dirs }. problems: why the tarball is refused (empty: every header is
// allowed); files and dirs: the regular files' and directories' paths, as written (package/…), in order.
export const scanHeaders = (file) => {
	const problems = [];
	const files = [];
	const dirs = [];
	const { tar, why } = tarOf(file);
	if (why) return { problems: [why], files, dirs };
	const seen = new Set();
	let pax = null; // the pending per-file PAX header: { path?, size? }, until the entry it describes
	let o = 0;
	let ended = false;
	const refuse = (msg) => {
		problems.push(`header at byte ${o}: ${msg}`);
	};
	while (o + 512 <= tar.length) {
		const h = tar.subarray(o, o + 512);
		if (h.every((x) => x === 0)) {
			const next = tar.subarray(o + 512, o + 1024);
			if (next.length !== 512 || next.some((x) => x !== 0)) refuse("a lone zero block, not the two end blocks");
			else if (tar.subarray(o + 1024).some((x) => x !== 0)) refuse("data after the end blocks");
			else if (pax) refuse("a PAX header with no entry after it");
			else ended = true;
			break;
		}
		// The checksum: the unsigned sum of the block with its checksum field read as spaces.
		const sum = octal(h, 148, 8);
		let got = 0;
		for (let i = 0; i < 512; i++) got += i >= 148 && i < 156 ? 32 : h[i];
		if (sum === null || sum !== got) {
			refuse("an invalid checksum");
			break;
		}
		if (h.subarray(257, 265).toString("latin1") !== "ustar\u000000") {
			refuse("not a plain ustar header (magic and version)");
			break;
		}
		const size = octal(h, 124, 12);
		if (size === null) {
			refuse("its size is not a plain octal number");
			break;
		}
		const type = String.fromCharCode(h[156]);
		const dataEnd = o + 512 + Math.ceil(size / 512) * 512;
		if (o + 512 + size > tar.length) {
			refuse("its data runs past the end of the archive");
			break;
		}
		const numbersOk = [
			[100, 8],
			[108, 8],
			[116, 8],
			[136, 12],
			[329, 8],
			[337, 8],
		].every(([at, len]) => octal(h, at, len, true) !== null);
		const name = field(h, 0, 100);
		const prefix = field(h, 345, 155);
		const link = field(h, 157, 100);
		if (!numbersOk) refuse("a mode, owner, time or device field is not a plain octal number");
		else if (name === null || prefix === null || link === null)
			refuse("a name, prefix or link field has bytes after its end");
		else if (link.length) refuse(`a link target (${show(link.toString("utf8"))}): links are refused`);
		else if (type === "x") {
			if (pax) refuse("two PAX headers for one entry");
			else if (size > MAX_PAX) refuse(`a PAX header of ${size} bytes`);
			else {
				const parsed = parsePax(tar.subarray(o + 512, o + 512 + size));
				if (parsed.why) refuse(`a per-file PAX header ${parsed.why}`);
				else pax = parsed.keys;
			}
		} else if (type === "0" || type === "5") {
			const dir = type === "5";
			const raw = (prefix.length ? `${prefix.toString("utf8")}/` : "") + name.toString("utf8");
			const p = pax?.path ?? raw;
			if (!pax?.path && !/^[\x20-\x7e]*$/.test(raw))
				refuse(`a non-ASCII ustar name with no PAX path (${show(raw)}); npm writes a PAX path for it`);
			else if (!plainPath(p, dir)) refuse(`${show(p)} is not a plain path under package/`);
			else if (!dir && p.endsWith("/")) refuse(`the regular file ${show(p)} ends with "/"`);
			else if (dir && size !== 0) refuse(`the directory ${show(p)} has a size`);
			else if (pax?.size !== undefined && pax.size !== size)
				refuse(`${show(p)}: its PAX size ${pax.size} is not its header's size ${size}`);
			else {
				const key = dir ? p.replace(/\/$/, "") : p;
				if (seen.has(key)) refuse(`${show(p)} is in it twice`);
				seen.add(key);
				(dir ? dirs : files).push(p);
			}
			pax = null;
		} else if (type === "g") refuse("a global PAX header (g)");
		else if (type === "L" || type === "K") refuse(`a GNU long ${type === "L" ? "name" : "link name"} header (${type})`);
		else if (type === "1" || type === "2") refuse(`a ${type === "1" ? "hard" : "symbolic"} link: links are refused`);
		else refuse(`an entry of type ${show(type)}: only regular files, directories and per-file PAX headers`);
		if (problems.length) break;
		o = dataEnd;
	}
	if (!problems.length && !ended) problems.push("the archive does not end with two zero blocks");
	return { problems, files, dirs };
};

// A PAX body as npm writes it: records "<len> <key>=<value>\n", each exactly <len> bytes, filling the body; keys
// only path, mtime and size, each once; path a UTF-8 string, mtime decimal seconds, size a canonical decimal.
const parsePax = (body) => {
	const keys = {};
	let i = 0;
	while (i < body.length) {
		const sp = body.indexOf(0x20, i);
		const lenText = sp < 0 ? "" : body.subarray(i, sp).toString("latin1");
		if (!/^[1-9][0-9]{0,5}$/.test(lenText)) return { why: "has a record with no plain length" };
		const len = Number(lenText);
		if (i + len > body.length || body[i + len - 1] !== 0x0a) return { why: "has a record whose length is wrong" };
		const rec = body.subarray(sp + 1, i + len - 1);
		const eq = rec.indexOf(0x3d);
		if (eq <= 0) return { why: "has a record with no key" };
		const key = rec.subarray(0, eq).toString("latin1");
		const valueBytes = rec.subarray(eq + 1);
		const value = valueBytes.toString("utf8");
		if (!Buffer.from(value, "utf8").equals(valueBytes)) return { why: `has a ${show(key)} that is not UTF-8` };
		if (!PAX_KEYS.has(key)) return { why: `has the key ${show(key)}; npm pack writes only path, mtime and size` };
		if (Object.hasOwn(keys, key)) return { why: `has ${show(key)} twice` };
		if (key === "size") {
			if (!/^(0|[1-9][0-9]{0,11})$/.test(value)) return { why: `has a size that is not a plain number (${show(value)})` };
			keys.size = Number(value);
		} else if (key === "mtime") {
			if (!/^[0-9]{1,12}(\.[0-9]{1,9})?$/.test(value)) return { why: `has an mtime that is not plain seconds (${show(value)})` };
			keys.mtime = value;
		} else keys.path = value;
		i += len;
	}
	return { keys };
};

// The files npm's extraction (nodetar.mjs, pacote's filter) writes from the scanned FILES, relative to package/:
// a .gitignore becomes .npmignore unless that .npmignore came before it, in which case it is dropped.
export const expectedFiles = (files) => {
	const out = [];
	const npmignores = new Set();
	for (const p of files) {
		const base = p.split("/").pop();
		if (base === ".npmignore") npmignores.add(p);
		else if (base === ".gitignore") {
			const ni = p.replace(/\.gitignore$/, ".npmignore");
			if (npmignores.has(ni)) continue;
			out.push(ni.slice("package/".length));
			continue;
		}
		out.push(p.slice("package/".length));
	}
	return [...new Set(out)].sort();
};
