#!/usr/bin/env bash
# shellcheck disable=SC2016 # jq programs, Markdown and fixture text in single quotes: their $ and ` are literal
# Tests of the follow scripts and workflows on throwaway repositories: an "original" with releases and npm tarballs,
# a "fork" built on its 1.5.0, a stub npm registry (FOLLOW_NPM_DIR), a stub gh and a fake npm. Nothing leaves the
# temporary folder; no network.
#   bash .github/follow/test.sh            all, twice side by side: with GITHUB_ACTIONS unset and with it true
#   bash .github/follow/test.sh clean …    only the named ones, both ways
# FOLLOW_TEST_ACTIONS=unset or =true runs one way only. FOLLOW_TEST_SCRIPTS (default: this folder) and
# FOLLOW_TEST_TREE (default: this repository) point the tests at other scripts and another tree, e.g. an older
# revision's, to see what it fails.
set -euo pipefail

# Both ways: the scripts behave differently inside GitHub Actions (runner commands), so every case runs with
# GITHUB_ACTIONS unset and with GITHUB_ACTIONS=true, in two processes side by side.
if [[ -z ${FOLLOW_TEST_ACTIONS:-} ]]; then
	W=$(mktemp -d "${TMPDIR:-/tmp}/follow-test-ways.XXXXXX")
	trap 'rm -rf "${W:?}"' EXIT
	FOLLOW_TEST_ACTIONS='unset' bash "${BASH_SOURCE[0]}" "$@" >"$W/unset.log" 2>&1 &
	p1=$!
	FOLLOW_TEST_ACTIONS=true bash "${BASH_SOURCE[0]}" "$@" >"$W/true.log" 2>&1 &
	p2=$!
	rc=0
	wait "$p1" || rc=1
	wait "$p2" || rc=1
	for w in unset true; do
		echo "=== GITHUB_ACTIONS=$w"
		cat "$W/$w.log"
	done
	exit "$rc"
fi
[[ $FOLLOW_TEST_ACTIONS == unset || $FOLLOW_TEST_ACTIONS == true ]] || {
	echo "FOLLOW_TEST_ACTIONS is unset or true" >&2
	exit 2
}

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPTS=${FOLLOW_TEST_SCRIPTS:-$HERE}
TREE=${FOLLOW_TEST_TREE:-$(cd "$HERE/../.." && pwd)}
FOLLOW=$SCRIPTS/follow.sh
MANIFEST=$HERE/manifest.mjs
T=$(mktemp -d "${TMPDIR:-/tmp}/follow-test.XXXXXX")
trap 'rm -rf "${T:?}"' EXIT

PASS=0
FAIL=0
CASE=''
FAILED_CASES=''
# Under an npm older than 11.5.1, follow.sh refuses every command (2.1): run() then asserts that refusal, and the
# case's assertions about what follows it are skipped (counted in SKIP), not failed. GATED_CASE is that case.
SKIP=0
GATED_CASE=''
gated() { [[ -n $GATED_CASE && $GATED_CASE == "$CASE" ]] && SKIP=$((SKIP + 1)); }
# past_gate: false (and says so) when the current case was refused by the npm gate; a group whose next steps build on
# what follow.sh made (a candidate, a bundle) stops there: `past_gate || return 0`.
past_gate() {
	if [[ -n $GATED_CASE && $GATED_CASE == "$CASE" ]]; then
		echo "  [$CASE] stops at the npm gate's refusal (asserted); the rest of the group needs npm 11.5.1 or later"
		return 1
	fi
}
ok() { PASS=$((PASS + 1)); }
bad() {
	FAIL=$((FAIL + 1))
	case " $FAILED_CASES " in *" $CASE "*) ;; *) FAILED_CASES="$FAILED_CASES $CASE" ;; esac
	echo "  FAIL [$CASE] $*" >&2
	if [[ -n ${FOLLOW_TEST_VERBOSE:-} ]]; then printf '%s\n' "${RUN_OUT:-}" | awk '{ print "    | " $0 }' >&2; fi
}
eq() { gated && return 0; if [[ $1 == "$2" ]]; then ok; else bad "$3: got '$1', want '$2'"; fi; }
has() { gated && return 0; if grep -Fq -- "$2" <<<"$1"; then ok; else bad "$3: '$2' not in: $(head -c 600 <<<"$1")"; fi; }
hasnt() { gated && return 0; if grep -Fq -- "$2" <<<"$1"; then bad "$3: '$2' is in it"; else ok; fi; }
yes_() { gated && return 0; if "$@"; then ok; else bad "${CHECK:-check}: $*"; fi; }
# npm_older V: V is not a plain version of 11.5.1 or later (follow.sh's need_npm).
npm_older() {
	[[ $1 =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || return 0
	local a=${BASH_REMATCH[1]} b=${BASH_REMATCH[2]} c=${BASH_REMATCH[3]}
	((a < 11 || (a == 11 && (b < 5 || (b == 5 && c < 1)))))
}

export GIT_CONFIG_GLOBAL=$T/gitconfig GIT_CONFIG_NOSYSTEM=1
git config --global user.name Tester
git config --global user.email office@providers.dev
git config --global init.defaultBranch main
git config --global advice.detachedHead false
git config --global protocol.file.allow always
git config --global core.autocrlf false
unset GITHUB_ACTIONS GITHUB_OUTPUT GITHUB_REF DRY_RUN
if [[ $FOLLOW_TEST_ACTIONS == true ]]; then export GITHUB_ACTIONS=true; fi
export npm_config_userconfig=$T/npmrc-user npm_config_globalconfig=$T/npmrc-global npm_config_update_notifier=false
: >"$T/npmrc-user"
: >"$T/npmrc-global"

# Fixed dates: every commit one minute after the last.
TICK=1795000000
commit() {
	TICK=$((TICK + 60))
	GIT_AUTHOR_DATE="@$TICK +0000" GIT_COMMITTER_DATE="@$TICK +0000" git commit -q --no-verify -m "$1"
}
setver() {
	node "$MANIFEST" set-version package.json "$1"
	node "$MANIFEST" set-version package-lock.json "$1"
}
NOW=$(jq -rn '"2026-11-22T00:00:00Z" | fromdateiso8601')
ago() { jq -rn --argjson s "$((NOW - $1 * 3600))" '$s | todate'; }
sri() { node -e 'const c=require("crypto"),f=require("fs");process.stdout.write("sha512-"+c.createHash("sha512").update(f.readFileSync(process.argv[1])).digest("base64"))' "$1"; }
fake_sri() { node -e 'process.stdout.write("sha512-"+require("crypto").createHash("sha512").update(process.argv[1]).digest("base64"))' "$1"; }

# npm_set PKG LATEST "VERSION HOURS_AGO" …: the stub registry's data for PKG.
npm_set() {
	local pkg=$1 latest=$2 f
	shift 2
	f=$T/npm/$(printf %s "$pkg" | tr '/@' '__').json
	mkdir -p "$T/npm"
	{
		printf '{"dist-tags":{"latest":"%s"},"time":{' "$latest"
		local first=1 v h
		for x in "$@"; do
			v=${x% *}
			h=${x#* }
			((first)) || printf ','
			first=0
			printf '"%s":"%s"' "$v" "$(ago "$h")"
		done
		printf '}}\n'
	} >"$f"
}

# pack_release COMMIT VERSION [DIR [SKIP]]: npm's tarball of the original at COMMIT, as npm makes it (package/…, the
# regular files of package.json, README.md, LICENSE and extensions/, never an .npmrc or .npmignore), without the path
# SKIP, into the stub registry.
pack_release() {
	local c=$1 v=$2 dir=${3:-$FOLLOW_NPM_DIR} skip=${4:-} tgz
	mkdir -p "$dir"
	tgz=$dir/_router-for-me_pi-cliproxyapi-provider@$v.tgz
	git -C "$O" ls-tree -r "$c" | awk -F'\t' -v skip="$skip" '$1 ~ /^100(644|755) / && $2 != skip && $2 !~ /(^|\/)\.npm(rc|ignore)$/ && ($2 ~ /^extensions\// || $2 == "package.json" || $2 == "README.md" || $2 == "LICENSE") { print $2 }' >"$T/pack.list"
	node "$T/mktar.mjs" "$tgz" "${PACK_MODE:-plain}" "$O" "$c" "$T/pack.list"
	jq -n --arg t "$tgz" --arg i "$(sri "$tgz")" '{tarball: $t, integrity: $i}' >"$dir/_router-for-me_pi-cliproxyapi-provider@$v.dist.json"
}

# mktar.mjs OUT MODE REPO COMMIT LIST: a gzipped tar as npm makes it (plain ustar, package/<path>, regular files, a
# per-file PAX header with path, mtime and size for a name ustar cannot hold, one gzip member), of the files of LIST
# at COMMIT. MODE plain, or a header for MKTAR_TARGET (default extensions/lib.ts): pax-size (a PAX "size" longer than
# the base header's, the extra bytes after git's: node-tar installs them), pax-conflict (the review's case: a global
# PAX size one byte short and a per-file PAX size equal to the header's, which npm 10's and npm 11's node-tar read
# with different precedence; the file is put last), x (a PAX path), x-npm (path, mtime and size, as npm pack writes them), xkey:K=V (a PAX
# path and the key K), g (a PAX global header), L (a GNU long name), K (a GNU long link name), linkname (a
# regular-file header with a link target); or, after the files: hardlink, symlink, fifo, outside-file, outside-dir,
# dotdot-dir (package/../x/), pax-dangling (a PAX header with no entry), trailing (data after the end blocks); root
# (everything under pi-x/, not package/); gz-name (a gzip header with a file name), gz-two (two gzip members).
cat >"$T/mktar.mjs" <<-'JS'
	import { execFileSync } from "node:child_process";
	import { readFileSync, writeFileSync } from "node:fs";
	import { gzipSync } from "node:zlib";
	const [out, mode, repo, commit, list] = process.argv.slice(2);
	const target = process.env.MKTAR_TARGET || "extensions/lib.ts";
	const root = mode === "root" ? "pi-x" : "package";
	const header = (name, size, type, link = "") => {
		const h = Buffer.alloc(512);
		h.write(name, 0, 100, "utf8");
		h.write(link, 157, 100, "utf8");
		h.write("0000644\0", 100, "latin1");
		h.write("0000000\0", 108, "latin1");
		h.write("0000000\0", 116, "latin1");
		h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
		h.write("00000000000\0", 136, "latin1");
		h.write("        ", 148, "latin1");
		h[156] = type.charCodeAt(0);
		h.write("ustar\u000000", 257, "latin1");
		let s = 0;
		for (const b of h) s += b;
		h.write(`${s.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
		return h;
	};
	const pad = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
	const record = (kv) => {
		let n = Buffer.byteLength(kv) + 3;
		while (Buffer.byteLength(`${n} ${kv}\n`) !== n) n = Buffer.byteLength(`${n} ${kv}\n`);
		return Buffer.from(`${n} ${kv}\n`);
	};
	const parts = [];
	const ext = (type, data) => parts.push(header("PaxHeader", data.length, type), pad(data));
	const npmPax = (name, size) => Buffer.concat([record(`path=${name}`), record("mtime=499162500"), record(`size=${size}`)]);
	if (mode === "g") ext("g", record("comment=x"));
	const files = readFileSync(list, "utf8").split("\n").filter(Boolean);
	// A global header applies to every entry after it: the conflict's file last, so it is the only one it touches.
	if (mode === "pax-conflict") files.sort((a, b) => (a === target) - (b === target));
	for (const p of files) {
		let data = execFileSync("git", ["-C", repo, "cat-file", "blob", `${commit}:${p}`]);
		const name = `${root}/${p}`;
		let size = data.length;
		if (!/^[\x20-\x7e]{1,99}$/.test(name)) ext("x", npmPax(name, size));
		if (p === target) {
			if (mode === "pax-size") {
				data = Buffer.concat([data, Buffer.from(";globalThis.stolen = 1;\n")]);
				ext("x", record(`size=${data.length}`));
			} else if (mode === "pax-conflict") {
				ext("g", record(`size=${size - 1}`));
				ext("x", record(`size=${size}`));
			} else if (mode === "x") ext("x", record(`path=${name}`));
			else if (mode === "x-npm") ext("x", npmPax(name, size));
			else if (mode.startsWith("xkey:")) ext("x", Buffer.concat([record(`path=${name}`), record(mode.slice(5))]));
			else if (mode === "L") ext("L", Buffer.from(`${name}\0`));
			else if (mode === "K") ext("K", Buffer.from("x\0"));
			if (mode !== "pax-size") size = data.length;
			if (mode === "linkname") {
				parts.push(header(name, size, "0", "x"), pad(data));
				continue;
			}
		}
		parts.push(header(name, size, "0"), pad(data));
	}
	if (mode === "hardlink") parts.push(header(`${root}/hard`, 0, "1", `${root}/package.json`));
	if (mode === "symlink") parts.push(header(`${root}/sym`, 0, "2", "package.json"));
	if (mode === "fifo") parts.push(header(`${root}/fifo`, 0, "6"));
	if (mode === "outside-file") parts.push(header("other/manual.txt", 2, "0"), pad(Buffer.from("x\n")));
	if (mode === "outside-dir") parts.push(header("other/", 0, "5"));
	if (mode === "dotdot-dir") parts.push(header(`${root}/../x/`, 0, "5"));
	if (mode === "pax-dangling") ext("x", record(`path=${root}/extra`));
	parts.push(Buffer.alloc(1024));
	if (mode === "trailing") parts.push(pad(Buffer.from("trailing\n")));
	const tar = Buffer.concat(parts);
	let gz = gzipSync(tar);
	if (mode === "gz-name") gz = Buffer.concat([gz.subarray(0, 3), Buffer.from([8]), gz.subarray(4, 10), Buffer.from("x.tar\0"), gz.subarray(10)]);
	if (mode === "gz-two") gz = Buffer.concat([gzipSync(tar.subarray(0, 512)), gzipSync(tar.subarray(512))]);
	writeFileSync(out, gz);
JS

# --- the fixture --------------------------------------------------------------------------------------------------
build_fixture() {
	local o=$T/fixture/original f=$T/fixture/fork ia ib ip iq
	mkdir -p "$o"
	cd "$o"
	git init -q
	mkdir -p extensions test
	ia=$(fake_sri a)
	ib=$(fake_sri b)
	ip=$(fake_sri p)
	iq=$(fake_sri q)
	cat >package.json <<-'JSON'
		{
			"name": "@router-for-me/pi-cliproxyapi-provider",
			"version": "1.4.0",
			"description": "the original",
			"type": "module",
			"license": "MIT",
			"scripts": {
				"test": "vitest run",
				"check": "npm run test"
			},
			"pi": {
				"extensions": ["./extensions/index.ts"]
			},
			"peerDependencies": {
				"p": "1.0.0"
			},
			"devDependencies": {
				"a": "1.0.0",
				"b": "2.0.0"
			},
			"files": ["extensions", "README.md", "LICENSE", "CHANGELOG.md"]
		}
	JSON
	cat >package-lock.json <<-JSON
		{
			"name": "@router-for-me/pi-cliproxyapi-provider",
			"version": "1.4.0",
			"lockfileVersion": 3,
			"requires": true,
			"packages": {
				"": {
					"name": "@router-for-me/pi-cliproxyapi-provider",
					"version": "1.4.0",
					"license": "MIT",
					"peerDependencies": {
						"p": "1.0.0"
					},
					"devDependencies": {
						"a": "1.0.0",
						"b": "2.0.0"
					}
				},
				"node_modules/a": {
					"version": "1.0.0",
					"resolved": "https://registry.npmjs.org/a/-/a-1.0.0.tgz",
					"integrity": "$ia",
					"dev": true
				},
				"node_modules/b": {
					"version": "2.0.0",
					"resolved": "https://registry.npmjs.org/b/-/b-2.0.0.tgz",
					"integrity": "$ib",
					"dev": true,
					"hasInstallScript": true
				},
				"node_modules/p": {
					"version": "1.0.0",
					"resolved": "https://registry.npmjs.org/p/-/p-1.0.0.tgz",
					"integrity": "$ip",
					"peer": true,
					"dependencies": {
						"q": "^1.0.0"
					}
				},
				"node_modules/q": {
					"version": "1.0.0",
					"resolved": "https://registry.npmjs.org/q/-/q-1.0.0.tgz",
					"integrity": "$iq",
					"peer": true
				}
			}
		}
	JSON
	printf 'line 1\nline 2\nline 3\n' >extensions/index.ts
	printf 'export const x = 1;\n' >extensions/lib.ts
	printf 'test 1\nline 2\nline 3\nline 4\nline 5\n' >test/lib.test.ts
	printf '# The original\n\nInstall: pi install npm:@router-for-me/pi-cliproxyapi-provider\n' >README.md
	printf 'MIT License\n\nCopyright (c) router-for-me\n' >LICENSE
	printf 'export default {};\n' >vitest.config.ts
	printf '{}\n' >tsconfig.json
	git add -A
	commit "chore: start"
	printf 'export const x = 2;\n' >extensions/lib.ts
	git add -A
	commit "feat: x is 2"
	setver 1.4.1
	git add -A
	commit "chore: bump version to 1.4.1"
	printf 'line 1\nline 2 (original 1.5)\nline 3\n' >extensions/index.ts
	git add -A
	commit "feat: line 2 for 1.5"
	setver 1.5.0
	git add -A
	commit "chore: bump version to 1.5.0"

	# The fork: built on 1.5.0, renamed, its own README, tests (one new, one changed), file and changelog.
	git clone -q "$o" "$f"
	cd "$f"
	jq --tab '.name = "pi-provimux" | .version = "105.0.1" | .description = "the fork"
		| .repository = {type: "git", url: "git+https://github.com/ngvoicu/pi-provimux.git"}
		| .publishConfig = {access: "public"}' package.json >p.tmp
	mv p.tmp package.json
	jq --tab '.name = "pi-provimux" | .version = "105.0.1" | .packages[""].name = "pi-provimux" | .packages[""].version = "105.0.1"' \
		package-lock.json >l.tmp
	mv l.tmp package-lock.json
	printf '# pi-provimux\n\nInstall: pi install npm:pi-provimux\n' >README.md
	printf 'fork test\n' >test/fork.test.ts
	printf 'test 1 (the fork)\nline 2\nline 3\nline 4\nline 5\n' >test/lib.test.ts
	printf 'export const fork = true;\n' >extensions/fork.ts
	printf '# Changelog\n\n## 105.0.1\n\nThe fork.\n' >CHANGELOG.md
	git add -A
	commit "chore: the fork, pi-provimux 105.0.1"
	git remote rename origin router-for-me
}

# fresh NAME: copies of the fixture in $T/NAME; cd into the original. Sets O, F, OUT and the environment.
fresh() {
	CASE=$1
	rm -rf "${T:?}/$1"
	mkdir -p "$T/$1"
	cp -R "$T/fixture/original" "$T/fixture/fork" "$T/$1/"
	O=$T/$1/original
	F=$T/$1/fork
	OUT=$T/$1/out
	export FOLLOW_ORIGINAL_URL=$O FOLLOW_NPM_DIR=$T/$1/npm FOLLOW_NOW=$NOW FOLLOW_OUT=$OUT
	rm -rf "$T/npm"
	cd "$O"
}
npm_done() {
	mkdir -p "$FOLLOW_NPM_DIR" "$T/npm"
	cp -R "$T/npm/." "$FOLLOW_NPM_DIR/"
	rm -rf "$T/npm"
}
# release V [HOURS_AGO]: bump the original to V and pack it; npm's latest is V, published HOURS_AGO (default 48).
release() {
	cd "$O"
	setver "$1"
	git add -A
	commit "chore: bump version to $1"
	pack_release "$(git rev-parse HEAD)" "$1"
	npm_set @router-for-me/pi-cliproxyapi-provider "$1" "1.4.1 2000" "1.5.0 1000" "$1 ${2:-48}"
	npm_set pi-provimux 105.0.1 "105.0.1 900"
	npm_done
	cd "$F"
}
change() { # change FILE TEXT MESSAGE, in the current repository
	mkdir -p "$(dirname "$1")"
	printf '%s\n' "$2" >"$1"
	git add -A
	commit "$3"
}
run() { # run ARGS…: follow.sh in the current repository; output and exit code in RUN_OUT, RUN_RC
	RUN_RC=0
	local v real
	# The npm follow.sh would get, asked from a neutral folder: never from the fixture tree, so that no log of npm's
	# working folders (f8's fake npm) mistakes this probe for a call of follow.sh's.
	mkdir -p "$T/neutral"
	v=$(cd "$T/neutral" && npm --version 2>/dev/null | head -n 1) || v=''
	if [[ ! ${1:-} =~ ^(help|-h|--help)?$ ]] && npm_older "$v"; then
		# The npm follow.sh would get is too old: the refusal is the expected outcome, before any npm call but
		# --version (a shim in front of that npm logs every other call).
		real=$(command -v npm)
		mkdir -p "$T/gate-shim"
		: >"$T/gate-shim/calls"
		printf '#!/bin/sh\n[ "$1" = --version ] || echo "$*" >>"%s"\nexec "%s" "$@"\n' "$T/gate-shim/calls" "$real" >"$T/gate-shim/npm"
		chmod +x "$T/gate-shim/npm"
		RUN_OUT=$(PATH="$T/gate-shim:$PATH" bash "$FOLLOW" "$@" 2>&1) || RUN_RC=$?
		GATED_CASE=''
		eq "$RUN_RC" 1 "npm $v: follow.sh ${1:-} refused"
		has "$RUN_OUT" "npm $v is older than 11.5.1" "npm $v: follow.sh ${1:-} says why"
		eq "$(cat "$T/gate-shim/calls")" "" "npm $v: follow.sh ${1:-} made no npm call but --version"
		GATED_CASE=$CASE
		return 0
	fi
	RUN_OUT=$(bash "$FOLLOW" "$@" 2>&1) || RUN_RC=$?
}
runc() { # runc CMD…: any command; output and exit code in RUN_OUT, RUN_RC
	RUN_RC=0
	RUN_OUT=$("$@" 2>&1) || RUN_RC=$?
}
state() { jq -r '.state' "$OUT/result.json" 2>/dev/null || echo none; }
field() { jq -r --arg k "$1" '.[$k] // "" | if type == "array" then .[] else tostring end' "$OUT/result.json" 2>/dev/null || true; }
no_bundle() { if [[ -e $OUT/candidate.bundle ]]; then bad "$1: a bundle"; else ok; fi; }

# --- the cases ----------------------------------------------------------------------------------------------------
t_numbers() {
	CASE=numbers
	local f
	f=$(sed -n '/^PLAIN_RE=/p; /^is_plain() {/p; /^die() {/,/^}/p; /^shown() {/p; /^parts() {/,/^}/p; /^encode() {/,/^}/p; /^decode() {/,/^}/p' "$FOLLOW")
	eq "$(bash -c "$f"'; encode 1.5.0; encode 1.5.1; encode 1.6.0; encode 2.0.3; decode 105.0.3; decode 200.3.1')" \
		"$(printf '105.0\n105.1\n106.0\n200.3\n1.5.0\n2.0.3')" "encode/decode"
	eq "$(bash -c "$f"'; encode 1.100.0 || echo no; decode 2.0.0 || echo no; decode 105.0.0 || echo no')" \
		"$(printf 'no\nno\nno')" "limits"
}

t_clean() {
	fresh clean
	change extensions/lib.ts 'export const x = 3;' "fix: x is 3 *now* <b>@someone</b> (#45)"
	release 1.5.1
	run prepare
	eq "$RUN_RC" 0 "prepare exits 0"
	eq "$(state)" candidate "state"
	eq "$(field new_version)" 105.1.1 "new version"
	past_gate || return 0
	local r m main
	r=$(field candidate)
	m=$(git rev-parse "$r^")
	main=$(git rev-parse HEAD)
	eq "$(git rev-parse refs/follow/candidate)" "$r" "candidate ref"
	eq "$(git rev-list --parents -n 1 "$m" | cut -d' ' -f2-)" "$main $(git -C "$O" rev-parse HEAD)" "M's parents: main, B"
	eq "$(git log -1 --format=%s "$m")" "Merge pi-cliproxyapi-provider 1.5.1" "M's message"
	eq "$(git log -1 --format=%s "$r")" "pi-provimux 105.1.1 (pi-cliproxyapi-provider 1.5.1)" "R's message"
	eq "$(git log -1 --format='%an %cn' "$r")" "github-actions[bot] github-actions[bot]" "the bot's identity"
	eq "$(git log -1 --format=%cI "$r")" "$(git -C "$O" log -1 --format=%cI HEAD)" "B's committer date"
	eq "$(git show "$r:package.json" | jq -r '.name, .version, .description')" "$(printf 'pi-provimux\n105.1.1\nthe fork')" "package.json"
	eq "$(git show "$r:package-lock.json" | jq -r '.name, .version, .packages[""].name, .packages[""].version')" \
		"$(printf 'pi-provimux\n105.1.1\npi-provimux\n105.1.1')" "package-lock.json"
	eq "$(git show "$r:extensions/lib.ts")" "export const x = 3;" "the original's change"
	eq "$(git show "$r:README.md")" "$(git show "$main:README.md")" "README is the fork's"
	eq "$(git diff --name-only "$m" "$r" | tr '\n' ' ')" "CHANGELOG.md package-lock.json package.json " "R's files"
	local cl
	cl=$(git show "$r:CHANGELOG.md")
	has "$cl" "$(printf '# Changelog\n\n## 105.1.1\n\nFrom pi-cliproxyapi-provider `1.5.1` (merged automatically):')" "entry heading"
	has "$cl" '- fix: x is 3 \*now\* \<b\>\@someone\</b\> (\#45)' "subject, escaped"
	hasnt "$cl" "bump version to 1.5.1" "bump commits left out"
	has "$cl" "$(printf '\n## 105.0.1\n')" "the old entry stays"
	eq "$(git diff "$main" "$r" -- package.json | grep -c '^[-+]	')" 2 "package.json: only the version line changes"
	if [[ -s $OUT/candidate.bundle ]]; then ok; else bad "bundle"; fi
	eq "$(field readme_changed)" false "README unchanged"
	git clone -q --no-local "$F" "$T/clean/clone"
	git -C "$T/clean/clone" fetch -q "$OUT/candidate.bundle" "+refs/follow/candidate:refs/follow/candidate"
	eq "$(git -C "$T/clean/clone" rev-parse refs/follow/candidate)" "$r" "bundle fetch"
	# By hand on the work tree: the same commits; stamp ends with the guard.
	run merge
	eq "$RUN_RC" 0 "merge by hand"
	run stamp
	eq "$RUN_RC" 0 "stamp by hand, with the guard: $RUN_OUT"
	has "$RUN_OUT" "the guard passes" "stamp runs the guard"
	eq "$(git rev-parse HEAD)" "$r" "by hand gives the same commits"
}

t_rerun() {
	fresh rerun
	change extensions/lib.ts 'export const x = 4;' "fix: x is 4"
	release 1.5.1
	run prepare
	local first
	first=$(field candidate)
	run prepare
	eq "$(field candidate)" "$first" "a rerun gives the same candidate"
	cp -R "$F" "$T/rerun/fork2"
	cd "$T/rerun/fork2"
	FOLLOW_NOW=$((NOW + 7200)) run prepare
	eq "$(field candidate)" "$first" "another clone, later, the same candidate"
}

t_waiting() {
	fresh waiting
	change extensions/lib.ts 'export const x = 5;' "fix: x is 5"
	release 1.5.1 2
	run prepare
	eq "$RUN_RC" 0 "exit 0"
	eq "$(state)" waiting "state"
	eq "$(field ready_at)" "$(jq -rn --argjson s "$((NOW + 22 * 3600))" '$s | todate')" "taken 24 hours after npm's time"
	has "$RUN_OUT" "it is taken from" "says when"
	if git rev-parse -q --verify refs/follow/candidate >/dev/null; then bad "no candidate while waiting"; else ok; fi
	FOLLOW_NO_WAIT=true run prepare
	eq "$(state)" candidate "no_wait takes it now"
	FOLLOW_WAIT_HOURS=1 run select
	eq "$(state)" take "a shorter wait"
}

t_states() {
	fresh states
	npm_set @router-for-me/pi-cliproxyapi-provider 1.5.0 "1.4.1 2000" "1.5.0 1000"
	npm_done
	cd "$F"
	run select
	eq "$(state)" up-to-date "npm's latest is main's base"
	run select 1.4.1
	eq "$(state)" not-newer "an older version asked for"
	run select 1.9.9
	eq "$(state)" no-release-commit "a version npm lacks"
	run select 1.5.0-beta.1
	eq "$(state)" no-release-commit "not plain"
	eq "$(field fork_published)" false "the fork's version is not on the stub npm"
	npm_set @router-for-me/pi-cliproxyapi-provider 1.6.0 "1.6.0 48"
	npm_set pi-provimux 105.0.1 "105.0.1 900"
	npm_done
	run select
	eq "$(state)" no-release-commit "no bump commit"
	has "$(field reason)" "0 commits" "says none"
	cd "$O"
	setver 1.6.0 && git add -A && commit "chore: bump version to 1.6.0"
	setver 1.5.9 && git add -A && commit "chore: oops"
	setver 1.6.0 && git add -A && commit "chore: bump version to 1.6.0 again"
	cd "$F"
	run prepare
	eq "$(state)" no-release-commit "two bump commits"
	has "$(field reason)" "2 commits" "says two"
	eq "$(field fork_published)" true "the fork's version is on the stub npm"
	cd "$O"
	setver 1.100.0 && git add -A && commit "chore: bump version to 1.100.0"
	npm_set @router-for-me/pi-cliproxyapi-provider 1.100.0 "1.100.0 48"
	npm_done
	cd "$F"
	run prepare
	eq "$(state)" refused "minor 100"
}

t_conflict() {
	fresh conflict
	change extensions/index.ts "$(printf 'line 1\nline 2 (original 1.5.1)\nline 3')" "fix: line 2 again"
	release 1.5.1
	change extensions/index.ts "$(printf 'line 1\nline 2 (the fork)\nline 3')" "feat: the fork's line 2"
	local main
	main=$(git rev-parse HEAD)
	run prepare
	eq "$RUN_RC" 0 "prepare exits 0"
	eq "$(state)" conflict "state"
	eq "$(field conflicts)" "extensions/index.ts" "the file"
	eq "$(git status --porcelain)" "" "the work tree is untouched by prepare"
	if git rev-parse -q --verify refs/follow/candidate >/dev/null; then bad "no candidate"; else ok; fi
	run merge
	eq "$RUN_RC" 3 "merge by hand stops"
	has "$(git diff --name-only --diff-filter=U)" extensions/index.ts "left in the work tree"
	printf 'line 1\nline 2 (both)\nline 3\n' >extensions/index.ts
	git add extensions/index.ts
	run stamp
	eq "$RUN_RC" 0 "stamp after resolving, guard included: $RUN_OUT"
	eq "$(jq -r .version package.json)" 105.1.1 "version"
}

t_manifest_conflict() {
	fresh manifest-conflict
	cd "$O"
	jq --tab '.devDependencies.a = "1.1.0"' package.json >p && mv p package.json
	git add -A && commit "chore: a 1.1.0"
	release 1.5.1
	jq --tab '.devDependencies.a = "1.2.0"' package.json >p && mv p package.json
	git add -A && commit "chore: a 1.2.0"
	run prepare
	eq "$(state)" conflict "state"
	eq "$(field conflicts)" "package.json devDependencies.a: changed on both sides" "the key"
}

# The rule still merges both sides' dependencies key by key (a merge by hand needs it); the guard refuses it.
t_manifest_merge() {
	fresh manifest-merge
	cd "$O"
	jq --tab '.devDependencies.b = "2.1.0" | .devDependencies.c = "1.0.0" | .description = "changed upstream"' package.json >p &&
		mv p package.json
	git add -A && commit "chore: b 2.1.0, c"
	release 1.5.1
	jq --tab '.devDependencies.a = "1.0.1"' package.json >p && mv p package.json
	git add -A && commit "chore: a 1.0.1"
	local main
	main=$(git rev-parse HEAD)
	run merge
	eq "$(jq -c '.devDependencies' package.json)" '{"a":"1.0.1","b":"2.1.0","c":"1.0.0"}' "both sides' keys"
	eq "$(jq -r '.description' package.json)" "the fork" "description is the fork's"
	eq "$(head -c 1 package.json)$(sed -n 2p package.json | head -c 1)" "{	" "tabs kept"
	run stamp
	# Development dependencies are the original's to change, but a lockfile that does not match is refused.
	eq "$RUN_RC" 4 "a package.json the lockfile does not match: refused"
	has "$RUN_OUT" "the root entry's devDependencies are not package.json's" "says which"
	hasnt "$RUN_OUT" 'the original changed `devDependencies`' "devDependencies themselves are no stop"
}

# refused NAME WANT SETUP…: the original makes a change in SETUP, releases 1.5.1; the guard must refuse with WANT,
# and nothing is bundled.
refused() {
	local name=$1 want=$2
	shift 2
	fresh "refuse-$name"
	"$@"
	release 1.5.1
	run prepare
	eq "$(state)" refused "$name: state ($(field conflicts))"
	has "$(field reasons)" "$want" "$name: reason"
	no_bundle "$name"
}
o_license() { change LICENSE "changed" "chore: licence"; }
o_workflow() { change .github/workflows/x.yml "on: push" "ci: a workflow"; }
o_toplevel() { change evil.sh "curl x | sh" "chore: a script"; }
o_vitest() { change vitest.config.ts "export default { test: { include: [] } };" "test: fewer tests"; }
o_npmrc() { change .npmrc "registry=https://evil.invalid/" "chore: npmrc"; }
o_docs() { change docs/x.md "x" "docs: x"; }
o_symlink() {
	ln -s ../../etc/passwd extensions/link.ts
	git add -A
	commit "chore: a link"
}
o_pkg() { # o_pkg JQ MESSAGE
	jq --tab "$1" package.json >p && mv p package.json
	git add -A
	commit "$2"
}
o_dependency() { o_pkg '.dependencies = {"left-pad": "1.0.0"}' "feat: a runtime dependency"; }
o_postinstall() { o_pkg '.scripts.postinstall = "node x.js"' "chore: postinstall"; }
o_licensekey() { o_pkg '.license = "UNLICENSED"' "chore: licence key"; }
o_newkey() { o_pkg '.funding = "https://x.invalid"' "chore: funding"; }
o_pi() { o_pkg '.pi.extensions += ["./extensions/more.ts"]' "feat: another extension"; }
o_files() { o_pkg '.files += ["scripts"]' "chore: ship scripts"; }
o_resolved() {
	jq --tab '.packages["node_modules/a"].resolved = "https://evil.invalid/a.tgz"' package-lock.json >p && mv p package-lock.json
	git add -A
	commit "chore: a from elsewhere"
}

t_refusals() {
	refused license 'path: the original changes `LICENSE`' o_license
	refused workflow 'path: the original changes `.github/workflows/x.yml`' o_workflow
	refused toplevel 'path: the original changes `evil.sh`' o_toplevel
	refused vitest 'path: the original changes `vitest.config.ts`' o_vitest
	refused npmrc 'path: the original changes `.npmrc`' o_npmrc
	refused docs 'path: the original changes `docs/x.md`' o_docs
	refused symlink 'becomes a symbolic link' o_symlink
	refused dependency 'package.json: the original added `dependencies`' o_dependency
	refused postinstall 'package.json: the original changed `scripts`' o_postinstall
	refused licensekey 'package.json: the original changed `license`' o_licensekey
	refused newkey 'package.json: the original added `funding`' o_newkey
	refused pi 'package.json: the original changed `pi`' o_pi
	refused files 'package.json: the original changed `files`' o_files
	refused resolved 'resolved is not https://registry.npmjs.org/a/-/a-1.0.0.tgz' o_resolved
}

# Candidates made wrong after the merge: the guard checks what it is given, not what prepare made.
t_shape() {
	local main
	fresh shape
	change extensions/lib.ts 'export const x = 6;' "fix: x is 6"
	release 1.5.1
	main=$(git rev-parse HEAD)
	amend() { GIT_COMMITTER_DATE="@$TICK +0000" git commit -q --amend --no-edit; }
	# The fork's own test changed in M.
	run merge
	printf 'weakened\n' >test/fork.test.ts
	git add -A && amend
	run stamp
	eq "$RUN_RC" 4 "own test: exit 4"
	has "$RUN_OUT" "the fork's test" "own test"
	# README changed in M.
	git reset -q --hard "$main"
	run merge
	printf 'other readme\n' >README.md
	git add -A && amend
	run stamp
	has "$RUN_OUT" "README.md is not main's" "README"
	# R changes another file.
	git reset -q --hard "$main"
	run merge
	run stamp
	printf 'sneaky\n' >>extensions/lib.ts
	git add -A && amend
	run guard "$main"
	has "$RUN_OUT" 'shape: R changes' "R's files"
	# R changes more than the version in package.json.
	git reset -q --hard "$main"
	run merge
	run stamp
	jq --tab '.scripts.check = "true"' package.json >p && mv p package.json
	git add -A && amend
	run guard "$main"
	has "$RUN_OUT" 'shape: R changes more than the version in package.json' "R's package.json"
	# A wrong version.
	git reset -q --hard "$main"
	run merge
	run stamp
	setver 105.1.2
	git add -A && amend
	run guard "$main"
	has "$RUN_OUT" 'version: R says 105.1.2, 1.5.1 gives 105.1.1' "version"
	# A third commit.
	git reset -q --hard "$main"
	run merge
	run stamp
	change extra.txt x "chore: extra"
	run guard "$main"
	has "$RUN_OUT" 'main..R is 3 commits on main' "three commits"
	# Not a merge at all.
	git reset -q --hard "$main"
	change extensions/lib.ts 'x' "a"
	change extensions/lib.ts 'y' "b"
	run guard "$main"
	has "$RUN_OUT" 'M is not a merge' "no merge"
	git reset -q --hard "$main"
	run guard "$main"
	eq "$RUN_RC" 4 "the guard refuses main itself"
}

t_readme() {
	fresh readme
	change README.md "$(printf '# The original\n\nNew: Ultra Fast mode.\n')" "docs: ultra fast"
	change extensions/lib.ts 'export const x = 7;' "fix: x is 7"
	release 1.5.1
	run prepare
	eq "$(state)" candidate "state"
	eq "$(git show "$(field candidate):README.md")" "$(git show HEAD:README.md)" "README byte for byte the fork's"
	eq "$(field readme_changed)" true "README changed upstream"
	has "$(cat "$OUT/readme.diff")" "+New: Ultra Fast mode." "the original's README diff"
	fresh readme-both
	change README.md "$(printf '# The original\n\nInstall: something else\n')" "docs: install"
	release 1.5.1
	change README.md "$(printf '# pi-provimux\n\nInstall: npm:pi-provimux, now with more\n')" "docs: the fork's install"
	run prepare
	eq "$(state)" candidate "both changed README: state"
	eq "$(git show "$(field candidate):README.md")" "$(git show HEAD:README.md)" "both changed README: the fork's"
}

# --- finding 2: the commit is the release npm ships ------------------------------------------------------------
t_f2_release() {
	local b
	# A file npm ships that is not the commit's.
	fresh f2-tamper
	change extensions/lib.ts 'export const x = 8;' "fix: x is 8"
	release 1.5.1
	cd "$O"
	b=$(git rev-parse HEAD)
	git checkout -q -b evil
	change extensions/lib.ts 'export const x = "stolen";' "evil"
	pack_release "$(git rev-parse HEAD)" 1.5.1 "$FOLLOW_NPM_DIR"
	git checkout -q main
	cd "$F"
	run prepare
	eq "$(state)" refused "a tarball with other bytes: refused"
	has "$(field reasons)" 'tarball: "extensions/lib.ts" differs from the commit' "says which file"
	no_bundle "tamper"
	# A file npm ships that the commit lacks.
	fresh f2-extra
	release 1.5.1
	cd "$O"
	git checkout -q -b extra
	change extensions/extra.ts 'export {};' "extra"
	pack_release "$(git rev-parse HEAD)" 1.5.1 "$FOLLOW_NPM_DIR"
	git checkout -q main
	cd "$F"
	run prepare
	eq "$(state)" refused "a tarball with a file the commit lacks: refused"
	has "$(field reasons)" 'tarball: "extensions/extra.ts" is not in the commit' "says which file"
	# A file the commit ships that npm's tarball lacks (the other way round).
	fresh f2-lacks
	change extensions/lib.ts 'export const x = 81;' "fix: x is 81"
	release 1.5.1
	cd "$O"
	pack_release "$(git rev-parse HEAD)" 1.5.1 "$FOLLOW_NPM_DIR" extensions/lib.ts
	cd "$F"
	run prepare
	eq "$(state)" refused "a tarball without a file the commit ships: refused"
	has "$(field reasons)" 'tarball: the commit ships "extensions/lib.ts", npm'"'"'s tarball lacks it' "says which file"
	no_bundle "lacks"
	# Tar headers pass a strict pre-scan (headers.mjs) before npm's own node-tar extracts anything, so nothing that
	# two node-tar versions read differently gets through: pax-size (a PAX size longer than the base header's: npm
	# would install a hidden line), pax-conflict (the review's case, on README.md: a global and a per-file PAX size
	# that npm 10 and npm 11 read with different precedence), a regular file with a link target (linkname), a GNU
	# long link name (K) or long name (L) and a global PAX header (g) are refused before extraction. A per-file PAX
	# path (x) and npm pack's own path, mtime and size (x-npm) pass.
	local mode want target
	for mode in pax-size pax-conflict linkname K L g x x-npm; do
		fresh "f2-header-$mode"
		change extensions/lib.ts 'export const x = 82;' "fix: x is 82"
		release 1.5.1
		cd "$O"
		target=extensions/lib.ts
		[[ $mode == pax-conflict ]] && target=README.md
		PACK_MODE=$mode MKTAR_TARGET=$target pack_release "$(git rev-parse HEAD)" 1.5.1
		cd "$F"
		run prepare
		case $mode in
		pax-size) want="\"package/$target\": its PAX size" ;;
		pax-conflict) want='a global PAX header (g)' ;;
		linkname) want='a link target ("x"): links are refused' ;;
		K) want='a GNU long link name header (K)' ;;
		L) want='a GNU long name header (L)' ;;
		g) want='a global PAX header (g)' ;;
		*) want='' ;;
		esac
		if [[ -n $want ]]; then
			eq "$(state)" refused "a tarball with a $mode header: refused"
			has "$(field reasons)" "tarball: refused before extraction: " "$mode: refused before node-tar reads it"
			has "$(field reasons)" "$want" "$mode: says why"
			no_bundle "header-$mode"
		else
			eq "$(state)" candidate "a tarball with a $mode header naming the same file: read as npm reads it: $(field reasons)"
		fi
	done
	# A file name npm pack writes with a PAX header (non-ASCII), packed by npm itself: read the same as npm's.
	CASE=f2-pax-name
	local P=$T/f2-pax-name
	rm -rf "$P"
	mkdir -p "$P/repo/docs" "$P/out"
	(
		cd "$P/repo"
		git init -q
		printf '{"name": "pax-name", "version": "1.0.0", "files": ["docs"]}\n' >package.json
		printf 'caf\303\251\n' >$'docs/caf\303\251.md'
		git add -A && commit "café"
		npm pack --ignore-scripts --pack-destination "$P/out" >/dev/null 2>&1
		npm pack --dry-run --ignore-scripts --json 2>/dev/null | jq -r '.[0].files[].path' | LC_ALL=C sort >"$P/ships"
	)
	local tgz=$P/out/pax-name-1.0.0.tgz
	eq "$(gzip -dc "$tgz" | LC_ALL=C grep -ac 'path=package/docs/café.md' || true)" 1 "npm pack wrote a PAX header for the name"
	has "$(cat "$P/ships")" "docs/café.md" "npm ships docs/café.md"
	cd "$P/repo"
	runc node "$SCRIPTS/tarball.mjs" compare "$tgz" "$(git -C "$P/repo" rev-parse HEAD)" "$P/ships"
	eq "$RUN_RC" 0 "a PAX file name: read as npm reads it, the same as git's: $RUN_OUT"
	# The keys npm pack writes in that per-file PAX header (node-tar's WriteEntry, pacote's portable: true): path,
	# mtime and size, the size the header's own; npm 10.9.3 and 11.19.1 write the same bytes. The pre-scan allows
	# exactly these.
	eq "$(gzip -dc "$tgz" | LC_ALL=C grep -ao '[0-9]* [a-z]*=' | sed 's/^[0-9]* //' | tr '\n' ' ')" "path= mtime= size= " "npm pack's PAX keys"
	# The pre-scan, on the same package: everything outside the allowed headers is refused before extraction,
	# whatever node-tar would do, and so also with an npm on PATH that has no node-tar at all (fakenpm, below).
	local pc m
	pc=$(git -C "$P/repo" rev-parse HEAD)
	for m in plain x-npm; do
		MKTAR_TARGET=package.json node "$T/mktar.mjs" "$P/$m.tgz" "$m" "$P/repo" "$pc" "$P/ships"
		runc node "$SCRIPTS/tarball.mjs" compare "$P/$m.tgz" "$pc" "$P/ships"
		eq "$RUN_RC" 0 "pre-scan control $m: passes: $RUN_OUT"
	done
	for m in hardlink symlink fifo outside-file outside-dir dotdot-dir root pax-dangling trailing gz-name gz-two \
		pax-size pax-conflict linkname K L g xkey:size=1 xkey:linkpath=x xkey:uid=0 xkey:gid=0 xkey:uname=x \
		xkey:gname=x xkey:atime=1 xkey:ctime=1 xkey:charset=x xkey:comment=x xkey:path=package/x; do
		MKTAR_TARGET=package.json node "$T/mktar.mjs" "$P/bad.tgz" "$m" "$P/repo" "$pc" "$P/ships"
		runc node "$SCRIPTS/tarball.mjs" compare "$P/bad.tgz" "$pc" "$P/ships"
		eq "$RUN_RC" 4 "pre-scan $m: refused"
		has "$RUN_OUT" "tarball: refused before extraction: " "pre-scan $m: before node-tar reads it"
	done
	# No bundled node-tar (an npm on PATH whose install has none): refused, never read another way.
	mkdir -p "$P/fakenpm/bin" "$P/fakenpm/lib/npm"
	printf '{"name": "npm", "version": "0.0.0-fake"}\n' >"$P/fakenpm/lib/npm/package.json"
	printf '#!/bin/sh\ncase "$1" in --version) echo 0.0.0-fake ;; root) echo "%s" ;; *) exit 1 ;; esac\n' "$P/fakenpm/lib" >"$P/fakenpm/bin/npm"
	chmod +x "$P/fakenpm/bin/npm"
	PATH="$P/fakenpm/bin:$PATH" runc node "$SCRIPTS/tarball.mjs" compare "$tgz" "$(git -C "$P/repo" rev-parse HEAD)" "$P/ships"
	eq "$RUN_RC" 4 "no bundled node-tar: refused"
	has "$RUN_OUT" "node-tar cannot be found or read" "says so"
	# A refused header is refused with no node-tar at all: the pre-scan does not depend on one.
	for m in hardlink symlink outside-file root pax-conflict; do
		MKTAR_TARGET=package.json node "$T/mktar.mjs" "$P/bad.tgz" "$m" "$P/repo" "$pc" "$P/ships"
		PATH="$P/fakenpm/bin:$PATH" runc node "$SCRIPTS/tarball.mjs" compare "$P/bad.tgz" "$pc" "$P/ships"
		eq "$RUN_RC" 4 "pre-scan $m with no node-tar: refused"
		has "$RUN_OUT" "tarball: refused before extraction: " "pre-scan $m with no node-tar: by the pre-scan"
	done
	cd "$F"
	# The bytes are not what the registry's integrity says.
	fresh f2-integrity
	release 1.5.1
	jq --arg i "$(fake_sri other)" '.integrity = $i' "$FOLLOW_NPM_DIR/_router-for-me_pi-cliproxyapi-provider@1.5.1.dist.json" >"$T/d" &&
		mv "$T/d" "$FOLLOW_NPM_DIR/_router-for-me_pi-cliproxyapi-provider@1.5.1.dist.json"
	run prepare
	eq "$(state)" refused "an integrity that does not match: refused"
	has "$(field reasons)" "the tarball's sha512 is" "says so"
	# No tarball for the version.
	fresh f2-missing
	release 1.5.1
	rm "$FOLLOW_NPM_DIR/_router-for-me_pi-cliproxyapi-provider@1.5.1.dist.json"
	run prepare
	eq "$(state)" refused "no tarball: refused"
	# A rewritten branch: another commit that sets 1.5.1, with another tree, after npm's tarball was made.
	fresh f2-rewritten
	release 1.5.1
	cd "$O"
	git reset -q --hard HEAD~1
	change extensions/lib.ts 'export const x = "rewritten";' "fix: rewritten"
	setver 1.5.1 && git add -A && commit "chore: bump version to 1.5.1"
	cd "$F"
	run prepare
	eq "$(state)" refused "a rewritten release commit: refused"
}

# --- finding 3: upstream strings, links before writes, checker failures, the recheck -----------------------------
t_f3_strings() {
	fresh f3-records
	cd "$O"
	# An unpublished commit whose version has a space: one token, never read as "1.5.1".
	jq --tab '.version = "1.5.1 x"' package.json >p && mv p package.json
	git add -A && commit "chore: odd version"
	setver 1.5.0 && git add -A && commit "chore: back"
	change extensions/lib.ts 'export const x = 9;' "fix: x is 9"
	release 1.5.1
	run prepare
	eq "$(state)" candidate "an odd version upstream adds no record: $(field reason)"
	eq "$(field bump)" "$(git -C "$O" rev-parse HEAD)" "the real bump commit"
	# The old base's version reaches arithmetic only when plain.
	fresh f3-arith
	cd "$O"
	jq --tab '.version = "0+BASH_VERSINFO[$(>PWNED)]"' package.json >p && mv p package.json
	git add -A && commit "chore: hostile version"
	cd "$F"
	git fetch -q "$O" main
	git merge -q -s ours --no-edit FETCH_HEAD
	cd "$O"
	setver 1.5.1 && git add -A && commit "chore: bump version to 1.5.1"
	pack_release "$(git rev-parse HEAD)" 1.5.1
	npm_set @router-for-me/pi-cliproxyapi-provider 1.5.1 "1.5.1 48"
	npm_done
	cd "$F"
	run prepare
	if [[ -e PWNED || -e $O/PWNED ]]; then bad "a version string was run"; else ok; fi
	hasnt "$RUN_OUT" '[$(>PWNED' "the hostile version is not shown"
	# The version asked for, with a line break and a runner command: checked before it is shown.
	fresh f3-input
	release 1.5.1
	FOLLOW_VERSION=$'1.5.1\n::error::forged' run prepare
	hasnt "$RUN_OUT" "::error::forged" "the input is not echoed"
	eq "$(state)" no-release-commit "refused as not plain"
	# Inside GitHub Actions, the script's output cannot carry runner commands.
	GITHUB_ACTIONS=true run select
	has "$(head -n 1 <<<"$RUN_OUT")" "::stop-commands::" "commands stopped first"
}

# The artifact hand-over: fetch-candidate prints exactly the commit on standard output, with GITHUB_ACTIONS unset
# and true (the runner-command markers go to standard error).
t_f3_handoff() {
	fresh f3-handoff
	gh_stub
	change extensions/lib.ts 'export const x = 12;' "fix: x is 12"
	release 1.5.1
	run prepare
	past_gate || return 0
	local r d z=$T/f3-handoff/zip out ga
	r=$(field candidate)
	mkdir -p "$z"
	cp "$OUT/candidate.bundle" "$z/"
	(cd "$z" && zip -q -X a.zip candidate.bundle)
	d=$( (sha256sum "$z/a.zip" 2>/dev/null || shasum -a 256 "$z/a.zip") | cut -d' ' -f1)
	cp "$z/a.zip" "$GH_DIR/artifact.zip"
	jq -n --arg d "sha256:$d" '{workflow_run: {id: 777}, name: "follow-candidate", expired: false, digest: $d}' >"$GH_DIR/artifact.json"
	git clone -q --no-local "$F" "$T/f3-handoff/land"
	cd "$T/f3-handoff/land"
	for ga in '' true; do
		out=$(GITHUB_ACTIONS=$ga GITHUB_RUN_ID=777 FOLLOW_OUT=$T/f3-handoff/out-$ga PATH="$T/gh/bin:$PATH" bash "$FOLLOW" fetch-candidate 4242 "$d" 2>/dev/null) || true
		eq "$out" "$r" "standard output is exactly the commit (GITHUB_ACTIONS=${ga:-unset})"
	done
	out=$(GITHUB_ACTIONS=true GITHUB_RUN_ID=777 FOLLOW_OUT=$T/f3-handoff/out-e PATH="$T/gh/bin:$PATH" bash "$FOLLOW" fetch-candidate 4242 "$d" 2>&1 >/dev/null) || true
	has "$out" "::stop-commands::" "the commands are still stopped, on standard error"
	cd "$F"
}

t_f3_links() {
	fresh f3-links
	printf 'outside\n' >"$T/victim"
	cd "$O"
	ln -s "$T/victim" CHANGELOG.md
	git add -A && commit "chore: a changelog that is a link"
	release 1.5.1
	run prepare
	eq "$(state)" refused "a link where the merge writes: refused"
	eq "$(cat "$T/victim")" "outside" "nothing written through the link"
	has "$(field reasons)" 'CHANGELOG.md' "says which"
	no_bundle "links"
}

t_f3_checker() {
	fresh f3-checker
	change extensions/lib.ts 'export const x = 10;' "fix: x is 10"
	release 1.5.1
	local main
	main=$(git rev-parse HEAD)
	run merge
	run stamp
	# A node that fails for the manifest's stops check: the guard must fail, not pass.
	mkdir -p "$T/badnode"
	cat >"$T/badnode/node" <<-SH
		#!/usr/bin/env bash
		case " \$* " in *" stops "*) echo "boom" >&2; exit 1 ;; esac
		exec "$(command -v node)" "\$@"
	SH
	chmod +x "$T/badnode/node"
	PATH="$T/badnode:$PATH" run guard "$main"
	eq "$RUN_RC" 1 "a failing checker is an error"
	hasnt "$RUN_OUT" "the guard passes" "never a pass"
}

# --- finding 4: dependencies and install scripts -----------------------------------------------------------------
t_f4_deps() {
	local reach="the root's dependencies, optionalDependencies or peerDependencies reach it: users would get it"
	refused devtodep 'package.json: the original added `dependencies`' o_pkg '.dependencies = {"a": .devDependencies.a} | del(.devDependencies.a)' "chore: a for users"
	refused peerdep 'package.json: the original changed `peerDependencies`' o_pkg '.peerDependencies.x = "*"' "chore: a peer"
	refused optdep 'package.json: the original added `optionalDependencies`' o_pkg '.optionalDependencies = {"y": "1"}' "chore: optional"
	# What users would get is read from the lock's graph (root peer p, then q), never from the "dev" flag.
	refused shipped "packages[\"node_modules/q\"]: changed, and $reach (it runs install scripts)" \
		o_lock '.packages["node_modules/q"] += {version: "1.0.1", resolved: "https://registry.npmjs.org/q/-/q-1.0.1.tgz", hasInstallScript: true}'
	refused devflag "packages[\"node_modules/q\"]: changed, and $reach" \
		o_lock '.packages["node_modules/q"] += {version: "1.0.1", resolved: "https://registry.npmjs.org/q/-/q-1.0.1.tgz", dev: true}'
	refused removed "packages[\"node_modules/q\"]: removed, and $reach" o_lock 'del(.packages["node_modules/q"])'
	# npm resolves p's q to a new nested entry, marked dev: a production edge, so refused.
	refused nested "packages[\"node_modules/p/node_modules/q\"]: added, and $reach" \
		o_lock '.packages["node_modules/p/node_modules/q"] = (.packages["node_modules/q"] + {version: "2.0.0", resolved: "https://registry.npmjs.org/q/-/q-2.0.0.tgz", dev: true} | del(.peer))'
	# Another package's tarball and digest under a development dependency's name.
	refused othertarball 'packages["node_modules/a"]: resolved is not https://registry.npmjs.org/a/-/a-1.0.0.tgz' \
		o_lock '.packages["node_modules/a"].resolved = .packages["node_modules/b"].resolved | .packages["node_modules/a"].integrity = .packages["node_modules/b"].integrity'
	refused integrity 'no full sha512 integrity' o_lock '.packages["node_modules/a"].integrity = "sha512-aaaa"'
	refused nointegrity '"node_modules/a"]: no full sha512 integrity' o_lock 'del(.packages["node_modules/a"].integrity)'
	refused rootentry "the root entry's devDependencies are not package.json's" o_lock '.packages[""].devDependencies.z = "1.0.0"'
	refused link 'packages["node_modules/a"]: a link or a bundled package' o_lock '.packages["node_modules/a"] = {resolved: "../a", link: true}'
	# A local-file development dependency with a matching root map and no entry.
	refused filedev "the root's devDependencies \"x\" has no entry node_modules/x" \
		o_both '.devDependencies.x = "file:../x"' '.packages[""].devDependencies.x = "file:../x"'
	# An entry that installs another package than the declaration asks for (the third review's stale same-version
	# alias): the root asks for a@1.0.0, the entry at node_modules/a installs evil@1.0.0 from the registry.
	refused stalealias 'packages["node_modules/a"]: installs "evil", but the root'"'"'s devDependencies asks for "a"' \
		o_lock '.packages["node_modules/a"] += {name: "evil", resolved: "https://registry.npmjs.org/evil/-/evil-1.0.0.tgz"}'
	# An alias declaration whose entry installs the alias's own name, not the package it names.
	refused aliasnoname 'packages["node_modules/al"]: installs "al", but the root'"'"'s devDependencies asks for "a"' \
		o_both '.devDependencies.al = "npm:a@1.0.0"' '.packages[""].devDependencies.al = "npm:a@1.0.0" | .packages["node_modules/al"] = (.packages["node_modules/a"] + {resolved: "https://registry.npmjs.org/al/-/al-1.0.0.tgz"})'
	# A declaration of another source (git), resolved to a registry entry.
	refused gitsource 'packages["node_modules/b"]: "node_modules/a"'"'"'s dependencies asks for "b" as "github:x/b", not from the registry' \
		o_lock '.packages["node_modules/a"].dependencies = {b: "github:x/b"}'
	# The checker itself, on a lock with no root entry (the merge rule would keep the fork's root).
	CASE=f4-noroot
	local L=$T/f4-noroot
	mkdir -p "$L"
	git -C "$T/fixture/fork" show HEAD:package-lock.json >"$L/main.json"
	git -C "$T/fixture/fork" show HEAD:package.json >"$L/pkg.json"
	jq 'del(.packages[""])' "$L/main.json" >"$L/cand.json"
	runc node "$SCRIPTS/manifest.mjs" lock-check "$L/main.json" "$L/cand.json" "$L/pkg.json"
	eq "$RUN_RC" 4 "a lock with no root entry: refused"
	has "$RUN_OUT" "package-lock.json: no root entry" "says so"
}
o_lock() {
	jq --tab "$1" package-lock.json >p && mv p package-lock.json
	git add -A
	commit "chore: the lockfile"
}
o_both() { # o_both PACKAGE_JQ LOCK_JQ
	jq --tab "$1" package.json >p && mv p package.json
	jq --tab "$2" package-lock.json >p && mv p package-lock.json
	git add -A
	commit "chore: package.json and the lockfile"
}

# The original bumps its development dependencies, one of them with install scripts: it lands.
t_f4_dev_lands() {
	fresh f4-dev-lands
	jq --tab '.devDependencies.a = "1.1.0" | .devDependencies.b = "2.1.0"' package.json >p && mv p package.json
	jq --tab --arg ia "$(fake_sri a110)" --arg ib "$(fake_sri b210)" '.packages[""].devDependencies.a = "1.1.0" | .packages[""].devDependencies.b = "2.1.0"
		| .packages["node_modules/a"] += {version: "1.1.0", resolved: "https://registry.npmjs.org/a/-/a-1.1.0.tgz", integrity: $ia}
		| .packages["node_modules/b"] += {version: "2.1.0", resolved: "https://registry.npmjs.org/b/-/b-2.1.0.tgz", integrity: $ib}' \
		package-lock.json >p && mv p package-lock.json
	git add -A && commit "chore: bump a and b"
	release 1.5.1
	run prepare
	eq "$(state)" candidate "a development dependency bump lands: $(field reasons)"
	eq "$(git show "$(field candidate):package.json" | jq -c .devDependencies)" '{"a":"1.1.0","b":"2.1.0"}' "the new versions"
	eq "$(git show "$(field candidate):package-lock.json" | jq -r '.packages["node_modules/b"].version, .packages["node_modules/b"].hasInstallScript')" \
		"$(printf '2.1.0\ntrue')" "the install-script dev entry, changed"
	# A legitimate alias: node_modules/al installs a@1.0.0, the registry's tarball of a.
	fresh f4-alias
	o_both '.devDependencies.al = "npm:a@1.0.0"' '.packages[""].devDependencies.al = "npm:a@1.0.0" | .packages["node_modules/al"] = (.packages["node_modules/a"] + {name: "a"})'
	release 1.5.1
	run prepare
	eq "$(state)" candidate "a development alias lands: $(field reasons)"
}

# --- finding 5: paths, check configuration, the tarball, the fork's tests ----------------------------------------
t_f5_paths() {
	refused nested-npmrc 'path: the original changes `extensions/.npmrc`' change extensions/.npmrc "registry=https://evil.invalid/" "x"
	refused nested-npmignore 'path: the original changes `extensions/.npmignore`' change extensions/.npmignore "# ignores nothing: the path alone refuses" "x"
	refused gitattributes 'path: the original changes `test/.gitattributes`' change test/.gitattributes "*.ts export-ignore" "x"
	refused tsconfig 'path: the original changes `tsconfig.json`' change tsconfig.json '{"exclude": ["test"]}' "x"
	refused newfile 'path: the original changes `extensions/new.ts`, which is not in .github/follow/paths.txt' change extensions/new.ts "export {};" "x"
	# A test the fork changed, changed by the original elsewhere: merges cleanly, refused.
	fresh f5-forktest
	change test/lib.test.ts "$(printf 'test 1\nline 2\nline 3\nline 4\nline 5 (original)')" "test: line 5"
	release 1.5.1
	run prepare
	eq "$(state)" refused "a test the fork changed: refused"
	has "$(field reasons)" "the fork's test \`test/lib.test.ts\`" "says which"
}

t_f5_pack() {
	fresh f5-pack
	cd "$F"
	npm_set pi-provimux 105.0.0 "105.0.0 900"
	npm_done
	run plan
	eq "$RUN_RC" 0 "the fork packs: $RUN_OUT"
	change extensions/.npmignore "index.ts" "chore: ignore index"
	run plan
	eq "$RUN_RC" 4 "the registered extension left out of the tarball: refused"
	has "$RUN_OUT" 'extensions/index.ts' "says which"
	# A comment that names a retired import is no refusal: what loads is judged by loading it (t_f5_load).
	fresh f5-comment
	cd "$F"
	npm_set pi-provimux 105.0.0 "105.0.0 900"
	npm_done
	printf '// was: import "./retired.ts"\nexport default function () {}\n' >>extensions/index.ts
	git add -A && commit "docs: a comment"
	run plan
	eq "$RUN_RC" 0 "a comment naming a file that is gone: no refusal: $RUN_OUT"
}

# pi_stub DIR: a stub of @earendil-works/pi-coding-agent in DIR whose discoverAndLoadExtensions imports each
# extension the package registers and calls it, as pi's loader does.
pi_stub() {
	local pi=$1
	mkdir -p "$pi"
	printf '{"name": "@earendil-works/pi-coding-agent", "version": "0.0.0", "type": "module", "exports": {".": "./index.js"}}\n' >"$pi/package.json"
	cat >"$pi/index.js" <<-'JS'
		import { readFileSync } from "node:fs";
		import { join, resolve } from "node:path";
		import { pathToFileURL } from "node:url";
		export async function discoverAndLoadExtensions(paths) {
			const extensions = [];
			const errors = [];
			for (const dir of paths) {
				const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
				for (const e of pkg.pi.extensions) {
					const p = resolve(dir, e);
					try {
						const m = await import(pathToFileURL(p).href);
						await m.default({});
						extensions.push({ path: p });
					} catch (err) {
						errors.push({ path: p, error: `Failed to load extension: ${err.message}` });
					}
				}
			}
			return { extensions, errors, warnings: [] };
		}
	JS
}

# The delivered package, loaded: load.mjs unpacks npm's tarball into a consumer of its own and has pi's loader (here
# a stub of discoverAndLoadExtensions that imports each registered extension and calls it) load it. A file the
# extension imports by a template literal and the tarball lacks fails; the same package with it loads.
t_f5_load() {
	CASE=f5-load
	local d=$T/f5-load pi
	rm -rf "$d"
	pi=$d/nm/@earendil-works/pi-coding-agent
	mkdir -p "$d/pkg/extensions" "$pi" "$d/out"
	pi_stub "$pi"
	printf 'const name = "lib";\nconst lib = await import(`./${name}.js`);\nexport default function () {\n\treturn lib.value;\n}\n' >"$d/pkg/extensions/index.js"
	printf 'export const value = 1;\n' >"$d/pkg/extensions/lib.js"
	pk() { # pk FILES_JSON: the package with that files list, packed by npm into $d/out
		rm -f "$d"/out/*.tgz
		jq -n --argjson f "$1" '{name: "pkg-under-test", version: "1.0.0", type: "module", files: $f,
			pi: {extensions: ["./extensions/index.js"]}, peerDependencies: {"@earendil-works/pi-coding-agent": "*"}}' >"$d/pkg/package.json"
		(cd "$d/pkg" && npm pack --ignore-scripts --pack-destination "$d/out" >/dev/null 2>&1)
	}
	pk '["extensions"]'
	runc node "$SCRIPTS/load.mjs" "$d/out/pkg-under-test-1.0.0.tgz" "$d/nm"
	eq "$RUN_RC" 0 "the package with its files loads: $RUN_OUT"
	pk '["extensions/index.js"]'
	if tar tzf "$d/out/pkg-under-test-1.0.0.tgz" | grep -q lib.js; then bad "the fixture packs lib.js"; else ok; fi
	runc node "$SCRIPTS/load.mjs" "$d/out/pkg-under-test-1.0.0.tgz" "$d/nm"
	eq "$RUN_RC" 4 "a file the tarball lacks, imported by a template literal: refused"
	has "$RUN_OUT" "pi could not load it" "says why"
	# Only the peers reach the consumer: an import of something else in node_modules fails.
	mkdir -p "$d/nm/devonly"
	printf '{"name": "devonly", "version": "1.0.0", "type": "module", "exports": "./i.js"}\n' >"$d/nm/devonly/package.json"
	printf 'export const v = 1;\n' >"$d/nm/devonly/i.js"
	printf 'import { v } from "devonly";\nexport default function () {\n\treturn v;\n}\n' >"$d/pkg/extensions/index.js"
	pk '["extensions"]'
	runc node "$SCRIPTS/load.mjs" "$d/out/pkg-under-test-1.0.0.tgz" "$d/nm"
	eq "$RUN_RC" 4 "a development dependency is not there for the delivered package"
}

# The test jobs' container steps, run in the workflow's own order (the third review's generated-asset case). Each
# docker run of the job is replayed on the host with its mounts mapped to local folders (/w the exported tree, /pack
# the archive folder, /follow this run's scripts, /tmp/pack a scratch folder); npm ci is a fake that installs pi (a
# stub) and, as a development install can, writes extensions/generated-settings.json, which the extension needs and
# git does not have. The package npm publishes from the commit lacks that file, so the job must fail at the load;
# with the file in the commit, the job passes.
job_containers() { # job_containers FILE JOB: each docker run's command after the image, one per line, in order
	job "$1" "$2" | awk '
		/^      - / { if (cmd != "") print cmd; cmd = ""; inrun = 0 }
		/^        run: >-$/ { inrun = 1; next }
		inrun && /^          / { sub(/^ +/, ""); cmd = cmd (cmd == "" ? "" : " ") $0; next }
		{ inrun = 0 }
		END { if (cmd != "") print cmd }' | grep -F 'docker run' | sed 's/.*"\$NODE_IMAGE" //'
}
t_f5_order() {
	CASE=f5-order
	local d=$T/f5-order j cmd n rc
	local f=$TREE/.github/workflows/follow.yml p=$TREE/.github/workflows/publish.yml
	for j in "$f test-candidate" "$p test"; do
		for committed in no yes; do
			rm -rf "$d"
			mkdir -p "$d/tree/extensions" "$d/pack" "$d/bin" "$d/pi"
			# The package: its extension reads a JSON file next to it.
			jq -n '{name: "pkg-under-test", version: "1.0.0", type: "module", files: ["extensions"],
				pi: {extensions: ["./extensions/index.js"]}, peerDependencies: {"@earendil-works/pi-coding-agent": "*"}}' >"$d/tree/package.json"
			printf 'import { readFileSync } from "node:fs";\nconst s = JSON.parse(readFileSync(new URL("./generated-settings.json", import.meta.url), "utf8"));\nexport default function () {\n\treturn s;\n}\n' >"$d/tree/extensions/index.js"
			if [[ $committed == yes ]]; then printf '{"generated": false}\n' >"$d/tree/extensions/generated-settings.json"; fi
			# pi's loader, a stub (as in t_f5_load), and the fake npm ci that installs it and generates the asset.
			pi_stub "$d/pi/@earendil-works/pi-coding-agent"
			cat >"$d/bin/npm" <<-SH
				#!/usr/bin/env bash
				case "\$1" in
				ci) mkdir -p node_modules && cp -R "$d/pi/@earendil-works" node_modules/ && printf '{"generated": true}\n' >extensions/generated-settings.json ;;
				run | install | ls) exit 0 ;;
				*) exec "$(command -v npm)" "\$@" ;;
				esac
			SH
			chmod +x "$d/bin/npm"
			n=0 rc=0
			# shellcheck disable=SC2086 # file and job
			while IFS= read -r cmd; do
				n=$((n + 1))
				cmd=$(sed -e 's|/tmp/pack|@TP@|g' -e 's|/pack|@PK@|g' -e 's|/follow|@FO@|g' -e 's|/w/|@W@/|g' <<<"$cmd")
				cmd=${cmd//@TP@/$d/tmppack}
				cmd=${cmd//@PK@/$d/pack}
				cmd=${cmd//@FO@/$SCRIPTS}
				cmd=${cmd//@W@/$d/tree}
				RUN_OUT=$(cd "$d/tree" && PATH="$d/bin:$PATH" bash -c "$cmd" 2>&1) || rc=$?
				((rc == 0)) || break
			done < <(job_containers $j)
			if [[ $committed == yes ]]; then
				eq "$rc" 0 "$j: the asset in the commit: the job passes: $RUN_OUT"
			else
				yes_ test "$rc" -ne 0
				has "$RUN_OUT" "pi could not load it" "$j: an asset only an install generates: the load fails (step $n)"
			fi
		done
	done
}

# --- finding 6: refs and inputs (the workflows: t_workflows) ----------------------------------------------------
t_f6_refs() {
	fresh f6-refs
	cd "$F"
	GITHUB_REF=refs/heads/Main run plan
	eq "$RUN_RC" 1 "plan from refs/heads/Main: refused"
	GITHUB_REF=refs/heads/Main run land up-to-date "$(git rev-parse HEAD)"
	eq "$RUN_RC" 1 "land from refs/heads/Main: refused"
	GITHUB_REF=refs/tags/v1 run tag 105.0.1 "$(git rev-parse HEAD)" false
	eq "$RUN_RC" 1 "tag from a tag ref: refused"
}

# --- finding 8: recovery by hand, the plan's npm -----------------------------------------------------------------
t_f8_recovery() {
	# Merging with the scripts inside the tree being merged: refused.
	fresh f8-inside
	release 1.5.1
	mkdir -p .github
	cp -R "$SCRIPTS" .github/follow
	RUN_RC=0
	RUN_OUT=$(bash .github/follow/follow.sh merge 2>&1) || RUN_RC=$?
	eq "$RUN_RC" 1 "merge from inside the tree: refused"
	# Under an npm older than 11.5.1 the npm gate refuses first.
	if npm_older "$(npm --version 2>/dev/null | head -n 1)"; then has "$RUN_OUT" "is older than 11.5.1" "says why (the npm gate)"; else has "$RUN_OUT" "outside the tree" "says why"; fi
	rm -rf .github
	# A conflict that also carries a refused change: the merge by hand ends in the guard's refusal.
	fresh f8-conflict-refused
	change extensions/index.ts "$(printf 'line 1\nline 2 (original 1.5.1)\nline 3')" "fix: line 2 again"
	change LICENSE "changed" "chore: licence"
	release 1.5.1
	change extensions/index.ts "$(printf 'line 1\nline 2 (the fork)\nline 3')" "feat: the fork's line 2"
	run merge 1.5.1
	if [[ $RUN_RC == 4 ]]; then ok; else
		printf 'line 1\nline 2 (both)\nline 3\n' >extensions/index.ts
		git add extensions/index.ts
		run stamp
		eq "$RUN_RC" 4 "stamp after a hand merge runs the guard and refuses"
	fi
	# The effective change is checked: a resolution that adds a key the owner decides is refused, though neither
	# side of the merge had it.
	fresh f8-effective
	change extensions/index.ts "$(printf 'line 1\nline 2 (original 1.5.1)\nline 3')" "fix: line 2 again"
	release 1.5.1
	change extensions/index.ts "$(printf 'line 1\nline 2 (the fork)\nline 3')" "feat: the fork's line 2"
	run merge 1.5.1
	eq "$RUN_RC" 3 "a conflict"
	printf 'line 1\nline 2 (both)\nline 3\n' >extensions/index.ts
	jq --tab '.funding = "https://x.invalid"' package.json >p && mv p package.json
	git add extensions/index.ts package.json
	run stamp
	eq "$RUN_RC" 4 "a key added while resolving: refused"
	has "$RUN_OUT" 'the merge adds `funding`' "says which"
	# The issues carry no recovery commands: no container over the operator's checkout, no push from it.
	hasnt "$(sed -n '/^by_hand() {/,/^}/p' "$FOLLOW")" 'docker run' "no container command in the issues"
	hasnt "$(sed -n '/^by_hand() {/,/^}/p' "$FOLLOW")" 'git push' "no push command in the issues"
	if [[ -f $TREE/docs/FOLLOWING.md ]]; then
		hasnt "$(cat "$TREE/docs/FOLLOWING.md")" 'HEAD:main' "FOLLOWING.md: no push of HEAD"
		hasnt "$(cat "$TREE/docs/FOLLOWING.md")" '-v "$PWD' "FOLLOWING.md: no container over the checkout"
		has "$(cat "$TREE/docs/FOLLOWING.md")" "by the owner's staff, on request" "FOLLOWING.md: recovery is by hand"
	else
		bad "no docs/FOLLOWING.md at $TREE"
	fi
	# The plan reads no npm configuration of the tree: an .npmrc is refused before npm runs.
	fresh f8-plan
	cd "$F"
	fake_npm
	change .npmrc "registry=https://evil.invalid/" "chore: npmrc"
	FOLLOW_NPM_DIR='' PATH="$T/fakenpm:$PATH" run plan
	eq "$RUN_RC" 4 "an .npmrc: refused"
	# Only the version check (npm 11.5.1 or later), from the neutral folder; npm never ran on the tree.
	eq "$(cut -d' ' -f2- "$T/fakenpm/log" | grep -vx -- '--version' || true)" "" "npm never ran but --version"
	# Physical paths on both sides (pwd -P): a TMPDIR with a symbolic link or a trailing slash cannot hide a match.
	local fp
	fp=$(cd "$F" && pwd -P)
	hasnt "$(cut -d' ' -f1 "$T/fakenpm/log")" "$fp" "the version check not from the tree"
	# Without one, npm runs from a neutral folder against the public registry.
	git rm -q .npmrc && commit "chore: no npmrc"
	FOLLOW_NPM_DIR='' PATH="$T/fakenpm:$PATH" run plan
	has "$(cat "$T/fakenpm/log")" "--registry=https://registry.npmjs.org/" "the public registry"
	hasnt "$(cut -d' ' -f1 "$T/fakenpm/log")" "$fp" "not from the tree"
	# publishConfig may only say access public.
	jq --tab '.publishConfig.tag = "next"' package.json >p && mv p package.json
	git add -A && commit "chore: next"
	npm_set pi-provimux 105.0.0 "105.0.0 900"
	npm_done
	run plan
	has "$RUN_OUT" "publishConfig" "a publish tag: refused"
}

# A fake npm on PATH: logs "cwd args" and answers view with {} (no such package).
fake_npm() {
	mkdir -p "$T/fakenpm"
	: >"$T/fakenpm/log"
	cat >"$T/fakenpm/npm" <<-SH
		#!/usr/bin/env bash
		echo "\$(pwd -P) \$*" >>"$T/fakenpm/log"
		case "\$1" in
		view) echo '{"error":{"code":"E404"}}'; exit 1 ;;
		*) exec "$(command -v npm)" "\$@" ;;
		esac
	SH
	chmod +x "$T/fakenpm/npm"
}

# --- findings 9 and 10: issues, tags, landing --------------------------------------------------------------------
# A stub gh: records every call in $GH_LOG; issues, labels, tags and releases live in $T/gh.
gh_stub() {
	mkdir -p "$T/gh/bin"
	cat >"$T/gh/bin/gh" <<-'SH'
		#!/usr/bin/env bash
		echo "$*" >>"$GH_LOG"
		G=$GH_DIR
		arg() { local k=$1; shift; while [ $# -gt 0 ]; do [ "$1" = "$k" ] && { echo "$2"; return; }; shift; done; }
		field() { local k=$1; shift; while [ $# -gt 0 ]; do case $1 in "$k="*) echo "${1#*=}"; return ;; esac; shift; done; }
		case "$1 $2" in
		"api --paginate")
			# Every issue, whatever the label asked for: the script must check the label itself.
			jq -c '. as $a | range(0; ($a | length); 100) as $i | $a[$i:$i + 100]' "$G/issues.json" ;;
		"api -X")
			case "$4" in
			*/labels) touch "$G/label" ;;
			*/git/refs) jq --arg t "$(field ref "$@" | sed 's#refs/tags/##')" --arg s "$(field sha "$@")" '.[$t] = {type: "commit", sha: $s}' "$G/tags.json" >"$G/t.t" && mv "$G/t.t" "$G/tags.json" ;;
			esac ;;
		"api "*)
			case "$2" in
			*/labels/*) [ -e "$G/label" ] ;;
			*/actions/artifacts/*/zip) cat "$G/artifact.zip" ;;
			*/actions/artifacts/*) cat "$G/artifact.json" ;;
			*/git/ref/tags/*) jq -e --arg t "${2##*/}" '.[$t] | select(. != null) | {object: .}' "$G/tags.json" ;;
			*/git/tags/*) jq -e --arg s "${2##*/}" '.[$s] | select(. != null) | {object: .}' "$G/tagobjs.json" ;;
			*) exit 1 ;;
			esac ;;
		"issue create")
			t=$(arg --title "$@"); b=$(cat "$(arg --body-file "$@")"); l=$(arg --label "$@")
			case "$t" in *"${GH_FAIL_CREATE:-@@none@@}"*) exit 1 ;; esac
			jq --arg t "$t" --arg b "$b" --arg l "$l" '. + [{number: ((map(.number) | max // 0) + 1), title: $t, body: $b, state: "open",
				user: {login: "github-actions[bot]"}, labels: [{name: $l}]}]' "$G/issues.json" >"$G/i.t" && mv "$G/i.t" "$G/issues.json" ;;
		"issue edit")
			n=$3; t=$(arg --title "$@"); b=$(cat "$(arg --body-file "$@")")
			jq --argjson n "$n" --arg t "$t" --arg b "$b" 'map(if .number == $n then .title = $t | .body = $b else . end)' "$G/issues.json" >"$G/i.t" && mv "$G/i.t" "$G/issues.json" ;;
		"issue close") jq --argjson n "$3" 'map(if .number == $n then .state = "closed" else . end)' "$G/issues.json" >"$G/i.t" && mv "$G/i.t" "$G/issues.json" ;;
		"issue reopen") jq --argjson n "$3" 'map(if .number == $n then .state = "open" else . end)' "$G/issues.json" >"$G/i.t" && mv "$G/i.t" "$G/issues.json" ;;
		"issue comment") ;;
		"issue list")
			st=$(arg --state "$@"); lim=$(arg --limit "$@")
			jq --arg s "${st:-open}" --argjson n "${lim:-30}" '[.[] | select($s == "all" or .state == $s) | {number, title, body, state: (.state | ascii_upcase)}] | .[:$n]' "$G/issues.json" ;;
		"workflow run") [ -z "${GH_FAIL_DISPATCH:-}" ] ;;
		"release view") grep -Fxq "$3" "$G/releases" ;;
		"release create") echo "$3" >>"$G/releases" ;;
		*) exit 1 ;;
		esac
	SH
	chmod +x "$T/gh/bin/gh"
	export GH_DIR=$T/gh GH_LOG=$T/gh/log GH_ISSUES=$T/gh/issues.json
	echo '[]' >"$T/gh/issues.json"
	echo '{}' >"$T/gh/tags.json"
	echo '{}' >"$T/gh/tagobjs.json"
	: >"$T/gh/releases"
	: >"$T/gh/log"
	rm -f "$T/gh/label"
}
gh_run() { PATH="$T/gh/bin:$PATH" run "$@"; }
bot() { jq -r --arg p "$1" '[.[] | select(.user.login == "github-actions[bot]" and (.title | startswith($p)))]' "$GH_ISSUES"; }

t_report() {
	fresh report
	gh_stub
	change extensions/index.ts "$(printf 'line 1\nline 2 (original 1.5.1)\nline 3')" "fix: line 2 again"
	change README.md "readme of 1.5.1" "docs: readme"
	release 1.5.1
	change extensions/index.ts "$(printf 'line 1\nline 2 (the fork)\nline 3')" "feat: the fork's line 2"
	run prepare
	past_gate || return 0
	rm "$OUT/readme.diff" # the report job has only the result
	gh_run report
	eq "$RUN_RC" 1 "a conflict is red"
	eq "$(bot "follow:" | jq -r '.[].title')" "follow: 1.5.1 — conflict" "the follow issue"
	eq "$(bot "README:" | jq -r 'length')" 1 "the README issue"
	has "$(bot "README:" | jq -r '.[0].body')" "+readme of 1.5.1" "the README diff, from the result"
	has "$(bot "follow:" | jq -r '.[0].body')" "by the owner's staff, on the owner's request" "recovery is by hand, on request"
	hasnt "$(bot "follow:" | jq -r '.[0].body')" "docker run" "no container command"
	hasnt "$(bot "follow:" | jq -r '.[0].body')" "git push" "no push command"
	eq "$(bot "follow:" | jq -r '.[0].body' | head -n 1)" "<!-- follow-bot:key=follow:1.5.1 -->" "the key is the body's first line"
	: >"$GH_LOG"
	gh_run report
	eq "$(grep -c '^issue create' "$GH_LOG" || true)" 0 "a rerun opens nothing"
	eq "$(grep -c '^issue comment' "$GH_LOG" || true)" 0 "the same state: no comment"
	jq '.state = "refused" | .reasons = ["path: the original changes `LICENSE`"]' "$OUT/result.json" >"$OUT/r" && mv "$OUT/r" "$OUT/result.json"
	gh_run report
	eq "$(bot "follow:" | jq -r 'length')" 1 "still one issue"
	eq "$(bot "follow:" | jq -r '.[0].title')" "follow: 1.5.1 — refused" "new title"
	eq "$(grep -c '^issue comment' "$GH_LOG" || true)" 1 "one comment for the change"
	printf 'npm run check\n' >"$T/steps"
	printf 'FAIL test/x.test.ts ~~~~\n' >"$T/log"
	jq '.state = "candidate" | .candidate = "abc"' "$OUT/result.json" >"$OUT/r" && mv "$OUT/r" "$OUT/result.json"
	FOLLOW_TEST_CANDIDATE=failure FOLLOW_TEST_ORIGINAL=success FOLLOW_FAILED_STEPS=$T/steps FOLLOW_FAILED_LOG=$T/log gh_run report
	eq "$RUN_RC" 1 "check failed is red"
	has "$(bot "follow:" | jq -r '.[0].body')" "~~~~~" "the log in a longer fence"
	eq "$(bot "follow:" | jq -r '.[0].title')" "follow: 1.5.1 — check failed" "title"
	FOLLOW_TEST_CANDIDATE=success FOLLOW_LAND=dry-run gh_run report
	eq "$RUN_RC" 0 "a dry-run pass is green"
	FOLLOW_TEST_CANDIDATE=success FOLLOW_LAND=failure gh_run report
	eq "$(bot "follow:" | jq -r '.[0].title')" "follow: 1.5.1 — land failed" "land failed"
	FOLLOW_TEST_CANDIDATE=success FOLLOW_LAND=dispatch-failed gh_run report
	eq "$RUN_RC" 1 "landed without a publish is red"
	eq "$(bot "follow:" | jq -r '.[0].title')" "follow: 1.5.1 — landed, publish not started" "says publish did not start"
	FOLLOW_TEST_CANDIDATE=success FOLLOW_LAND=landed gh_run report
	eq "$(bot "follow:" | jq -r '.[0].title')" "follow: 1.5.1 — landed" "landed"
	jq '.state = "up-to-date" | .base_version = "1.5.1" | .fork_published = "true" | .fork_version = "105.1.1"' "$OUT/result.json" >"$OUT/r" &&
		mv "$OUT/r" "$OUT/result.json"
	DRY_RUN=yes gh_run report
	eq "$RUN_RC" 0 "up to date is green"
	eq "$(bot "follow:" | jq -r '.[0].state')" open "a dry run closes nothing (the third review's case)"
	has "$RUN_OUT" "dry run: no issue is closed" "says so"
	gh_run report
	eq "$(bot "follow:" | jq -r '.[0].state')" open "DRY_RUN unset is a dry run: closes nothing"
	DRY_RUN=no gh_run report
	eq "$RUN_RC" 0 "up to date is green"
	eq "$(bot "follow:" | jq -r '.[0].state')" closed "a live run closes it"
	eq "$(bot "README:" | jq -r '.[0].state')" open "the README issue stays for the owner"
}

t_f9_issues() {
	fresh f9-issues
	gh_stub
	change extensions/index.ts "$(printf 'line 1\nline 2 (original 1.5.1)\nline 3')" "fix: line 2 again"
	change README.md "readme of 1.5.1" "docs: readme"
	release 1.5.1
	change extensions/index.ts "$(printf 'line 1\nline 2 (the fork)\nline 3')" "feat: the fork's line 2"
	run prepare
	# A contributor's issue with the bot's title, label and key first; 350 others; the bot's own issue of 1.5.1,
	# closed, last.
	jq -n --arg m "<!-- follow-bot:key=follow:1.5.1 -->" '[{number: 1, title: "follow: 1.5.1 — conflict", body: "mine \($m)", state: "open",
		user: {login: "someone"}, labels: [{name: "follow-bot"}]}]
		+ [range(2; 352) | {number: ., title: "other \(.)", body: "", state: "open", user: {login: "someone"}, labels: [{name: "follow-bot"}]}]
		+ [{number: 352, title: "follow: 1.5.1 — refused", body: "\($m)\n<!-- follow-state: refused -->\n\nold", state: "closed", user: {login: "github-actions[bot]"}, labels: [{name: "follow-bot"}]}]' \
		>"$GH_ISSUES"
	GH_FAIL_CREATE="README:" gh_run report
	eq "$RUN_RC" 1 "red, and the README write failed"
	eq "$(jq -r '.[] | select(.number == 1) | .body' "$GH_ISSUES")" "mine <!-- follow-bot:key=follow:1.5.1 -->" "the contributor's issue untouched"
	eq "$(jq -r '.[] | select(.number == 352) | .state + " " + .title' "$GH_ISSUES")" "open follow: 1.5.1 — conflict" "the bot's closed issue reopened, past 300"
	eq "$(jq -r '[.[] | select(.title | startswith("follow:"))] | length' "$GH_ISSUES")" 2 "no duplicate"
	has "$(grep -n '' "$GH_LOG" | grep -E 'issue (edit|reopen|create)' | head -n 1)" "issue reopen 352" "the principal report is written first"
	# A huge list of conflicts stays within GitHub's body limit.
	jq '.conflicts = [range(0; 5000) | "extensions/\(.)-" + ("x" * 200) + ".ts"]' "$OUT/result.json" >"$OUT/r" && mv "$OUT/r" "$OUT/result.json"
	gh_run report
	eq "$(jq -r '[.[] | select(.body | length >= 65000)] | length' "$GH_ISSUES")" 0 "every body under GitHub's limit"
	# The key counts only as the first line of a bot issue with the label: an open README issue quoting the failure
	# key in its diff, and a bot issue without the label, are left alone; the closed failure issue is reopened.
	fresh f9-quoted
	gh_stub
	change extensions/index.ts "$(printf 'line 1\nline 2 (original 1.5.1)\nline 3')" "fix: line 2 again"
	change README.md "readme of 1.5.1" "docs: readme"
	release 1.5.1
	change extensions/index.ts "$(printf 'line 1\nline 2 (the fork)\nline 3')" "feat: the fork's line 2"
	run prepare
	jq -n --arg k "<!-- follow-bot:key=follow:1.5.1 -->" --arg r "<!-- follow-bot:key=readme:1.5.1 -->" '[
		{number: 1, title: "README: after 1.5.1", body: "\($r)\n<!-- follow-state: open -->\n\n~~~diff\n+ quoting \($k)\n~~~", state: "open",
			user: {login: "github-actions[bot]"}, labels: [{name: "follow-bot"}]},
		{number: 2, title: "follow: 1.5.1 — refused", body: "\($k)\n<!-- follow-state: refused -->\n\nold", state: "closed",
			user: {login: "github-actions[bot]"}, labels: [{name: "follow-bot"}]},
		{number: 3, title: "follow: 1.5.1 — other", body: "\($k)\n<!-- follow-state: other -->", state: "open",
			user: {login: "github-actions[bot]"}, labels: []}]' >"$GH_ISSUES"
	local before1 before3
	before1=$(jq -c '.[0]' "$GH_ISSUES")
	before3=$(jq -c '.[2]' "$GH_ISSUES")
	gh_run report
	eq "$(jq -c '.[0]' "$GH_ISSUES")" "$before1" "the README issue quoting the key is untouched"
	eq "$(jq -c '.[2]' "$GH_ISSUES")" "$before3" "a bot issue without the label is untouched"
	eq "$(jq -r '.[1].state + " " + .[1].title' "$GH_ISSUES")" "open follow: 1.5.1 — conflict" "the keyed failure issue reopened and updated"
	eq "$(jq -r 'length' "$GH_ISSUES")" 3 "nothing new"
}

t_f10_publish() {
	fresh f10-publish
	gh_stub
	cd "$F"
	local main
	main=$(git rev-parse HEAD)
	jq -n --arg m "<!-- follow-bot:key=publish:105.0.1 -->" '[{number: 1, title: "publish: 105.0.1 — failed", body: $m, state: "open",
		user: {login: "github-actions[bot]"}, labels: [{name: "follow-bot"}]}]' >"$GH_ISSUES"
	jq --arg m "<!-- follow-bot:key=publish:105.0.1 -->" '.[0].body = "\($m)\n<!-- follow-state: failed -->"' "$GH_ISSUES" >"$T/i" && mv "$T/i" "$GH_ISSUES"
	DRY_RUN=yes gh_run report-publish 105.0.1 success
	eq "$(jq -r '.[0].state' "$GH_ISSUES")" open "a dry run closes nothing"
	FOLLOW_NPM_SHOW_WAIT=2 FOLLOW_NPM_SHOW_POLL=1 DRY_RUN=no gh_run report-publish 105.0.1 success
	eq "$(jq -r '.[0].state' "$GH_ISSUES")" open "success without the version on npm closes nothing"
	npm_set pi-provimux 105.0.1 "105.0.1 1"
	npm_done
	DRY_RUN=no gh_run report-publish 105.0.1 success
	eq "$(jq -r '.[0].state' "$GH_ISSUES")" closed "closed once npm shows it"
	# npm shows a version a while after its upload. One that appears within the wait opens no issue; one that never
	# appears opens "publish: <v> — failed" once the wait is over, not before.
	local stub_meta=$FOLLOW_NPM_DIR/pi-provimux.json t0 waited
	echo '[]' >"$GH_ISSUES"
	rm -f "$stub_meta"
	npm_set pi-provimux 105.0.2 "105.0.1 2" "105.0.2 0"
	mkdir -p "$T/f10-later"
	mv "$T/npm/pi-provimux.json" "$T/f10-later/pi-provimux.json"
	(sleep 3 && mv "$T/f10-later/pi-provimux.json" "$stub_meta") &
	local later=$!
	t0=$SECONDS
	FOLLOW_NPM_SHOW_WAIT=30 FOLLOW_NPM_SHOW_POLL=1 DRY_RUN=no gh_run report-publish 105.0.2 success
	waited=$((SECONDS - t0))
	wait "$later" || true
	eq "$RUN_RC" 0 "a version npm shows after a delay: a success: $RUN_OUT"
	eq "$(jq -r 'length' "$GH_ISSUES")" 0 "a version npm shows after a delay: no issue"
	has "$RUN_OUT" "npm does not show pi-provimux 105.0.2 yet" "it waited for npm"
	has "$RUN_OUT" "npm shows pi-provimux 105.0.2 (after " "it saw the version come"
	CHECK="waited for the delayed version (${waited}s)" yes_ test "$waited" -ge 2
	rm -f "$stub_meta"
	npm_set pi-provimux 105.0.1 "105.0.1 2"
	npm_done
	t0=$SECONDS
	FOLLOW_NPM_SHOW_WAIT=3 FOLLOW_NPM_SHOW_POLL=1 DRY_RUN=no gh_run report-publish 105.0.2 success
	waited=$((SECONDS - t0))
	eq "$RUN_RC" 1 "a version npm never shows: red"
	eq "$(jq -r '[.[] | select(.state == "open")] | .[0].title' "$GH_ISSUES")" "publish: 105.0.2 — failed" "a version npm never shows: the issue"
	has "$(jq -r '.[0].body' "$GH_ISSUES")" "npm does not show 105.0.2 after 3 s" "the issue says npm was waited for"
	CHECK="the full wait before the issue (${waited}s)" yes_ test "$waited" -ge 2
	# A dry run neither waits nor closes.
	t0=$SECONDS
	FOLLOW_NPM_SHOW_WAIT=30 FOLLOW_NPM_SHOW_POLL=1 DRY_RUN=yes gh_run report-publish 105.0.2 success
	eq "$(jq -r '.[0].state' "$GH_ISSUES")" open "a dry run still closes nothing"
	CHECK="a dry run does not wait" yes_ test $((SECONDS - t0)) -lt 10
	# The wait is checked as a number.
	FOLLOW_NPM_SHOW_WAIT=soon DRY_RUN=no gh_run report-publish 105.0.2 success
	has "$RUN_OUT" "FOLLOW_NPM_SHOW_WAIT is not a number of seconds" "a wait that is not a number"
	# The tag: an annotated tag at the right commit is the right tag; a missing release is made.
	git init -q --bare "$T/f10-publish/up.git"
	git push -q "$T/f10-publish/up.git" "$main:refs/heads/main"
	export FOLLOW_UPSTREAM_URL=$T/f10-publish/up.git
	jq -n --arg s "$main" '{"v105.0.1": {type: "tag", sha: "1111111111111111111111111111111111111111"}}' >"$GH_DIR/tags.json"
	jq -n --arg s "$main" '{"1111111111111111111111111111111111111111": {type: "commit", sha: $s}}' >"$GH_DIR/tagobjs.json"
	DRY_RUN=no gh_run tag 105.0.1 "$main" false
	eq "$RUN_RC" 0 "an annotated tag at the commit: $RUN_OUT"
	eq "$(cat "$GH_DIR/releases")" "v105.0.1" "the missing release is made"
	# npm has it, but no commit of main is known and there is no tag: red, not silent.
	echo '{}' >"$GH_DIR/tags.json"
	: >"$GH_DIR/releases"
	DRY_RUN=no gh_run tag 105.0.1 "$main" true
	eq "$RUN_RC" 1 "no gitHead and no tag: the job fails"
	has "$RUN_OUT" "make the tag by hand" "says what to do"
	# A long changelog does not break the release notes.
	for i in $(seq 1 3000); do echo "- line $i"; done >>CHANGELOG.md
	git add -A && commit "docs: long"
	main=$(git rev-parse HEAD)
	git push -q "$FOLLOW_UPSTREAM_URL" "$main:refs/heads/main"
	DRY_RUN=no gh_run tag 105.0.1 "$main" false
	eq "$RUN_RC" 0 "a long changelog: $RUN_OUT"
	# Not in the live main: refused.
	git commit -q --allow-empty -m "local only"
	DRY_RUN=no gh_run tag 105.0.2 "$(git rev-parse HEAD)" false
	eq "$RUN_RC" 1 "a commit outside the live main is not tagged"
	# Repair (npm has the version, no gitHead): an existing tag at an earlier commit of main whose package.json
	# names another version is not taken; the same tag at a commit that names it is.
	local early
	early=$(git rev-parse "$main~2")
	jq -n --arg s "$early" '{"v105.0.1": {type: "commit", sha: $s}}' >"$GH_DIR/tags.json"
	: >"$GH_DIR/releases"
	DRY_RUN=no gh_run tag 105.0.1 "$main" true
	eq "$RUN_RC" 1 "a tag at a commit that names $(git show "$early:package.json" | jq -r .version): no release made"
	eq "$(cat "$GH_DIR/releases")" "" "no release for the wrong tree"
	jq -n --arg s "$main" '{"v105.0.1": {type: "commit", sha: $s}}' >"$GH_DIR/tags.json"
	DRY_RUN=no gh_run tag 105.0.1 "$main" true
	eq "$RUN_RC" 0 "the tag at a commit that names 105.0.1: repaired: $RUN_OUT"
	# npm's gitHead at a commit of main that names another version is not taken either.
	echo '{}' >"$GH_DIR/tags.json"
	printf '%s' "$early" >"$FOLLOW_NPM_DIR/pi-provimux@105.0.1.githead"
	DRY_RUN=no gh_run tag 105.0.1 "$main" true
	eq "$RUN_RC" 1 "a gitHead that names another version: not tagged"
	rm -f "$FOLLOW_NPM_DIR/pi-provimux@105.0.1.githead"
	# npm itself, for a version published from a tarball file, which records no gitHead: npm view … gitHead version
	# --json then prints the bare string "105.0.1", not an object. The existing tag is taken, as for a missing gitHead.
	local fake=$T/f10-publish/npm-view
	mkdir -p "$fake/bin"
	cat >"$fake/bin/npm" <<-'SH'
		#!/bin/sh
		[ "$1" = --version ] && { echo 11.20.0; exit 0; }
		[ "$1" = view ] || exit 1
		case " $* " in
		*" pi-provimux@105.0.1 gitHead "*) echo '"105.0.1"' ;;
		*" pi-provimux@105.0.1 "*) echo '{"name": "pi-provimux", "version": "105.0.1", "dist": {}}' ;;
		*) echo '{"error": {"code": "E404"}}'; exit 1 ;;
		esac
	SH
	chmod +x "$fake/bin/npm"
	jq -n --arg s "$main" '{"v105.0.1": {type: "commit", sha: $s}}' >"$GH_DIR/tags.json"
	: >"$GH_DIR/releases"
	PATH="$fake/bin:$PATH" FOLLOW_NPM_DIR='' DRY_RUN=no gh_run tag 105.0.1 "$main" true
	eq "$RUN_RC" 0 "npm without a gitHead (a bare string from npm view): the existing tag is taken: $RUN_OUT"
	eq "$(cat "$GH_DIR/releases")" "v105.0.1" "and the release is made"
	unset FOLLOW_UPSTREAM_URL
	# plan names the version even when it refuses before npm runs, so that notify reports it.
	fresh f10-plan-early
	cd "$F"
	change .npmrc "registry=https://evil.invalid/" "chore: npmrc"
	local outs=$T/f10-plan-early/gh-output
	: >"$outs"
	GITHUB_OUTPUT=$outs run plan
	eq "$RUN_RC" 4 "an .npmrc: refused"
	eq "$(grep -A1 '^version<<' "$outs" | sed -n 2p)" 105.0.1 "the version is still named"
	# A failed retry dispatch (main has the release, npm lacks main's version) is red, with an issue.
	fresh f10-retry
	gh_stub
	jq -n '{state: "up-to-date", version: "1.5.0", base_version: "1.5.0", fork_version: "105.0.1", fork_published: "false"}' >"$T/f10-retry/result.json"
	FOLLOW_RESULT=$T/f10-retry/result.json FOLLOW_LAND=dispatch-failed gh_run report
	eq "$RUN_RC" 1 "a failed retry dispatch is red"
	eq "$(bot "follow:" | jq -r '.[0].title')" "follow: 1.5.0 — publish not started" "and says so in an issue"
	FOLLOW_RESULT=$T/f10-retry/result.json FOLLOW_LAND=dispatched gh_run report
	eq "$RUN_RC" 0 "a started retry is green"
}

t_f10_land() {
	fresh f10-land
	gh_stub
	change extensions/lib.ts 'export const x = 11;' "fix: x is 11"
	release 1.5.1
	run prepare
	past_gate || return 0
	local r main
	r=$(field candidate)
	main=$(git rev-parse HEAD)
	git init -q --bare "$T/f10-land/origin.git"
	git push -q "$T/f10-land/origin.git" "$main:refs/heads/main"
	export FOLLOW_PUSH_REMOTE=$T/f10-land/origin.git
	local outs=$T/f10-land/gh-output
	: >"$outs"
	GITHUB_OUTPUT=$outs DRY_RUN=no GH_FAIL_DISPATCH=1 gh_run land candidate "$main" "$r"
	eq "$RUN_RC" 1 "a failed dispatch fails land"
	has "$(cat "$outs")" "dispatch-failed" "reported as such, never as landed"
	hasnt "$(grep -A1 '^landed<<' "$outs" | sed -n 2p)" "landed" "no landed before the dispatch"
	# A tampered candidate is refused by land's own check, whatever prepare said.
	git -C "$T/f10-land/origin.git" update-ref refs/heads/main "$main"
	git checkout -q --detach "$r"
	printf 'sneaky\n' >>extensions/lib.ts
	git add -A && GIT_COMMITTER_DATE="@$TICK +0000" git commit -q --amend --no-edit
	: >"$outs"
	GITHUB_OUTPUT=$outs DRY_RUN=no gh_run land candidate "$main" "$(git rev-parse HEAD)"
	eq "$RUN_RC" 1 "a tampered candidate: refused"
	has "$(cat "$outs")" "refused" "says refused"
	eq "$(git -C "$T/f10-land/origin.git" rev-parse refs/heads/main)" "$main" "nothing pushed"
	git checkout -q main
	# The owner pushes between land's read of main and its push (outside the concurrency group): git refuses the
	# push, and land says "moved", green, not a failure.
	local other
	other=$(git commit-tree -p "$main" -m "the owner's push" "$main^{tree}")
	git push -q "$T/f10-land/origin.git" "$other:refs/heads/owner"
	printf '#!/bin/sh\nprintf "%%s\\n" %s >refs/heads/main\nexit 1\n' "$other" >"$T/f10-land/origin.git/hooks/pre-receive"
	chmod +x "$T/f10-land/origin.git/hooks/pre-receive"
	: >"$outs"
	GITHUB_OUTPUT=$outs DRY_RUN=no gh_run land candidate "$main" "$r"
	eq "$RUN_RC" 0 "main moved during the push: not a failure"
	eq "$(grep -A1 '^landed<<' "$outs" | sed -n 2p)" moved "reported as moved"
	rm -f "$T/f10-land/origin.git/hooks/pre-receive"
	unset FOLLOW_PUSH_REMOTE
}

# --- finding 11: the mirror --------------------------------------------------------------------------------------
t_f11_mirror() {
	CASE=f11-mirror
	local S=$T/mirror wf=$TREE/.forgejo/workflows/follow-github.yml
	rm -rf "$S"
	mkdir -p "$S"
	awk '/run: \|/{on=1;next} on{sub(/^          /,""); print}' "$wf" >"$S/step.sh"
	sed -i.bak "s#https://github.com/ngvoicu/pi-provimux.git#$S/github#" "$S/step.sh"
	(cd "$S" && git init -q github && cd github && echo a >a && git add a && commit a && git tag v105.0.1)
	git clone -q --bare "$S/github" "$S/nas.git"
	(cd "$S/github" && echo b >>a && git commit -qam b && git tag v105.0.2)
	step() {
		rm -rf "$S/work"
		git clone -q "$S/nas.git" "$S/work"
		RUN_RC=0
		RUN_OUT=$(cd "$S/work" && RUNNER_TEMP=$S bash "$S/step.sh" 2>&1) || RUN_RC=$?
	}
	# A tag the NAS refuses: nothing at all changes, main included.
	mkdir -p "$S/nas.git/hooks"
	printf '#!/bin/sh\nwhile read o n r; do [ "$r" = refs/tags/v105.0.2 ] && exit 1; done\nexit 0\n' >"$S/nas.git/hooks/pre-receive"
	chmod +x "$S/nas.git/hooks/pre-receive"
	local before
	before=$(git -C "$S/nas.git" rev-parse refs/heads/main)
	step
	yes_ test "$RUN_RC" -ne 0
	eq "$(git -C "$S/nas.git" rev-parse refs/heads/main)" "$before" "main not moved when a tag is refused"
	rm "$S/nas.git/hooks/pre-receive"
	# A tag named like the tracking branch, at an unrelated commit, does not stand in for it.
	(cd "$S" && git init -q other && cd other && echo z >z && git add z && commit z)
	git -C "$S/other" push -q "$S/nas.git" "HEAD:refs/tags/origin/main"
	step
	eq "$RUN_RC" 0 "the mirror: $RUN_OUT"
	eq "$(git -C "$S/nas.git" rev-parse refs/heads/main)" "$(git -C "$S/github" rev-parse HEAD)" "main followed"
	eq "$(git -C "$S/nas.git" rev-parse refs/tags/v105.0.2)" "$(git -C "$S/github" rev-parse v105.0.2)" "the tag followed"
	# A reused workspace: the next run in the same folder, after the tag is gone from GitHub, sees the NAS-only tag.
	git -C "$S/nas.git" tag -d origin/main >/dev/null
	RUN_RC=0
	RUN_OUT=$(cd "$S/work" && RUNNER_TEMP=$S bash "$S/step.sh" 2>&1) || RUN_RC=$?
	eq "$RUN_RC" 0 "a second run in the same workspace: $RUN_OUT"
	git -C "$S/github" tag -d v105.0.2 >/dev/null
	RUN_RC=0
	RUN_OUT=$(cd "$S/work" && RUNNER_TEMP=$S bash "$S/step.sh" 2>&1) || RUN_RC=$?
	yes_ test "$RUN_RC" -ne 0
	has "$RUN_OUT" "v105.0.2 is on the NAS only" "a tag gone from GitHub is a divergence in a reused workspace"
	git -C "$S/github" tag v105.0.2 "$(git -C "$S/nas.git" rev-parse refs/tags/v105.0.2)"
	# GitHub's main rewritten (not a descendant of the NAS's), with a new tag: the NAS's main is kept under
	# refs/nas-backup/, then set to GitHub's, in the same atomic push; GitHub is not written.
	local old new ghrefs
	old=$(git -C "$S/nas.git" rev-parse refs/heads/main)
	(cd "$S/github" && git reset -q --hard v105.0.1 && echo c >>a && git commit -qam c && git tag v105.0.3)
	new=$(git -C "$S/github" rev-parse HEAD)
	ghrefs=$(git -C "$S/github" for-each-ref --format='%(refname) %(objectname)')
	# A backup the server refuses: nothing changes, main included.
	printf '#!/bin/sh\nwhile read o n r; do case "$r" in refs/nas-backup/*) exit 1;; esac; done\nexit 0\n' >"$S/nas.git/hooks/pre-receive"
	chmod +x "$S/nas.git/hooks/pre-receive"
	step
	yes_ test "$RUN_RC" -ne 0
	eq "$(git -C "$S/nas.git" rev-parse refs/heads/main)" "$old" "main not moved when the backup is refused"
	rm "$S/nas.git/hooks/pre-receive"
	# The NAS's main moved between the read and the push: the lease refuses, nothing changes.
	local racer
	racer=$(git -C "$S/github" commit-tree -p v105.0.1 -m racer "HEAD^{tree}")
	git -C "$S/github" push -q "$S/nas.git" "$racer:refs/heads/racer"
	awk -v n="$S/nas.git" -v r="$racer" '{ print } /^echo "GitHub main: /{ print "git -C " n " update-ref refs/heads/main " r }' "$S/step.sh" >"$S/race.sh"
	rm -rf "$S/work"
	git clone -q "$S/nas.git" "$S/work"
	RUN_RC=0
	RUN_OUT=$(cd "$S/work" && RUNNER_TEMP=$S bash "$S/race.sh" 2>&1) || RUN_RC=$?
	yes_ test "$RUN_RC" -ne 0
	eq "$(git -C "$S/nas.git" rev-parse refs/heads/main)" "$racer" "a main moved meanwhile is left as it is"
	eq "$(git -C "$S/nas.git" for-each-ref refs/nas-backup/)" "" "no backup after a refused lease"
	git -C "$S/nas.git" update-ref refs/heads/main "$old"
	git -C "$S/nas.git" update-ref -d refs/heads/racer
	# Then it follows.
	step
	eq "$RUN_RC" 0 "the rewritten main: $RUN_OUT"
	eq "$(git -C "$S/nas.git" rev-parse refs/heads/main)" "$new" "main set to GitHub's rewritten main"
	eq "$(git -C "$S/nas.git" rev-parse refs/tags/v105.0.3)" "$new" "the new tag followed"
	eq "$(git -C "$S/nas.git" for-each-ref --format='%(objectname)' refs/nas-backup/)" "$old" "the old main kept, once"
	if git -C "$S/nas.git" for-each-ref --format='%(refname)' refs/nas-backup/ | grep -Eqx 'refs/nas-backup/main-[0-9]{8}T[0-9]{6}Z'; then ok; else bad "11: the backup is refs/nas-backup/main-<UTC time>"; fi
	eq "$(git -C "$S/github" for-each-ref --format='%(refname) %(objectname)')" "$ghrefs" "GitHub not written"
	step
	eq "$RUN_RC" 0 "the next run: $RUN_OUT"
	eq "$(git -C "$S/nas.git" for-each-ref refs/nas-backup/ | wc -l | tr -d ' ')" 1 "the next run keeps no second backup"
}

# --- the workflows, read as text (what a local run cannot exercise) ------------------------------------------------
# job FILE NAME: the lines of that job.
job() { awk -v j="  $2:" '$0 == j { on = 1; print; next } on && /^  [A-Za-z0-9_-]+:/ { on = 0 } on' "$1"; }
t_workflows() {
	CASE=workflows
	local f=$TREE/.github/workflows/follow.yml p=$TREE/.github/workflows/publish.yml m=$TREE/.forgejo/workflows/follow-github.yml j b
	[[ -f $f && -f $p && -f $m ]] || {
		bad "the workflows are not at $TREE"
		return 0
	}
	for j in "$f prepare" "$f test-candidate" "$f test-original" "$f land" "$f report" "$p plan" "$p test" "$p publish" "$p tag" "$p notify"; do
		# shellcheck disable=SC2086 # file and job
		b=$(job $j)
		# 6: the first step of every job checks the exact ref, in the shell.
		eq "$(awk '/^    steps:/{s=1; next} s && /- name:/{print; exit}' <<<"$b" | sed 's/^ *//')" "- name: Only refs/heads/main" "6: $j checks the ref first"
		has "$b" '[ "$GITHUB_REF" = refs/heads/main ]' "6: $j compares the ref exactly"
		# 12: GitHub's jobs run on GitHub only.
		has "$(grep -E '^    if:' -A4 <<<"$b")" "github.server_url == 'https://github.com'" "12: $j only on GitHub"
	done
	# 6: every job that can write, or holds the OIDC token, is in an environment that GitHub admits from main alone:
	# npm for the publish (the trusted publisher names it), main-only for the rest; the jobs that only read are not.
	for j in "$f prepare" "$f test-candidate" "$f test-original" "$f land" "$f report" "$p plan" "$p test" "$p publish" "$p tag" "$p notify"; do
		# shellcheck disable=SC2086
		b=$(job $j)
		if grep -Eq '^      [a-z-]+: write$' <<<"$b"; then
			if grep -q '^      id-token: write$' <<<"$b"; then
				has "$b" "    environment: npm" "6: $j (OIDC) in the environment npm"
			else
				has "$b" "    environment: main-only" "6: $j (writes) in the environment main-only"
			fi
		else
			hasnt "$b" "environment:" "6: $j (reads only) needs no environment"
		fi
	done
	if [[ -f $TREE/docs/FOLLOWING.md ]]; then
		b=$(cat "$TREE/docs/FOLLOWING.md")
		for j in npm main-only; do
			has "$b" "gh api -X PUT repos/ngvoicu/pi-provimux/environments/$j" "6: FOLLOWING.md creates the environment $j"
			has "$b" "gh api -X POST repos/ngvoicu/pi-provimux/environments/$j/deployment-branch-policies -f name=main -f type=branch" \
				"6: FOLLOWING.md admits main alone to $j"
		done
		# 6.2: the git-install claim is qualified for a package manager pi does not recognise.
		has "$b" "with a package-manager command pi does not recognise" "6.2: FOLLOWING.md qualifies the git install"
		has "$b" "pi 1.3.0 runs a plain install in the git checkout" "6.2: a plain install installs development dependencies"
	else
		bad "no docs/FOLLOWING.md at $TREE"
	fi
	has "$(job "$f" prepare)" "Check the inputs" "6: the version input is checked"
	# 7: the original's and the candidate's code run in a container, no cache anywhere.
	for j in "$f test-candidate" "$f test-original" "$p test"; do
		# shellcheck disable=SC2086
		b=$(job $j)
		has "$b" 'docker run --rm' "7: $j runs the tree in a container"
		# Node on the host only for follow.sh's npm gate (test-candidate's fetch-candidate), before the tree is written
		# out and before any container; the others run no follow.sh and have none.
		if [[ $j == *test-candidate ]]; then
			eq "$(awk '/setup-node@/ { print "node" } /checkout-index|docker run/ { print "tree" }' <<<"$b" | uniq | head -n 1)" node \
				"7: $j sets up Node before the tree and any container"
			eq "$(grep -c 'setup-node@' <<<"$b")" 1 "7: $j has one setup-node"
		else
			hasnt "$b" 'setup-node' "7: $j has no setup-node"
		fi
		hasnt "$b" 'git archive' "7: $j writes the tree with checkout-index"
		# 7: the container sees an exported tree and this run's scripts read-only: never the workspace (its .git, which
		# the checkout's cleanup opens with a credential afterwards) or the current folder.
		eq "$(grep -oE -- '-v "[^"]*"' <<<"$b" | sort -u | grep -vxE -- '-v "\$RUNNER_TEMP/tree:/w(:ro)?"|-v "\$RUNNER_TEMP/pack:/pack(:ro)?"|-v "\$RUNNER_TEMP/follow:/follow:ro"' || true)" "" \
			"7: $j mounts only the exported tree, the archive folder and the scripts"
		hasnt "$b" 'GITHUB_WORKSPACE' "7: $j never names the workspace"
		has "$b" 'checkout-index -a --prefix="$RUNNER_TEMP/tree/"' "7: $j exports the tree by git"
	done
	# 5: the delivered package is loaded by pi before landing and before publishing.
	for j in "$f test-candidate" "$p test"; do
		# shellcheck disable=SC2086
		b=$(job $j)
		# The clean export is packed, read-only, before npm ci; the loader gets that archive read-only; nothing is
		# packed after the install (t_f5_order runs the steps).
		has "$b" '-v "$RUNNER_TEMP/tree:/w:ro" -v "$RUNNER_TEMP/pack:/pack" -w /w "$NODE_IMAGE"' "5: $j packs the tree read-only"
		has "$b" 'npm pack --ignore-scripts --pack-destination /pack' "5: $j packs into the archive folder"
		local lp lc
		lp=$({ grep -n 'npm pack --ignore-scripts --pack-destination /pack' <<<"$b" || true; } | head -n 1 | cut -d: -f1)
		lc=$({ grep -n '"$NODE_IMAGE" npm ci$' <<<"$b" || true; } | head -n 1 | cut -d: -f1)
		yes_ test "${lp:-999}" -lt "${lc:-0}"
		eq "$(awk -v c="${lc:-0}" 'NR > c' <<<"$b" | grep -c 'npm pack' || true)" 0 "5: $j packs nothing after npm ci"
		has "$b" '-v "$RUNNER_TEMP/pack:/pack:ro"' "5: $j gives the loader the archive read-only"
		has "$b" 'node /follow/load.mjs "$1" /w/node_modules' "5: $j loads that archive"
	done
	hasnt "$(cat "$f" "$p")" '        cache:' "7: no cache input"
	# Every job that runs follow.sh sets up Node 24 before it: follow.sh refuses npm older than 11.5.1 (2.1).
	for j in $(grep -oE '^  [A-Za-z0-9_-]+:$' "$f" | tr -d ' :'); do
		b=$(job "$f" "$j")
		grep -q 'follow/follow.sh' <<<"$b" || continue
		eq "$(awk '/setup-node@/ { print "node" } /follow\/follow.sh/ { print "follow" } /node-version: .24./ { print "24" }' <<<"$b" | head -n 2 | tr '\n' ' ')" "node 24 " \
			"2.1: follow.yml's $j sets up Node 24 before follow.sh"
	done
	for j in $(grep -oE '^  [A-Za-z0-9_-]+:$' "$p" | tr -d ' :'); do
		b=$(job "$p" "$j")
		grep -q 'follow/follow.sh' <<<"$b" || continue
		eq "$(awk '/setup-node@/ { print "node" } /follow\/follow.sh/ { print "follow" } /node-version: .24./ { print "24" }' <<<"$b" | head -n 2 | tr '\n' ' ')" "node 24 " \
			"2.1: publish.yml's $j sets up Node 24 before follow.sh"
	done
	eq "$(grep -c 'actions/setup-node@' "$f" "$p" | awk -F: '{ s += $2 } END { print s }')" \
		"$(grep -c 'package-manager-cache: false' "$f" "$p" | awk -F: '{ s += $2 } END { print s }')" "7: every setup-node without its cache"
	# 3, 10: land runs follow.sh land (recheck, landed only after the dispatch); one writer of main at a time.
	has "$(job "$f" land)" 'follow.sh land' "3: land rechecks by content"
	# No job that holds a credential installs dependencies or runs their scripts: npm ci runs only in the three
	# test jobs, inside the container; npm pack and npm publish always with --ignore-scripts; the scripts the
	# credentialed jobs run install nothing.
	for j in "$f prepare" "$f land" "$f report" "$p plan" "$p publish" "$p tag" "$p notify"; do
		# shellcheck disable=SC2086
		b=$(job $j | grep -v '^ *#' | grep -v -- '- name:')
		hasnt "$b" 'npm ci' "deps: $j does not run npm ci"
		hasnt "$b" 'npm install' "deps: $j does not run npm install"
		hasnt "$b" 'npm rebuild' "deps: $j does not run npm rebuild"
		eq "$(grep -E 'npm (pack|publish)( |$)' <<<"$b" | grep -vc -- '--ignore-scripts' || true)" 0 "deps: $j packs and publishes with --ignore-scripts"
	done
	for j in "$f test-candidate" "$f test-original" "$p test"; do
		# shellcheck disable=SC2086
		b=$(job $j | grep -v '^ *#' | grep -v -- '- name:')
		# shellcheck disable=SC2086
		eq "$(grep -cE 'npm (ci|install)' <<<"$b")" "$(job_containers $j | grep -cE '^npm (ci|install --no-save --ignore-scripts)( |$)')" \
			"deps: $j installs only in the container (npm ci, or pi 1.6.0 without saving or scripts)"
	done
	# The checks on pi 1.3.0 (the lockfile's) and then on pi 1.6.0, before landing and before publishing: the container
	# steps in this order (t_f5_order runs them).
	for j in "$f test-candidate" "$p test"; do
		# shellcheck disable=SC2086
		eq "$(job_containers $j | awk '
			/^npm pack --ignore-scripts --pack-destination \/pack$/ { print "pack"; next }
			/^npm ci$/ { print "ci"; next }
			/node \/follow\/load.mjs/ { print "load"; next }
			/^npm run check$/ { print "check"; next }
			/^npm install --no-save --ignore-scripts @earendil-works\/pi-ai@1.6.0 @earendil-works\/pi-coding-agent@1.6.0$/ { print "pi-1.6.0"; next }
			/^sh -c .npm ls @earendil-works\/pi-ai @earendil-works\/pi-coding-agent && npm run check.$/ { print "check"; next }
			{ print "other" }' | tr '\n' ' ')" "pack ci load check pi-1.6.0 load check " "pi versions: $j loads and checks on pi 1.3.0, then on 1.6.0"
	done
	eq "$(grep -vE '^\s*(#|echo|refuse|say)' "$SCRIPTS/follow.sh" | grep -cE '\bnpm(_neutral)? +(ci|install|rebuild)\b' || true)" 0 "deps: follow.sh installs nothing"
	eq "$(grep -vE '^\s*(#|echo|refuse|say)' "$SCRIPTS/follow.sh" | grep -E '\bnpm(_neutral)? +(pack|publish)\b' | grep -vc -- '--ignore-scripts' || true)" 0 \
		"deps: follow.sh packs with --ignore-scripts"
	hasnt "$(cat "$f")" 'landed=landed' "10: no landed written in the workflow"
	for j in "$f land" "$p publish" "$p tag"; do
		# shellcheck disable=SC2086
		has "$(job $j)" "group: pi-provimux-main" "10: $j in the main group"
	done
	# 10: main checked in the same step as the upload.
	b=$(job "$p" publish | awk '/- name: Check main, then npm publish/{on=1} on')
	has "$b" "git ls-remote" "10: the publish step checks main"
	has "$b" "npm publish --ignore-scripts" "10: and publishes in the same step"
	# The tested archive is what is published (4.2): the test job records its sha512 and uploads it before any
	# dependency code runs; publish takes it by id and digest (follow.sh archive), checks the sha512 again in the
	# publishing step, never packs, and publishes or dry-runs that file alone.
	b=$(job "$p" test)
	local lr lu lci
	lr=$({ grep -n -- '- name: Record the tested archive' <<<"$b" || true; } | head -n 1 | cut -d: -f1)
	lu=$({ grep -n 'actions/upload-artifact@' <<<"$b" || true; } | head -n 1 | cut -d: -f1)
	lci=$({ grep -n '"$NODE_IMAGE" npm ci$' <<<"$b" || true; } | head -n 1 | cut -d: -f1)
	yes_ test "${lr:-999}" -lt "${lu:-0}"
	yes_ test "${lu:-999}" -lt "${lci:-0}"
	has "$b" 'openssl dgst -sha512 -binary' "archive: the test job records the sha512"
	has "$b" 'name: publish-archive' "archive: and uploads publish-archive"
	has "$b" 'integrity: ${{ steps.archive.outputs.integrity }}' "archive: the sha512 is the test job's output"
	b=$(job "$p" publish | grep -v '^ *#')
	has "$b" 'follow.sh" archive' "archive: publish takes it by follow.sh archive"
	has "$b" 'ID: ${{ needs.test.outputs.archive_id }}' "archive: by the test job's artifact id"
	has "$b" 'DIGEST: ${{ needs.test.outputs.archive_digest }}' "archive: and digest"
	hasnt "$b" 'npm pack' "archive: publish packs nothing"
	eq "$(grep -c 'npm publish ' <<<"$b")" 2 "archive: one publish and one dry run"
	eq "$(grep 'npm publish ' <<<"$b" | grep -vc ' "\$archive"$' || true)" 0 "archive: each publishes the archive alone"
	has "$(awk '/- name: Check main, then npm publish/{on=1} on' <<<"$b")" '= "$INTEGRITY" ] || fail' "archive: sha512 checked again in the publishing step"
	has "$b" 'env -u ACTIONS_ID_TOKEN_REQUEST_URL -u ACTIONS_ID_TOKEN_REQUEST_TOKEN -u NPM_ID_TOKEN' "archive: the dry run cannot exchange a token"
	has "$b" 'npm publish --dry-run --ignore-scripts' "archive: the dry run is npm publish --dry-run"
	has "$(job "$p" tag)" 'follow.sh tag' "10: tag and release by the script"
	# 11: the mirror.
	has "$(cat "$m")" 'git push --atomic ${lease:+"$lease"} origin' "11: one atomic push"
	has "$(cat "$m")" 'lease="--force-with-lease=refs/heads/main:$here"' "11: main moves only from the commit read"
	has "$(cat "$m")" 'refs/nas-backup/main-$(date -u +%Y%m%dT%H%M%SZ)' "11: the NAS's main kept before it is rewritten"
	has "$(cat "$m")" "refs/remotes/origin/main" "11: fully qualified refs"
	if grep -Eq 'uses: actions/checkout@[0-9a-f]{40}' "$m"; then ok; else bad "11: checkout pinned by SHA"; fi
	# Every action pinned.
	eq "$(grep -hE '^\s*-? *uses:' "$f" "$p" "$m" | grep -vcE '@[0-9a-f]{40}( |$)' || true)" 0 "every action pinned by SHA"
}

# --- finding 12: no revision runs GitHub's workflows on Forgejo --------------------------------------------------
# A revision with .github/workflows but no .forgejo/workflows (Forgejo then reads .github/workflows) passes only when
# that folder is exactly one of the two tag-triggered publish.yml files of main's 105.0.1 revisions, public and kept as
# they are, both checked to run their two jobs on GitHub only: the blob of dad67d5 and the blob of ecce622.
F12_KNOWN='67b7efe1cd319f7908987e2e0effe38bb3254973 96781b145be7919a4539ebb31ccb84420c339f28'
known_105_0_1() { # known_105_0_1 COMMIT: .github/workflows at COMMIT is exactly publish.yml, one of F12_KNOWN
	local l mode type blob name
	l=$(git -C "$TREE" ls-tree "$1:.github/workflows") || return 1
	[[ $(wc -l <<<"$l" | tr -d ' ') == 1 ]] || return 1
	read -r mode type blob name <<<"$l"
	[[ $mode == 100644 && $type == blob && $name == publish.yml && " $F12_KNOWN " == *" $blob "* ]]
}
t_f12_history() {
	CASE=f12-history
	local c n=0 seen=''
	if ! git -C "$TREE" rev-parse --git-dir >/dev/null 2>&1; then
		bad "no history at $TREE"
		return 0
	fi
	for c in $(git -C "$TREE" rev-list HEAD); do
		if git -C "$TREE" cat-file -e "$c:.github/workflows" 2>/dev/null && ! git -C "$TREE" cat-file -e "$c:.forgejo/workflows" 2>/dev/null; then
			if known_105_0_1 "$c"; then
				seen="$seen $(git -C "$TREE" rev-parse "$c:.github/workflows/publish.yml")"
			else
				bad "12: $c has .github/workflows without .forgejo/workflows, and not one of 105.0.1's two publish.yml"
				n=$((n + 1))
			fi
		fi
	done
	if ((n == 0)); then ok; fi
	# The two known files: each one met in this history (the list is not stale), each running its two jobs on GitHub
	# only (read again, not trusted from the list).
	local blob jobs ifs
	for blob in $F12_KNOWN; do
		has "$seen" "$blob" "12: $blob is a revision of main without .forgejo/workflows"
		if ! git -C "$TREE" cat-file -e "$blob" 2>/dev/null; then
			bad "12: $blob is not in this history"
			continue
		fi
		jobs=$(git -C "$TREE" cat-file blob "$blob" | awk '/^jobs:/{on=1; next} on && /^[^ #]/{on=0} on && /^  [A-Za-z0-9_-]+:$/' | wc -l | tr -d ' ')
		ifs=$(git -C "$TREE" cat-file blob "$blob" | grep -cE "^    if: github\.server_url == 'https://github\.com'$" || true)
		eq "$jobs $ifs" "2 2" "12: $blob runs its two jobs on GitHub only"
	done
	# The exception, on a throwaway repository: a known file passes; another file beside it, the same name with
	# other bytes, or another name with the known bytes, fails it.
	local g=$T/f12-known
	rm -rf "$g"
	git init -q "$g"
	mkdir -p "$g/.github/workflows"
	git -C "$TREE" cat-file blob 67b7efe1cd319f7908987e2e0effe38bb3254973 >"$g/.github/workflows/publish.yml"
	(cd "$g" && git add -A && commit "105.0.1's publish.yml")
	if TREE=$g known_105_0_1 HEAD; then ok; else bad "12: a known publish.yml passes"; fi
	printf 'on: push\n' >"$g/.github/workflows/other.yml"
	(cd "$g" && git add -A && commit "another workflow beside it")
	if TREE=$g known_105_0_1 HEAD; then bad "12: another workflow beside it passes"; else ok; fi
	rm "$g/.github/workflows/other.yml"
	printf '# changed\n' >>"$g/.github/workflows/publish.yml"
	(cd "$g" && git add -A && commit "publish.yml changed")
	if TREE=$g known_105_0_1 HEAD; then bad "12: a changed publish.yml passes"; else ok; fi
	git -C "$TREE" cat-file blob 96781b145be7919a4539ebb31ccb84420c339f28 >"$g/.github/workflows/publish.yml"
	(cd "$g" && git mv .github/workflows/publish.yml .github/workflows/release.yml && git add -A && commit "renamed")
	if TREE=$g known_105_0_1 HEAD; then bad "12: the known bytes under another name pass"; else ok; fi
}

# publish.yml's tested archive (follow.sh archive): only the archive the test job packed and recorded is published.
# pack_commit DIR: the fork's HEAD written out by git and packed by npm into DIR, as the test job packs it.
pack_commit() {
	local d=$1
	rm -rf "$d" "$d.tree"
	mkdir -p "$d"
	GIT_INDEX_FILE=$d.index git read-tree HEAD
	GIT_INDEX_FILE=$d.index git checkout-index -a --prefix="$d.tree/"
	rm -f "$d.index"
	(cd "$d.tree" && npm pack --ignore-scripts --pack-destination "$d" >/dev/null 2>&1)
}
# serve_archive NAME FILE…: the artifact NAME of run 777 holding FILEs, as the gh stub serves it; prints its digest.
serve_archive() {
	local name=$1 z=$T/archive-zip d
	shift
	rm -rf "$z"
	mkdir -p "$z"
	cp "$@" "$z/"
	(cd "$z" && zip -q -X a.zip ./*)
	d=$( (sha256sum "$z/a.zip" 2>/dev/null || shasum -a 256 "$z/a.zip") | cut -d' ' -f1)
	cp "$z/a.zip" "$GH_DIR/artifact.zip"
	jq -n --arg n "$name" --arg d "sha256:$d" '{workflow_run: {id: 777}, name: $n, expired: false, digest: $d}' >"$GH_DIR/artifact.json"
	echo "$d"
}
# archive_run ARGS…: follow.sh archive in run 777; standard output alone in RUN_OUT, exit code in RUN_RC.
archive_run() {
	RUN_RC=0
	RUN_OUT=$(GITHUB_RUN_ID=777 PATH="$T/gh/bin:$PATH" bash "$FOLLOW" archive "$@" 2>"$T/archive.err") || RUN_RC=$?
}
t_archive() {
	fresh archive
	gh_stub
	cd "$F"
	# Under npm older than 11.5.1, follow.sh refuses every command (asserted by run); the rest needs a newer npm.
	run archive
	past_gate || return 0
	local sha d integ tgz=$T/archive/pack/pi-provimux-105.0.1.tgz dest=$T/archive/dest other
	sha=$(git rev-parse HEAD)
	pack_commit "$T/archive/pack"
	yes_ test -f "$tgz"
	integ=$(sri "$tgz")
	d=$(serve_archive publish-archive "$tgz")
	# The tested archive: taken, and its path alone on standard output.
	archive_run 4242 "$d" "$integ" "$sha" 105.0.1 "$dest"
	eq "$RUN_RC" 0 "the tested archive is taken: $(cat "$T/archive.err")"
	eq "$RUN_OUT" "$dest/pi-provimux-105.0.1.tgz" "standard output is exactly its path"
	yes_ cmp -s "$tgz" "$dest/pi-provimux-105.0.1.tgz"
	# A digest mismatch refuses: the recorded sha512 is another archive's. Nothing is written.
	archive_run 4242 "$d" "$(fake_sri other)" "$sha" 105.0.1 "$dest-2"
	eq "$RUN_RC" 4 "a digest mismatch refuses"
	has "$(cat "$T/archive.err")" "is not the archive the test job recorded" "says so"
	eq "$RUN_OUT" "" "nothing on standard output"
	yes_ test ! -e "$dest-2"
	# The same files, compressed again (another npm, another gzip): another sha512, refused.
	mkdir -p "$T/archive/re"
	(cd "$T/archive/re" && tar xzf "$tgz" && tar cf - package | gzip -9 >pi-provimux-105.0.1.tgz)
	d=$(serve_archive publish-archive "$T/archive/re/pi-provimux-105.0.1.tgz")
	archive_run 4242 "$d" "$integ" "$sha" 105.0.1 "$dest-3"
	eq "$RUN_RC" 4 "the same files packed again: refused"
	# The artifact must be what the test job uploaded: its digest, its name, one file.
	d=$(serve_archive publish-archive "$tgz")
	archive_run 4242 "$(printf '%064d' 0)" "$integ" "$sha" 105.0.1 "$dest-4"
	eq "$RUN_RC" 1 "another artifact digest: refused"
	d=$(serve_archive follow-candidate "$tgz")
	archive_run 4242 "$d" "$integ" "$sha" 105.0.1 "$dest-5"
	eq "$RUN_RC" 1 "an artifact of another name: refused"
	printf 'x\n' >"$T/archive/extra.txt"
	d=$(serve_archive publish-archive "$tgz" "$T/archive/extra.txt")
	archive_run 4242 "$d" "$integ" "$sha" 105.0.1 "$dest-6"
	eq "$RUN_RC" 4 "an artifact with another file: refused"
	# An archive whose recorded sha512 matches, but whose files are not the commit's: refused by the comparison.
	change extensions/fork.ts 'export const fork = 2;' "fix: fork 2"
	other=$(git rev-parse HEAD)
	git checkout -q "$sha"
	printf 'export const fork = 3;\n' >extensions/fork.ts
	git add -A && commit "not on main"
	pack_commit "$T/archive/pack3"
	git checkout -q main
	d=$(serve_archive publish-archive "$T/archive/pack3/pi-provimux-105.0.1.tgz")
	archive_run 4242 "$d" "$(sri "$T/archive/pack3/pi-provimux-105.0.1.tgz")" "$other" 105.0.1 "$dest-7"
	eq "$RUN_RC" 4 "files other than the commit's: refused"
	has "$(cat "$T/archive.err")" "does not ship exactly the files npm packs from" "says so"
	yes_ test ! -e "$dest-7"
}

t_plan() {
	fresh plan
	npm_set pi-provimux 105.0.0 "105.0.0 900"
	npm_done
	cd "$F"
	run plan
	eq "$RUN_RC" 0 "plan: $RUN_OUT"
	has "$RUN_OUT" "pi-provimux@105.0.1 is to be published" "to publish"
	npm_set pi-provimux 105.0.1 "105.0.1 900"
	npm_done
	run plan
	has "$RUN_OUT" "npm has pi-provimux@105.0.1" "already published"
	rm -rf "$FOLLOW_NPM_DIR"
	run plan
	eq "$RUN_RC" 0 "a first publish (no package on npm)"
	setver 2.0.0 && git add -A && commit "chore: 2.0.0"
	run plan
	has "$RUN_OUT" "is not <major×100+minor>" "a version of another form"
	setver 106.0.1 && git add -A && commit "chore: 106.0.1"
	run plan
	has "$RUN_OUT" "is built on 1.6.0 by its number, git shows 1.5.0" "a version with another base"
	setver 105.0.2 && git add -A && commit "chore: 105.0.2"
	jq --tab '.scripts.prepare = "x"' package.json >p && mv p package.json
	printf 'x\n' >extensions/untracked.ts
	git add package.json && commit "chore: bad"
	run plan
	eq "$RUN_RC" 4 "refused"
	has "$RUN_OUT" "a lifecycle script 'prepare'" "lifecycle"
	has "$RUN_OUT" "is not a tracked file" "untracked file in the tarball"
	has "$RUN_OUT" "the work tree is not the commit" "dirty tree"
	rm extensions/untracked.ts
	printf 'registry=x\n' >.npmrc
	git add .npmrc && commit "chore: npmrc"
	npm_set pi-provimux 105.0.2 "105.0.2 1"
	npm_done
	run plan
	eq "$RUN_RC" 4 "an .npmrc is refused even when npm says the version is there"
	has "$RUN_OUT" ".npmrc: the tree has one" ".npmrc"
}

# --- npm's boundary: npm 11.5.1 or later, and npm with an empty environment -----------------------------------
# fake_npm_as DIR VERSION: an npm on PATH that says VERSION. Each other call is logged (DIR/calls) with its
# environment (DIR/env.<n>); for pack, it starts the packed folder's prepare script with that environment, as
# npm 10 does even with --ignore-scripts; then it runs the real npm.
fake_npm_as() {
	local d=$1 v=$2 real
	real=$(command -v npm)
	mkdir -p "$d/bin"
	: >"$d/calls"
	: >"$d/versions"
	cat >"$d/bin/npm" <<-SH
		#!/bin/sh
		if [ "\$1" = --version ]; then echo x >>"$d/versions"; echo $v; exit 0; fi
		n=\$(wc -l <"$d/calls" | tr -d ' ')
		echo "\$*" >>"$d/calls"
		env >"$d/env.\$n"
		if [ "\$1" = pack ]; then
			last=''
			for a in "\$@"; do if [ -f "\$a/package.json" ]; then last=\$a; fi; done
			if [ -n "\$last" ]; then
				s=\$(node -e 'const p=require(process.argv[1]);process.stdout.write((p.scripts&&p.scripts.prepare)||"")' "\$last/package.json")
				[ -z "\$s" ] || (cd "\$last" && sh -c "\$s") >/dev/null 2>&1 || true
			fi
		fi
		exec "$real" "\$@"
	SH
	chmod +x "$d/bin/npm"
}
# with_tokens CMD…: CMD with synthetic credentials in its environment, as a maintainer's shell or a job may have.
with_tokens() {
	GH_TOKEN=synthetic-gh GITHUB_TOKEN=synthetic-github NODE_AUTH_TOKEN=synthetic-node-auth NPM_TOKEN=synthetic-npm \
		ACTIONS_RUNTIME_TOKEN=synthetic-runtime ACTIONS_ID_TOKEN_REQUEST_TOKEN=synthetic-oidc \
		ACTIONS_ID_TOKEN_REQUEST_URL=https://synthetic.invalid/ FOLLOW_TEST_OTHER=synthetic-other "$@"
}
# with_prepare FILE: the current repository's package.json gets a prepare script that writes its environment to FILE.
with_prepare() {
	jq --tab --arg s "env > '$1'" '.scripts.prepare = $s' package.json >p.tmp && mv p.tmp package.json
}
t_npm_boundary() {
	local B=$T/npm-boundary v n keys
	rm -rf "$B"
	mkdir -p "$B"
	# Lock 2: npm older than 11.5.1 is refused before any npm call touches a tree. The review's case: npm 10 on the
	# upstream release (prepare) and on the fork (plan), each tree with a prepare script, a token in the environment.
	fresh npm-old
	with_prepare "$B/hook-old.env"
	release 1.5.1
	fake_npm_as "$B/npm10" 10.9.3
	PATH="$B/npm10/bin:$PATH" with_tokens run prepare
	eq "$RUN_RC" 1 "npm 10.9.3: prepare stops"
	has "$RUN_OUT" "npm 10.9.3 is older than 11.5.1" "says why"
	has "$RUN_OUT" "runs an upstream tree's prepare script" "and the reason"
	CASE=npm-old-plan
	with_prepare "$B/hook-old.env"
	git add package.json && commit "chore: a prepare"
	PATH="$B/npm10/bin:$PATH" with_tokens run plan
	eq "$RUN_RC" 1 "npm 10.9.3: plan stops"
	has "$RUN_OUT" "npm 10.9.3 is older than 11.5.1" "plan says why"
	eq "$(wc -l <"$B/npm10/calls" | tr -d ' ')" 0 "npm 10: no call but --version"
	if [[ -e $B/hook-old.env ]]; then bad "npm 10: a hook ran"; else ok; fi
	# The bound itself: 11.5.0 is refused, 11.5.1 runs.
	for v in 11.5.0 11.5.1; do
		fake_npm_as "$B/npm-$v" "$v"
		PATH="$B/npm-$v/bin:$PATH" run plan
		if [[ $v == 11.5.0 ]]; then has "$RUN_OUT" "npm 11.5.0 is older than 11.5.1" "11.5.0 refused"; else hasnt "$RUN_OUT" "is older than" "11.5.1 runs"; fi
	done
	# Lock 1: every npm call gets an empty environment plus PATH, a throwaway HOME, empty configuration, scripts off
	# and the registry. An npm that starts prepare as npm 10 does (the fake, saying 11.99.0) still hands it no token.
	fresh npm-env
	with_prepare "$B/hook-upstream.env"
	release 1.5.1
	with_prepare "$B/hook-fork.env"
	setver 105.0.2 && git add -A && commit "chore: 105.0.2 with a prepare"
	fake_npm_as "$B/npm-env" 11.99.0
	PATH="$B/npm-env/bin:$PATH" with_tokens run prepare
	has "$(cat "$B/npm-env/calls")" "pack --dry-run --ignore-scripts" "the upstream tree was dry-packed"
	PATH="$B/npm-env/bin:$PATH" with_tokens run plan
	yes_ test -s "$B/hook-upstream.env"
	yes_ test -s "$B/hook-fork.env"
	for f in "$B/hook-upstream.env" "$B/hook-fork.env" "$B"/npm-env/env.*; do
		hasnt "$(cat "$f")" "synthetic" "no token in $(basename "$f")"
		hasnt "$(cat "$f")" "FOLLOW_" "no other variable in $(basename "$f")"
	done
	n=0
	for f in "$B"/npm-env/env.*; do
		n=$((n + 1))
		keys=$(cut -d= -f1 "$f" | grep -Ev '^(PWD|OLDPWD|SHLVL|_)$' | LC_ALL=C sort | tr '\n' ' ')
		eq "$keys" "HOME PATH npm_config_globalconfig npm_config_ignore_scripts npm_config_registry npm_config_userconfig " "npm's environment ($(basename "$f"))"
		has "$(cat "$f")" "npm_config_ignore_scripts=true" "scripts off"
		has "$(cat "$f")" "npm_config_registry=https://registry.npmjs.org/" "the registry"
	done
	yes_ test "$n" -ge 2
	# The real npm on PATH (11.5.1 or later), a token in the caller's environment, a prepare that prints its
	# environment: npm starts no hook, and if one ever ran, it would see no token.
	fresh npm-real
	with_prepare "$B/hook-real.env"
	release 1.5.1
	with_tokens run prepare
	hasnt "$RUN_OUT" "is older than" "the real npm is new enough"
	if [[ -e $B/hook-real.env ]]; then hasnt "$(cat "$B/hook-real.env")" "synthetic" "real npm: no token"; else ok; fi
}

# Every command follow.sh's dispatcher accepts (read from follow.sh itself, so a new one cannot be left out), and an
# unknown one, under a stand-in npm 10.9.3 with tokens in the environment: each stops at --version, says why, and
# makes no other npm call. Only a plain help runs without npm. And the review's case: merge of a release whose
# tree has a prepare hook starts no hook.
t_npm_gate() {
	local B=$T/npm-gate c cmds n=0
	rm -rf "$B"
	fresh npm-gate
	with_prepare "$B/hook-merge.env"
	release 1.5.1
	fake_npm_as "$B/npm10" 10.9.3
	cmds=$(sed -n '/^# --- main/,$p' "$FOLLOW" | grep -oE '^[a-z-]+\) cmd_' | sed 's/) cmd_//')
	has "$cmds" "merge" "the dispatcher's commands, merge among them"
	for c in $cmds no-such-command; do
		n=$((n + 1))
		: >"$B/npm10/versions"
		RUN_RC=0
		RUN_OUT=$(PATH="$B/npm10/bin:$PATH" with_tokens bash "$FOLLOW" "$c" 1.5.1 "$(git rev-parse HEAD)" x 2>&1) || RUN_RC=$?
		eq "$RUN_RC" 1 "npm 10.9.3: $c refused"
		has "$RUN_OUT" "npm 10.9.3 is older than 11.5.1" "npm 10.9.3: $c says why"
		eq "$(cat "$B/npm10/calls")" "" "npm 10.9.3: $c made no npm call but --version"
		eq "$(wc -l <"$B/npm10/versions" | tr -d ' ')" 1 "npm 10.9.3: $c asked --version once"
	done
	yes_ test "$n" -ge 13
	yes_ test ! -e "$B/hook-merge.env"
	eq "$(git rev-parse HEAD)" "$(git rev-parse main)" "merge left the fork alone"
	yes_ git diff --quiet
	# A plain help, and only that, without npm.
	for c in help -h --help; do
		: >"$B/npm10/versions"
		RUN_RC=0
		RUN_OUT=$(PATH="$B/npm10/bin:$PATH" bash "$FOLLOW" "$c" 2>&1) || RUN_RC=$?
		eq "$RUN_RC" 0 "$c: the usage"
		has "$RUN_OUT" "follow.sh select" "$c: says the commands"
		eq "$(cat "$B/npm10/versions" "$B/npm10/calls")" "" "$c: no npm"
	done
	# The same merge with the npm on PATH: npm 10 is refused at --version (run asserts it), npm 11.5.1 or later
	# merges; neither starts the release's prepare hook.
	with_tokens run merge 1.5.1
	if [[ -e $B/hook-merge.env ]]; then bad "merge with the npm on PATH started the hook"; else ok; fi
}

# --- run ----------------------------------------------------------------------------------------------------------
build_fixture >/dev/null
ALL='numbers clean rerun waiting states conflict manifest_conflict manifest_merge refusals shape readme report plan
f2_release f3_strings f3_handoff f3_links f3_checker f4_deps f4_dev_lands f5_paths f5_pack f5_load f5_order f6_refs f8_recovery
f9_issues f10_publish f10_land f11_mirror workflows f12_history npm_boundary npm_gate archive'
# shellcheck disable=SC2086 # the names
[[ $# -gt 0 ]] || set -- $ALL
for t in "$@"; do
	echo "- $t"
	"t_$t"
done
echo "follow tests: $PASS passed, $FAIL failed${FAILED_CASES:+ (in:$FAILED_CASES)}"
if ((SKIP)); then echo "follow tests: $SKIP assertions skipped past a refusal of an npm older than 11.5.1 (each refusal asserted)"; fi
((FAIL == 0))
