#!/usr/bin/env node
// The manifest rule of docs/FOLLOWING.md (2.5), and the JSON checks follow.sh needs.
// Node's own modules only; reads and writes the files it is given, runs nothing else.
//
//   merge package|lock BASE OURS THEIRS OUT  three-way merge by rule into OUT; prints one conflict per line;
//                                            exit 0 merged, 3 conflicts (OUT then keeps ours where they are)
//   stops BASE OURS THEIRS                   package.json: the keys the original changed that the owner decides;
//                                            prints one per line; exit 0 none, 4 some
//   lock-check MAIN CANDIDATE                package-lock.json of the candidate: every package from the npm
//                                            registry with an integrity, no new install script; exit 0 / 4
//   set-version FILE VERSION                 the version in package.json, or its two copies in package-lock.json,
//                                            changing nothing else in the text
//   same-but-version A B                     exit 0 when A and B differ in their version fields only, else 4
//
// A missing file ("-" or a path that does not exist) is read as {}.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const FORK_KEYS = new Set(["name", "version", "description", "keywords", "repository", "homepage", "bugs", "author"]);
const MAP_KEYS = new Set(["devDependencies", "peerDependencies", "engines"]);
const REGISTRY = "https://registry.npmjs.org/";

const read = (file) => {
	if (file === "-" || !existsSync(file)) return { text: "", json: {} };
	const text = readFileSync(file, "utf8");
	if (text.trim() === "") return { text, json: {} };
	return { text, json: JSON.parse(text) };
};

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const eq = (a, b) => {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => eq(v, b[i]));
	if (isObj(a) && isObj(b)) {
		const ka = Object.keys(a);
		const kb = Object.keys(b);
		return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && eq(a[k], b[k]));
	}
	return false;
};
const has = (o, k) => isObj(o) && Object.hasOwn(o, k);
const get = (o, k) => (has(o, k) ? o[k] : undefined);
const show = (k) => JSON.stringify(k);

// One value, three ways. Returns { value, conflict } (value undefined = absent).
const three = (base, ours, theirs) => {
	if (eq(ours, theirs)) return { value: ours };
	if (eq(base, theirs)) return { value: ours };
	if (eq(base, ours)) return { value: theirs };
	return { value: ours, conflict: true };
};

// Keys in ours' order, then the keys only theirs has, in theirs' order.
const keyOrder = (ours, theirs) => {
	const keys = Object.keys(isObj(ours) ? ours : {});
	for (const k of Object.keys(isObj(theirs) ? theirs : {})) if (!keys.includes(k)) keys.push(k);
	return keys;
};

// A map (dependencies, engines) merged key by key.
const mergeMap = (base, ours, theirs, where, conflicts) => {
	if (!isObj(base) && !isObj(ours) && !isObj(theirs)) {
		const r = three(base, ours, theirs);
		if (r.conflict) conflicts.push(`${where}: changed on both sides`);
		return r.value;
	}
	if (!isObj(ours) && ours !== undefined) {
		conflicts.push(`${where}: not an object in the fork`);
		return ours;
	}
	if (!isObj(theirs) && theirs !== undefined) {
		conflicts.push(`${where}: not an object in the original`);
		return ours;
	}
	// One side removed the whole map: three ways on the whole value.
	if (ours === undefined || theirs === undefined) {
		const r = three(base, ours, theirs);
		if (r.conflict) conflicts.push(`${where}: removed on one side, changed on the other`);
		return r.value;
	}
	const out = {};
	for (const k of keyOrder(ours, theirs)) {
		const r = three(get(base, k), get(ours, k), get(theirs, k));
		if (r.conflict) conflicts.push(`${where}.${k}: changed on both sides`);
		if (r.value !== undefined) out[k] = r.value;
	}
	return out;
};

const mergePackage = (base, ours, theirs, conflicts) => {
	const out = {};
	for (const k of keyOrder(ours, theirs)) {
		const [b, o, t] = [get(base, k), get(ours, k), get(theirs, k)];
		let value;
		if (FORK_KEYS.has(k)) value = o;
		else if (MAP_KEYS.has(k)) value = mergeMap(b, o, t, `package.json ${k}`, conflicts);
		else {
			const r = three(b, o, t);
			if (r.conflict) conflicts.push(`package.json ${k}: changed on both sides`);
			value = r.value;
		}
		if (value !== undefined) out[k] = value;
	}
	return out;
};

// The root entry of package-lock.json: name and version the fork's, the maps key by key, the rest whole.
const mergeRootEntry = (base, ours, theirs, conflicts) => {
	const out = {};
	for (const k of keyOrder(ours, theirs)) {
		const [b, o, t] = [get(base, k), get(ours, k), get(theirs, k)];
		let value;
		if (k === "name" || k === "version") value = o;
		else if (isObj(o) || isObj(t)) value = mergeMap(b, o, t, `package-lock.json packages[""].${k}`, conflicts);
		else {
			const r = three(b, o, t);
			if (r.conflict) conflicts.push(`package-lock.json packages[""].${k}: changed on both sides`);
			value = r.value;
		}
		if (value !== undefined) out[k] = value;
	}
	return out;
};

const isSorted = (keys) => keys.every((k, i) => i === 0 || keys[i - 1].localeCompare(k, "en") <= 0);

const mergeLock = (base, ours, theirs, conflicts) => {
	const out = {};
	for (const k of keyOrder(ours, theirs)) {
		const [b, o, t] = [get(base, k), get(ours, k), get(theirs, k)];
		let value;
		if (k === "name" || k === "version") value = o;
		else if (k === "packages" && isObj(o) && isObj(t)) {
			value = {};
			for (const p of keyOrder(o, t)) {
				const [pb, po, pt] = [get(b, p), get(o, p), get(t, p)];
				let v;
				if (p === "") v = mergeRootEntry(pb, po, pt, conflicts);
				else {
					const r = three(pb, po, pt);
					if (r.conflict) conflicts.push(`package-lock.json packages[${show(p)}]: changed on both sides`);
					v = r.value;
				}
				if (v !== undefined) value[p] = v;
			}
			// npm writes the entries sorted, the root first; keep that when the fork's file has it.
			const rest = Object.keys(o).filter((p) => p !== "");
			if (isSorted(rest)) {
				const sorted = {};
				if (has(value, "")) sorted[""] = value[""];
				const names = Object.keys(value).filter((p) => p !== "");
				for (const p of names.sort((x, y) => x.localeCompare(y, "en"))) sorted[p] = value[p];
				value = sorted;
			}
		} else {
			const r = three(b, o, t);
			if (r.conflict) conflicts.push(`package-lock.json ${k}: changed on both sides`);
			value = r.value;
		}
		if (value !== undefined) out[k] = value;
	}
	return out;
};

const indentOf = (text) => {
	const m = /\n([ \t]+)"/.exec(text);
	if (!m) return "\t";
	return m[1].startsWith("\t") ? "\t" : m[1];
};

const write = (file, json, like) => {
	if (like.text && eq(json, like.json)) writeFileSync(file, like.text);
	else writeFileSync(file, `${JSON.stringify(json, null, indentOf(like.text))}\n`);
};

const withoutVersion = (j) => {
	const c = structuredClone(j);
	delete c.version;
	if (isObj(c.packages) && isObj(c.packages[""])) delete c.packages[""].version;
	return c;
};

const [cmd, ...args] = process.argv.slice(2);
const usage = () => {
	console.error("usage: manifest.mjs merge|stops|lock-check|set-version|same-but-version …");
	process.exit(2);
};

try {
	if (cmd === "merge") {
		const [kind, b, o, t, outFile] = args;
		if (!outFile || (kind !== "package" && kind !== "lock")) usage();
		const [base, ours, theirs] = [read(b), read(o), read(t)];
		const conflicts = [];
		const merged =
			kind === "package"
				? mergePackage(base.json, ours.json, theirs.json, conflicts)
				: mergeLock(base.json, ours.json, theirs.json, conflicts);
		write(outFile, merged, ours);
		for (const c of conflicts) console.log(c);
		process.exit(conflicts.length ? 3 : 0);
	} else if (cmd === "stops") {
		const [b, o, t] = args.map(read).map((x) => x.json);
		const stops = [];
		for (const k of keyOrder(b, t)) {
			if (FORK_KEYS.has(k) || MAP_KEYS.has(k)) continue;
			if (eq(get(b, k), get(t, k))) continue;
			const what = !has(b, k) ? "added" : !has(t, k) ? "removed" : "changed";
			stops.push(`package.json: the original ${what} \`${k}\`${has(o, k) ? "" : " (the fork has no such key)"}`);
		}
		for (const s of stops) console.log(s);
		process.exit(stops.length ? 4 : 0);
	} else if (cmd === "lock-check") {
		const [main, cand] = args.map(read).map((x) => x.json);
		const bad = [];
		const mainPkgs = isObj(main.packages) ? main.packages : {};
		const pkgs = isObj(cand.packages) ? cand.packages : {};
		for (const [p, e] of Object.entries(pkgs)) {
			if (p === "" || !isObj(e)) continue;
			if (e.link === true) {
				if (!eq(e, mainPkgs[p])) bad.push(`package-lock.json packages[${show(p)}]: a new link`);
				continue;
			}
			if (typeof e.resolved !== "string" || !e.resolved.startsWith(REGISTRY))
				bad.push(`package-lock.json packages[${show(p)}]: resolved ${show(e.resolved)} is not on ${REGISTRY}`);
			if (typeof e.integrity !== "string" || !/^sha512-/.test(e.integrity))
				bad.push(`package-lock.json packages[${show(p)}]: no sha512 integrity`);
			if (e.hasInstallScript === true && get(mainPkgs[p], "hasInstallScript") !== true)
				bad.push(`package-lock.json packages[${show(p)}]: a new install script`);
		}
		for (const b of bad) console.log(b);
		process.exit(bad.length ? 4 : 0);
	} else if (cmd === "set-version") {
		const [file, version] = args;
		if (!file || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version ?? "")) usage();
		const { text, json } = read(file);
		const isLock = isObj(json.packages);
		const want = structuredClone(json);
		want.version = version;
		if (isLock && isObj(want.packages[""])) want.packages[""].version = version;
		// Replace the first one (package.json) or two (package-lock.json) "version" keys in the text, then check
		// that this changed exactly the version fields; otherwise write the JSON anew.
		let n = isLock && has(json.packages[""], "version") ? 2 : 1;
		const out = text.replace(/("version"\s*:\s*)"[^"]*"/g, (m, k) => (n-- > 0 ? `${k}"${version}"` : m));
		let ok = false;
		try {
			ok = eq(JSON.parse(out), want);
		} catch {}
		if (ok) writeFileSync(file, out);
		else writeFileSync(file, `${JSON.stringify(want, null, indentOf(text))}\n`);
	} else if (cmd === "same-but-version") {
		const [a, b] = args.map(read).map((x) => x.json);
		process.exit(eq(withoutVersion(a), withoutVersion(b)) ? 0 : 4);
	} else usage();
} catch (e) {
	console.error(`manifest.mjs ${cmd}: ${e instanceof Error ? e.message : e}`);
	process.exit(1);
}
