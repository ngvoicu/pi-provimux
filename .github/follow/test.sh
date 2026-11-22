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
ok() { PASS=$((PASS + 1)); }
bad() {
	FAIL=$((FAIL + 1))
	case " $FAILED_CASES " in *" $CASE "*) ;; *) FAILED_CASES="$FAILED_CASES $CASE" ;; esac
	echo "  FAIL [$CASE] $*" >&2
	if [[ -n ${FOLLOW_TEST_VERBOSE:-} ]]; then printf '%s\n' "${RUN_OUT:-}" | awk '{ print "    | " $0 }' >&2; fi
}
eq() { if [[ $1 == "$2" ]]; then ok; else bad "$3: got '$1', want '$2'"; fi; }
has() { if grep -Fq -- "$2" <<<"$1"; then ok; else bad "$3: '$2' not in: $(head -c 600 <<<"$1")"; fi; }
hasnt() { if grep -Fq -- "$2" <<<"$1"; then bad "$3: '$2' is in it"; else ok; fi; }
yes_() { if "$@"; then ok; else bad "${CHECK:-check}: $*"; fi; }

export GIT_CONFIG_GLOBAL=$T/gitconfig GIT_CONFIG_NOSYSTEM=1
git config --global user.name Tester
git config --global user.email tester@example.invalid
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
	# shellcheck disable=SC2046 # one path per word: the fixture's names have no spaces
	git -C "$O" archive --format=tar --prefix=package/ "$c" -- $(cat "$T/pack.list") | gzip -n >"$tgz"
	jq -n --arg t "$tgz" --arg i "$(sri "$tgz")" '{tarball: $t, integrity: $i}' >"$dir/_router-for-me_pi-cliproxyapi-provider@$v.dist.json"
}

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

# The delivered package, loaded: load.mjs unpacks npm's tarball into a consumer of its own and has pi's loader (here
# a stub of discoverAndLoadExtensions that imports each registered extension and calls it) load it. A file the
# extension imports by a template literal and the tarball lacks fails; the same package with it loads.
t_f5_load() {
	CASE=f5-load
	local d=$T/f5-load pi
	rm -rf "$d"
	pi=$d/nm/@earendil-works/pi-coding-agent
	mkdir -p "$d/pkg/extensions" "$pi" "$d/out"
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
	has "$RUN_OUT" "outside the tree" "says why"
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
	eq "$(wc -l <"$T/fakenpm/log" | tr -d ' ')" 0 "npm never ran"
	# Without one, npm runs from a neutral folder against the public registry.
	git rm -q .npmrc && commit "chore: no npmrc"
	FOLLOW_NPM_DIR='' PATH="$T/fakenpm:$PATH" run plan
	has "$(cat "$T/fakenpm/log")" "--registry=https://registry.npmjs.org/" "the public registry"
	hasnt "$(cut -d' ' -f1 "$T/fakenpm/log")" "$F" "not from the tree"
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
		echo "\$PWD \$*" >>"$T/fakenpm/log"
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
	gh_run report
	eq "$RUN_RC" 0 "up to date is green"
	eq "$(bot "follow:" | jq -r '.[0].state')" closed "closed"
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
	DRY_RUN=no gh_run report-publish 105.0.1 success
	eq "$(jq -r '.[0].state' "$GH_ISSUES")" open "success without the version on npm closes nothing"
	npm_set pi-provimux 105.0.1 "105.0.1 1"
	npm_done
	DRY_RUN=no gh_run report-publish 105.0.1 success
	eq "$(jq -r '.[0].state' "$GH_ISSUES")" closed "closed once npm shows it"
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
	else
		bad "no docs/FOLLOWING.md at $TREE"
	fi
	has "$(job "$f" prepare)" "Check the inputs" "6: the version input is checked"
	# 7: the original's and the candidate's code run in a container, no cache anywhere.
	for j in "$f test-candidate" "$f test-original" "$p test"; do
		# shellcheck disable=SC2086
		b=$(job $j)
		has "$b" 'docker run --rm' "7: $j runs the tree in a container"
		hasnt "$b" 'setup-node' "7: $j has no setup-node"
		hasnt "$b" 'git archive' "7: $j writes the tree with checkout-index"
		# 7: the container sees an exported tree and this run's scripts read-only: never the workspace (its .git, which
		# the checkout's cleanup opens with a credential afterwards) or the current folder.
		eq "$(grep -oE -- '-v "[^"]*"' <<<"$b" | sort -u | grep -vxE -- '-v "\$RUNNER_TEMP/tree:/w"|-v "\$RUNNER_TEMP/follow:/follow:ro"' || true)" "" \
			"7: $j mounts only the exported tree and the scripts"
		hasnt "$b" 'GITHUB_WORKSPACE' "7: $j never names the workspace"
		has "$b" 'checkout-index -a --prefix="$RUNNER_TEMP/tree/"' "7: $j exports the tree by git"
	done
	# 5: the delivered package is loaded by pi before landing and before publishing.
	for j in "$f test-candidate" "$p test"; do
		# shellcheck disable=SC2086
		b=$(job $j)
		has "$b" 'npm pack --ignore-scripts --pack-destination /tmp/pack' "5: $j packs in the container"
		has "$b" 'node /follow/load.mjs /tmp/pack/*.tgz /w/node_modules' "5: $j loads the packed package"
	done
	hasnt "$(cat "$f" "$p")" '        cache:' "7: no cache input"
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
		eq "$(grep -cE 'npm (ci|install)' <<<"$b")" "$(grep -c '"$NODE_IMAGE" npm ci$' <<<"$b")" "deps: $j installs only in the container"
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
	has "$(job "$p" tag)" 'follow.sh tag' "10: tag and release by the script"
	# 11: the mirror.
	has "$(cat "$m")" "git push --atomic origin" "11: one atomic push"
	has "$(cat "$m")" "refs/remotes/origin/main" "11: fully qualified refs"
	if grep -Eq 'uses: actions/checkout@[0-9a-f]{40}' "$m"; then ok; else bad "11: checkout pinned by SHA"; fi
	# Every action pinned.
	eq "$(grep -hE '^\s*-? *uses:' "$f" "$p" "$m" | grep -vcE '@[0-9a-f]{40}( |$)' || true)" 0 "every action pinned by SHA"
}

# --- finding 12: no revision runs GitHub's workflows on Forgejo --------------------------------------------------
t_f12_history() {
	CASE=f12-history
	local c n=0
	if ! git -C "$TREE" rev-parse --git-dir >/dev/null 2>&1; then
		bad "no history at $TREE"
		return 0
	fi
	for c in $(git -C "$TREE" rev-list HEAD); do
		if git -C "$TREE" cat-file -e "$c:.github/workflows" 2>/dev/null && ! git -C "$TREE" cat-file -e "$c:.forgejo/workflows" 2>/dev/null; then
			bad "12: $c has .github/workflows without .forgejo/workflows"
			n=$((n + 1))
		fi
	done
	if ((n == 0)); then ok; fi
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

# --- run ----------------------------------------------------------------------------------------------------------
build_fixture >/dev/null
ALL='numbers clean rerun waiting states conflict manifest_conflict manifest_merge refusals shape readme report plan
f2_release f3_strings f3_handoff f3_links f3_checker f4_deps f4_dev_lands f5_paths f5_pack f5_load f6_refs f8_recovery
f9_issues f10_publish f10_land f11_mirror workflows f12_history'
# shellcheck disable=SC2086 # the names
[[ $# -gt 0 ]] || set -- $ALL
for t in "$@"; do
	echo "- $t"
	"t_$t"
done
echo "follow tests: $PASS passed, $FAIL failed${FAILED_CASES:+ (in:$FAILED_CASES)}"
((FAIL == 0))
