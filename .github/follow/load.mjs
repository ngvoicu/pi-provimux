#!/usr/bin/env node
// The delivered package, loaded as pi loads it (docs/FOLLOWING.md 4.2). Run in the test container only, after
// npm ci, on the tarball npm pack made there:
//
//   load.mjs TGZ NODE_MODULES   extracts TGZ as npm installs it (npm's own node-tar, pacote's options) into a
//                               consumer folder of its own (node_modules/<name>, nothing else of
//                               the tree), links in only the package's peerDependencies from NODE_MODULES (what pi
//                               provides at run time), then has pi's own loader (discoverAndLoadExtensions of
//                               @earendil-works/pi-coding-agent) load the package: every extension pi.extensions
//                               registers must load with no error. A file the tarball lacks fails here, whatever
//                               the source says or how it names the file.
// Exit 0 loaded, 4 the package does not load, 1 the check itself could not run (pi is not installed).
// The consumer's HOME and pi's agent folder are new and empty, and the PROVIMUX_* variables are cleared: the
// extension loads unconfigured.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { entryProblems, extractLikeNpm, npmTar } from "./nodetar.mjs";

const PI = "@earendil-works/pi-coding-agent";
const NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const refuse = (msg) => {
	console.log(`load: ${msg}`);
	process.exit(4);
};
const fail = (msg) => {
	console.error(`load.mjs: ${msg}`);
	process.exit(1);
};

const [tgz, nodeModules] = process.argv.slice(2);
if (!tgz || !nodeModules) fail("usage: load.mjs TGZ NODE_MODULES");

// The tarball, extracted by npm's own node-tar with pacote's options (nodetar.mjs) into a staging folder, then
// moved to node_modules/<name> of a consumer folder of its own.
let nt;
try {
	nt = npmTar();
} catch (e) {
	refuse(`npm's bundled node-tar cannot be found or read: ${e instanceof Error ? e.message : e}`);
}
const consumer = mkdtempSync(join(tmpdir(), "follow-consumer-"));
const staging = join(consumer, "staging");
let got;
try {
	got = extractLikeNpm(nt.tar, tgz, staging);
} catch (e) {
	refuse(`npm's node-tar ${nt.tarVersion} cannot read the tarball: ${e instanceof Error ? e.message : e}`);
}
const problems = [...entryProblems(got.entries), ...got.warnings.map((w) => `node-tar warns: ${w}`), ...got.others.map((p) => `${p} is not a regular file`)];
if (problems.length) refuse(`the tarball is not a plain package: ${problems.join("; ").slice(0, 2000)}`);
if (!got.files.includes("package.json")) refuse("the tarball has no package.json");
const pkg = JSON.parse(readFileSync(join(staging, "package.json"), "utf8"));
if (typeof pkg.name !== "string" || !NAME.test(pkg.name)) refuse("package.json has no plain name");
const exts = pkg?.pi?.extensions;
if (!Array.isArray(exts) || exts.length === 0) refuse("package.json registers no extension (pi.extensions)");

const home = join(consumer, "home");
const agent = join(consumer, "agent");
mkdirSync(home);
mkdirSync(agent);
const dir = join(consumer, "node_modules", pkg.name);
mkdirSync(dirname(dir), { recursive: true });
renameSync(staging, dir);
// What pi provides at run time: the peers, and only those.
for (const peer of Object.keys(pkg.peerDependencies ?? {})) {
	if (!NAME.test(peer)) refuse(`peerDependencies has ${JSON.stringify(peer)}`);
	const from = resolve(nodeModules, peer);
	if (!existsSync(from)) continue;
	const to = join(consumer, "node_modules", peer);
	mkdirSync(dirname(to), { recursive: true });
	symlinkSync(from, to, "dir");
}
if (!existsSync(join(consumer, "node_modules", PI))) fail(`${PI} is not in ${nodeModules} or not a peer of the package`);

process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = agent;
for (const k of Object.keys(process.env)) if (k.startsWith("PROVIMUX_")) delete process.env[k];

// pi's loader, resolved from the consumer as an installed package would resolve it.
const entry = join(consumer, "load-pi.mjs");
writeFileSync(entry, `export { discoverAndLoadExtensions } from ${JSON.stringify(PI)};\n`);
let discoverAndLoadExtensions;
try {
	({ discoverAndLoadExtensions } = await import(pathToFileURL(entry).href));
} catch (e) {
	fail(`pi's loader does not import: ${e instanceof Error ? e.message : e}`);
}
if (typeof discoverAndLoadExtensions !== "function") fail("pi has no discoverAndLoadExtensions");

const result = await discoverAndLoadExtensions([dir], consumer, agent);
const errors = (result?.errors ?? []).map((e) => (typeof e === "string" ? e : (e?.error ?? JSON.stringify(e))));
const loaded = (result?.extensions ?? []).length;
console.log(JSON.stringify({ package: pkg.name, version: pkg.version, registered: exts.length, loaded, errors }));
if (errors.length) refuse(`pi could not load it: ${errors.join("; ").slice(0, 2000)}`);
if (loaded !== exts.length) refuse(`pi loaded ${loaded} of the ${exts.length} registered extensions`);
console.log(`load: ${pkg.name} ${pkg.version} loads, ${loaded} extension(s)`);
// The extension may keep timers or sockets open; the check is done.
process.exit(0);
