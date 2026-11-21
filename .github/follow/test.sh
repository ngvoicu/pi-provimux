#!/usr/bin/env bash
# Tests of follow.sh and manifest.mjs on throwaway repositories: an "original" with releases, a "fork" built on its
# 1.5.0, a stub npm registry (FOLLOW_NPM_DIR) and a stub gh. Nothing leaves the temporary folder; no network.
#   bash .github/follow/test.sh            all
#   bash .github/follow/test.sh clean …    only the named ones
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
FOLLOW=$HERE/follow.sh
MANIFEST=$HERE/manifest.mjs
T=$(mktemp -d "${TMPDIR:-/tmp}/follow-test.XXXXXX")
trap 'rm -rf "${T:?}"' EXIT

PASS=0
FAIL=0
CASE=''
ok() { PASS=$((PASS + 1)); }
bad() {
	FAIL=$((FAIL + 1))
	echo "  FAIL [$CASE] $*" >&2
	if [[ -n ${FOLLOW_TEST_VERBOSE:-} ]]; then echo "${RUN_OUT:-}" | sed 's/^/    | /' >&2; fi
}
eq() { if [[ $1 == "$2" ]]; then ok; else bad "$3: got '$1', want '$2'"; fi; }
has() { if grep -Fq -- "$2" <<<"$1"; then ok; else bad "$3: '$2' not in: $(head -c 600 <<<"$1")"; fi; }
hasnt() { if grep -Fq -- "$2" <<<"$1"; then bad "$3: '$2' is in it"; else ok; fi; }

export GIT_CONFIG_GLOBAL=$T/gitconfig GIT_CONFIG_NOSYSTEM=1
git config --global user.name Tester
git config --global user.email tester@example.invalid
git config --global init.defaultBranch main
git config --global advice.detachedHead false
git config --global protocol.file.allow always

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

# --- the fixture --------------------------------------------------------------------------------------------------
build_fixture() {
	local o=$T/fixture/original f=$T/fixture/fork
	mkdir -p "$o"
	cd "$o"
	git init -q
	mkdir -p extensions test
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
			"devDependencies": {
				"a": "1.0.0",
				"b": "2.0.0"
			},
			"files": ["extensions", "README.md", "LICENSE", "CHANGELOG.md"]
		}
	JSON
	cat >package-lock.json <<-'JSON'
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
					"devDependencies": {
						"a": "1.0.0",
						"b": "2.0.0"
					}
				},
				"node_modules/a": {
					"version": "1.0.0",
					"resolved": "https://registry.npmjs.org/a/-/a-1.0.0.tgz",
					"integrity": "sha512-aaaa",
					"dev": true
				},
				"node_modules/b": {
					"version": "2.0.0",
					"resolved": "https://registry.npmjs.org/b/-/b-2.0.0.tgz",
					"integrity": "sha512-bbbb",
					"dev": true
				}
			}
		}
	JSON
	printf 'line 1\nline 2\nline 3\n' >extensions/index.ts
	printf 'export const x = 1;\n' >extensions/lib.ts
	printf 'test 1\n' >test/lib.test.ts
	printf '# The original\n\nInstall: pi install npm:@router-for-me/pi-cliproxyapi-provider\n' >README.md
	printf 'MIT License\n\nCopyright (c) router-for-me\n' >LICENSE
	printf 'export default {};\n' >vitest.config.ts
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

	# The fork: built on 1.5.0, renamed, its own README, test, file and changelog.
	git clone -q "$o" "$f"
	cd "$f"
	jq '.name = "pi-provimux" | .version = "105.0.1" | .description = "the fork"
		| .repository = {type: "git", url: "git+https://github.com/ngvoicu/pi-provimux.git"}' package.json >p.tmp
	jq --tab . p.tmp >package.json
	rm p.tmp
	jq '.name = "pi-provimux" | .version = "105.0.1" | .packages[""].name = "pi-provimux" | .packages[""].version = "105.0.1"' \
		package-lock.json | jq --tab . >l.tmp
	mv l.tmp package-lock.json
	printf '# pi-provimux\n\nInstall: pi install npm:pi-provimux\n' >README.md
	printf 'fork test\n' >test/fork.test.ts
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
	rm -rf "$FOLLOW_NPM_DIR"
	mv "$T/npm" "$FOLLOW_NPM_DIR"
}
# release V [HOURS_AGO]: bump the original to V; npm's latest is V, published HOURS_AGO (default 48).
release() {
	cd "$O"
	setver "$1"
	git add -A
	commit "chore: bump version to $1"
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
run() { # run ARGS…: follow.sh in the fork; output and exit code in RUN_OUT, RUN_RC
	RUN_RC=0
	RUN_OUT=$(bash "$FOLLOW" "$@" 2>&1) || RUN_RC=$?
}
state() { jq -r '.state' "$OUT/result.json"; }
field() { jq -r --arg k "$1" '.[$k] // "" | if type == "array" then .[] else tostring end' "$OUT/result.json"; }

# --- the cases ----------------------------------------------------------------------------------------------------
t_numbers() {
	CASE=numbers
	# manifest.mjs and the numbering through follow.sh's own functions.
	local f
	f=$(sed -n '/^encode() {/,/^}/p; /^decode() {/,/^}/p; /^is_plain() {/p; /^PLAIN_RE=/p' "$FOLLOW")
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
	[[ -s $OUT/candidate.bundle ]] && ok || bad "bundle"
	eq "$(field readme_changed)" false "README unchanged"
	# The bundle carries the candidate to a clone that has main only.
	git clone -q --no-local "$F" "$T/clean/clone"
	git -C "$T/clean/clone" fetch -q "$OUT/candidate.bundle" "+refs/follow/candidate:refs/follow/candidate"
	eq "$(git -C "$T/clean/clone" rev-parse refs/follow/candidate)" "$r" "bundle fetch"

	# By hand on the work tree: the same commits.
	run merge
	eq "$RUN_RC" 0 "merge by hand"
	run stamp
	eq "$RUN_RC" 0 "stamp by hand"
	eq "$(git rev-parse HEAD)" "$r" "by hand gives the same commits"
	run guard "$main"
	eq "$RUN_RC" 0 "guard by hand passes: $RUN_OUT"
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
	# And another clone of the same repositories, at another time of day.
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
	git rev-parse -q --verify refs/follow/candidate >/dev/null && bad "no candidate while waiting" || ok
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
	# npm's latest with no bump commit on the original's main.
	npm_set @router-for-me/pi-cliproxyapi-provider 1.6.0 "1.6.0 48"
	npm_set pi-provimux 105.0.1 "105.0.1 900"
	npm_done
	run select
	eq "$(state)" no-release-commit "no bump commit"
	has "$(field reason)" "0 commits" "says none"
	# Two bump commits to the same version.
	cd "$O"
	setver 1.6.0 && git add -A && commit "chore: bump version to 1.6.0"
	setver 1.5.9 && git add -A && commit "chore: oops"
	setver 1.6.0 && git add -A && commit "chore: bump version to 1.6.0 again"
	cd "$F"
	run prepare
	eq "$(state)" no-release-commit "two bump commits"
	has "$(field reason)" "2 commits" "says two"
	eq "$(field fork_published)" true "the fork's version is on the stub npm"
	# A minor the numbering cannot show.
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
	git rev-parse -q --verify refs/follow/candidate >/dev/null && bad "no candidate" || ok
	# By hand: merge leaves it, the owner resolves, stamp finishes.
	run merge
	eq "$RUN_RC" 3 "merge by hand stops"
	has "$(git diff --name-only --diff-filter=U)" extensions/index.ts "left in the work tree"
	printf 'line 1\nline 2 (both)\nline 3\n' >extensions/index.ts
	git add extensions/index.ts
	run stamp
	eq "$RUN_RC" 0 "stamp after resolving: $RUN_OUT"
	eq "$(jq -r .version package.json)" 105.1.1 "version"
	run guard "$main"
	eq "$RUN_RC" 0 "guard passes the hand merge: $RUN_OUT"
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

t_manifest_merge() {
	fresh manifest-merge
	cd "$O"
	jq --tab '.devDependencies.b = "2.1.0" | .devDependencies.c = "1.0.0" | .description = "changed upstream"' package.json >p &&
		mv p package.json
	jq --tab '.packages[""].devDependencies.b = "2.1.0" | .packages["node_modules/b"].version = "2.1.0"
		| .packages["node_modules/b"].integrity = "sha512-b2" | .packages["node_modules/b"].resolved = "https://registry.npmjs.org/b/-/b-2.1.0.tgz"' \
		package-lock.json >p && mv p package-lock.json
	git add -A && commit "chore: b 2.1.0, c"
	release 1.5.1
	jq --tab '.devDependencies.a = "1.0.1"' package.json >p && mv p package.json
	git add -A && commit "chore: a 1.0.1"
	run prepare
	eq "$(state)" candidate "state: $(field reasons) $(field conflicts)"
	local r
	r=$(field candidate)
	eq "$(git show "$r:package.json" | jq -c '.devDependencies')" '{"a":"1.0.1","b":"2.1.0","c":"1.0.0"}' "both sides' keys"
	eq "$(git show "$r:package.json" | jq -r '.description')" "the fork" "description is the fork's"
	eq "$(git show "$r:package-lock.json" | jq -r '.packages["node_modules/b"].version, .packages[""].devDependencies.b')" \
		"$(printf '2.1.0\n2.1.0')" "the lockfile takes the original's entry"
	eq "$(git show "$r:package.json" | head -c 1)$(git show "$r:package.json" | sed -n 2p | head -c 1)" "{	" "tabs kept"
}

# refused NAME SETUP…: the original makes a change in SETUP, releases 1.5.1; the guard must refuse with WANT.
refused() {
	local name=$1 want=$2
	shift 2
	fresh "refuse-$name"
	"$@"
	release 1.5.1
	run prepare
	eq "$(state)" refused "$name: state ($(field conflicts))"
	has "$(field reasons)" "$want" "$name: reason"
	if [[ -e $OUT/candidate.bundle ]]; then bad "$name: a bundle"; else ok; fi
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
o_installscript() {
	jq --tab '.packages["node_modules/b"].hasInstallScript = true' package-lock.json >p && mv p package-lock.json
	git add -A
	commit "chore: b runs a script"
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
	refused resolved 'is not on https://registry.npmjs.org/' o_resolved
	refused installscript 'a new install script' o_installscript
}

# Candidates made wrong after the merge: the guard checks what it is given, not what prepare made.
t_shape() {
	local main
	fresh shape
	change extensions/lib.ts 'export const x = 6;' "fix: x is 6"
	release 1.5.1
	main=$(git rev-parse HEAD)
	# The fork's own test changed in M.
	run merge
	printf 'weakened\n' >test/fork.test.ts
	git add -A
	GIT_COMMITTER_DATE="@$TICK +0000" git commit -q --amend --no-edit
	run stamp
	run guard "$main"
	eq "$RUN_RC" 4 "own test: exit 4"
	has "$RUN_OUT" 'the fork'\''s own test' "own test"
	# README changed in M.
	git reset -q --hard "$main"
	run merge
	printf 'other readme\n' >README.md
	git add -A
	git commit -q --amend --no-edit
	run stamp
	run guard "$main"
	has "$RUN_OUT" "README.md is not main's" "README"
	# R changes another file.
	git reset -q --hard "$main"
	run merge
	run stamp
	printf 'sneaky\n' >>extensions/lib.ts
	git add -A
	git commit -q --amend --no-edit
	run guard "$main"
	has "$RUN_OUT" 'shape: R changes' "R's files"
	# R changes more than the version in package.json.
	git reset -q --hard "$main"
	run merge
	run stamp
	jq --tab '.scripts.check = "true"' package.json >p && mv p package.json
	git add -A
	git commit -q --amend --no-edit
	run guard "$main"
	has "$RUN_OUT" 'shape: R changes more than the version in package.json' "R's package.json"
	# A wrong version.
	git reset -q --hard "$main"
	run merge
	run stamp
	setver 105.1.2
	git add -A
	git commit -q --amend --no-edit
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
	# And when both changed the README: no conflict, still the fork's.
	fresh readme-both
	change README.md "$(printf '# The original\n\nInstall: something else\n')" "docs: install"
	release 1.5.1
	change README.md "$(printf '# pi-provimux\n\nInstall: npm:pi-provimux, now with more\n')" "docs: the fork's install"
	run prepare
	eq "$(state)" candidate "both changed README: state"
	eq "$(git show "$(field candidate):README.md")" "$(git show HEAD:README.md)" "both changed README: the fork's"
}

# A stub gh: records every call; answers "issue list" from $T/gh/issues.json.
gh_stub() {
	mkdir -p "$T/gh/bin"
	cat >"$T/gh/bin/gh" <<-'SH'
		#!/usr/bin/env bash
		echo "$*" >>"$GH_LOG"
		case "$1 $2" in
		"issue list") if [[ " $* " == *" --state open "* ]]; then jq '[.[] | select(.state == "OPEN")]' "$GH_ISSUES"; else cat "$GH_ISSUES"; fi ;;
		"issue create")
			t=''; b=''
			while [[ $# -gt 0 ]]; do case $1 in --title) t=$2; shift ;; --body-file) b=$(cat "$2"); shift ;; esac; shift; done
			jq --arg t "$t" --arg b "$b" '. + [{number: (length + 1), title: $t, body: $b, state: "OPEN"}]' "$GH_ISSUES" >"$GH_ISSUES.t"
			mv "$GH_ISSUES.t" "$GH_ISSUES" ;;
		"issue edit")
			n=$3; t=''; b=''
			while [[ $# -gt 0 ]]; do case $1 in --title) t=$2; shift ;; --body-file) b=$(cat "$2"); shift ;; esac; shift; done
			jq --argjson n "$n" --arg t "$t" --arg b "$b" 'map(if .number == $n then .title = $t | .body = $b else . end)' "$GH_ISSUES" >"$GH_ISSUES.t"
			mv "$GH_ISSUES.t" "$GH_ISSUES" ;;
		"issue close")
			jq --argjson n "$3" 'map(if .number == $n then .state = "CLOSED" else . end)' "$GH_ISSUES" >"$GH_ISSUES.t"
			mv "$GH_ISSUES.t" "$GH_ISSUES" ;;
		esac
	SH
	chmod +x "$T/gh/bin/gh"
	echo '[]' >"$T/gh/issues.json"
	: >"$T/gh/log"
	export GH_LOG=$T/gh/log GH_ISSUES=$T/gh/issues.json
}
gh_run() { PATH="$T/gh/bin:$PATH" run "$@"; }

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
	has "$(jq -r '.[] | select(.title | startswith("README:")) | .body' "$GH_ISSUES")" "+readme of 1.5.1" "the README diff, from the result"
	eq "$(jq -r '.[] | .title' "$GH_ISSUES" | sort | tr '\n' '|')" "README: after 1.5.1|follow: 1.5.1 — conflict|" "two issues"
	has "$(jq -r '.[] | select(.title | startswith("follow:")) | .body' "$GH_ISSUES")" "follow.sh merge 1.5.1" "how to merge by hand"
	: >"$GH_LOG"
	gh_run report
	eq "$(grep -c '^issue create' "$GH_LOG" || true)" 0 "a rerun opens nothing"
	eq "$(grep -c '^issue comment' "$GH_LOG" || true)" 0 "the same state: no comment"
	# A refusal now: the same issue, a new title, one comment.
	jq '.state = "refused" | .reasons = ["path: the original changes `LICENSE`"]' "$OUT/result.json" >"$OUT/r" && mv "$OUT/r" "$OUT/result.json"
	gh_run report
	eq "$(jq -r '[.[] | select(.title | startswith("follow:"))] | length' "$GH_ISSUES")" 1 "still one issue"
	eq "$(jq -r '.[] | select(.title | startswith("follow:")) | .title' "$GH_ISSUES")" "follow: 1.5.1 — refused" "new title"
	eq "$(grep -c '^issue comment' "$GH_LOG" || true)" 1 "one comment for the change"
	# Check failed, with the steps.
	printf 'npm run check\n' >"$T/steps"
	printf 'FAIL test/x.test.ts ~~~~\n' >"$T/log"
	jq '.state = "candidate" | .candidate = "abc"' "$OUT/result.json" >"$OUT/r" && mv "$OUT/r" "$OUT/result.json"
	FOLLOW_TEST_CANDIDATE=failure FOLLOW_TEST_ORIGINAL=success FOLLOW_FAILED_STEPS=$T/steps FOLLOW_FAILED_LOG=$T/log gh_run report
	eq "$RUN_RC" 1 "check failed is red"
	has "$(jq -r '.[] | select(.title | startswith("follow:")) | .body' "$GH_ISSUES")" "~~~~~" "the log in a longer fence"
	eq "$(jq -r '.[] | select(.title | startswith("follow:")) | .title' "$GH_ISSUES")" "follow: 1.5.1 — check failed" "title"
	# Passed in a dry run: green, the issue stays.
	FOLLOW_TEST_CANDIDATE=success FOLLOW_LAND=dry-run gh_run report
	eq "$RUN_RC" 0 "a dry-run pass is green"
	FOLLOW_TEST_CANDIDATE=success FOLLOW_LAND=failure gh_run report
	eq "$(jq -r '.[] | select(.title | startswith("follow:")) | .title' "$GH_ISSUES")" "follow: 1.5.1 — land failed" "land failed"
	# Landed, then up to date and published: closed.
	FOLLOW_TEST_CANDIDATE=success FOLLOW_LAND=landed gh_run report
	eq "$(jq -r '.[] | select(.title | startswith("follow:")) | .title' "$GH_ISSUES")" "follow: 1.5.1 — landed" "landed"
	jq '.state = "up-to-date" | .base_version = "1.5.1" | .fork_published = "true" | .fork_version = "105.1.1"' "$OUT/result.json" >"$OUT/r" &&
		mv "$OUT/r" "$OUT/result.json"
	gh_run report
	eq "$RUN_RC" 0 "up to date is green"
	eq "$(jq -r '.[] | select(.title | startswith("follow:")) | .state' "$GH_ISSUES")" CLOSED "closed"
	eq "$(jq -r '.[] | select(.title | startswith("README:")) | .state' "$GH_ISSUES")" OPEN "the README issue stays for the owner"
	# The publish issue.
	gh_run report-publish 105.1.1 "plan success, test success, publish failure"
	eq "$RUN_RC" 1 "a failed publish is red"
	eq "$(jq -r '.[] | select(.title | startswith("publish:")) | .title' "$GH_ISSUES")" "publish: 105.1.1 — failed" "publish issue"
	gh_run report-publish 105.1.1 success
	eq "$(jq -r '.[] | select(.title | startswith("publish:")) | .state' "$GH_ISSUES")" CLOSED "closed after a publish"
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
	# Refusals.
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
	run plan
	eq "$RUN_RC" 4 "refused"
	has "$RUN_OUT" ".npmrc: the tree has one" ".npmrc"
}

# --- run ----------------------------------------------------------------------------------------------------------
build_fixture >/dev/null
ALL='numbers clean rerun waiting states conflict manifest_conflict manifest_merge refusals shape readme report plan'
[[ $# -gt 0 ]] || set -- $ALL
for t in "$@"; do
	echo "- $t"
	"t_$t"
done
echo "follow tests: $PASS passed, $FAIL failed"
((FAIL == 0))
