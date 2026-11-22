#!/usr/bin/env bash
# shellcheck disable=SC2016 # jq programs and Markdown in single quotes: their $ and ` are not the shell's
# Following the original (docs/FOLLOWING.md). What follow.yml, publish.yml and the owner's Mac run.
# Bash 3.2 (macOS) and later; needs git, jq, node and npm; gh for the commands that write to GitHub.
#
#   follow.sh select [VERSION] [--no-wait]  which release of the original to take now, and why (2.1, 2.2)
#   follow.sh merge [VERSION]               merges its bump commit into HEAD by the rules of 2.5; commits M when
#                                           clean, else leaves the conflict in the work tree (exit 3)
#   follow.sh stamp                         commits M if a merge is in progress, then R (the version and the
#                                           changelog entry, 3), then runs the guard: exit 4 = refused, do not push
#   follow.sh guard [MAIN] [R]              the guard of 2.6 on the candidate MAIN..R (default: the merge's main,
#                                           HEAD); exit 4 with the reasons when it refuses
#   follow.sh report                        writes the owner's issue from a run's result (2.7); reads
#                                           FOLLOW_RESULT (default the result file), FOLLOW_TEST_CANDIDATE and
#                                           FOLLOW_TEST_ORIGINAL (a job's result), FOLLOW_LAND (what land did, or
#                                           a job's result), FOLLOW_FAILED_STEPS and FOLLOW_FAILED_LOG (files),
#                                           RUN_URL; exit 1 for the states the owner must see, or a failed write
#   follow.sh report-publish VERSION RESULT the issue of a failed publish, or closes it once npm has VERSION (4.3)
#
# For the workflows:
#   follow.sh prepare                       select, the guard on git objects, then merge, stamp and guard in a
#                                           temporary worktree; the candidate as a git bundle
#   follow.sh fetch-candidate ID DIGEST     prepare's artifact by its id and digest; fetches the candidate
#   follow.sh recheck MAIN R                the guard and the release binding again, on what land is given
#   follow.sh land STATE MAIN [R]           checks, pushes R to main without force, starts publish.yml (DRY_RUN)
#   follow.sh plan                          publish.yml's publish guard (4.2) on HEAD
#   follow.sh tag VERSION SHA PUBLISHED     publish.yml's tag v<VERSION> and GitHub release (DRY_RUN)
#
# The scripts that merge are run from outside the tree they merge (merge and stamp refuse otherwise).
# The state of a run is $FOLLOW_OUT/result.json (default <git dir>/follow/result.json); exit codes: 0 done (look at
# the state), 1 an error, 3 a conflict, 4 a refusal.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
ORIGINAL_URL=${FOLLOW_ORIGINAL_URL:-https://github.com/router-for-me/pi-cliproxyapi-provider.git}
ORIGINAL_PKG=${FOLLOW_ORIGINAL_PKG:-@router-for-me/pi-cliproxyapi-provider}
ORIGINAL_NAME=pi-cliproxyapi-provider
PKG=${FOLLOW_PKG:-pi-provimux}
REPO=${FOLLOW_REPO:-${GITHUB_REPOSITORY:-ngvoicu/pi-provimux}}
UPSTREAM_URL=${FOLLOW_UPSTREAM_URL:-https://github.com/$REPO.git}
REGISTRY=https://registry.npmjs.org/
WAIT_HOURS=${FOLLOW_WAIT_HOURS:-24}
LABEL=${FOLLOW_LABEL:-follow-bot}
BOT_LOGINS=${FOLLOW_BOT_LOGINS:-github-actions[bot]}
ORIGINAL_REF=refs/follow/original
CANDIDATE_REF=refs/follow/candidate
BOT_NAME='github-actions[bot]'
BOT_EMAIL='41898282+github-actions[bot]@users.noreply.github.com'
# A plain version: at most six digits a part, so that every number stays far inside Bash's and npm's range.
PLAIN_RE='^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$'
R_FILES='CHANGELOG.md package-lock.json package.json'
WRITTEN='README.md package.json package-lock.json CHANGELOG.md'
PACK_FILES='CHANGELOG.md LICENSE README.md package.json'
LIFECYCLE='preinstall install postinstall prepublish prepare prepublishOnly prepack postpack publish postpublish'

die() {
	echo "follow: $*" >&2
	exit 1
}
say() { echo "follow: $*"; }

# Untrusted text never becomes a runner command: everything this script prints is shown as text. The runner reads
# commands from both streams; the two markers go to standard error, so that standard output carries only what a
# command prints for its caller (fetch-candidate: the commit, nothing else).
STOP=''
if [[ ${GITHUB_ACTIONS:-} == true ]]; then
	STOP=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
	echo "::stop-commands::$STOP" >&2
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/follow.XXXXXX")
WORKTREE=''
cleanup() {
	if [[ -n $WORKTREE ]]; then git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true; fi
	rm -rf "${TMP:?}"
	if [[ -n $STOP ]]; then echo "::$STOP::" >&2; fi
}
trap cleanup EXIT

git rev-parse --git-dir >/dev/null 2>&1 || die "not in a git repository"
OUT=${FOLLOW_OUT:-$(git rev-parse --path-format=absolute --git-common-dir)/follow}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
RES=$OUT/result.json

[[ $WAIT_HOURS =~ ^[0-9]{1,4}$ ]] || die "FOLLOW_WAIT_HOURS is not a number of hours"
[[ -z ${FOLLOW_NOW:-} || $FOLLOW_NOW =~ ^[0-9]{1,12}$ ]] || die "FOLLOW_NOW is not a time in seconds"

# run_rc CMD…: runs CMD in a subshell with -e in force (a function called as `f || rc=$?` runs without it) and
# leaves its exit code in RC.
RC=0
run_rc() {
	set +e
	(
		set -e
		"$@"
	)
	RC=$?
	set -e
}

# git without the user's hooks, signing, recorded resolutions or attributes from outside: the same inputs give the
# same commits.
gitc() { git -c core.hooksPath=/dev/null -c commit.gpgsign=false -c rerere.enabled=false -c core.attributesFile=/dev/null "$@"; }

# Text from upstream, for a message: letters, digits and . _ + - only, at most 64 characters.
shown() { printf '%s' "$1" | LC_ALL=C tr -c 'A-Za-z0-9._+-' '?' | cut -c1-64; }

# --- the result file --------------------------------------------------------------------------------------------
res_init() { jq -n '{}' >"$RES"; }
res_set() { jq --arg k "$1" --arg v "$2" '.[$k] = $v' "$RES" >"$RES.tmp" && mv "$RES.tmp" "$RES"; }
res_json() { jq --arg k "$1" --argjson v "$2" '.[$k] = $v' "$RES" >"$RES.tmp" && mv "$RES.tmp" "$RES"; }
res_add() { jq --arg k "$1" --arg v "$2" '.[$k] = ((.[$k] // []) + [$v])' "$RES" >"$RES.tmp" && mv "$RES.tmp" "$RES"; }
res_get() { jq -r --arg k "$1" '.[$k] // "" | if type == "array" then .[] else tostring end' "$RES"; }

# A step output for GitHub Actions (any value, several lines too).
gh_out() {
	[[ -n ${GITHUB_OUTPUT:-} ]] || return 0
	local d="FOLLOW_EOF_$RANDOM$RANDOM"
	{
		echo "$1<<$d"
		printf '%s\n' "$2"
		echo "$d"
	} >>"$GITHUB_OUTPUT"
}

# --- versions ---------------------------------------------------------------------------------------------------
is_plain() { [[ $1 =~ $PLAIN_RE ]]; }

# Only checked plain versions reach arithmetic.
parts() {
	is_plain "$1" || die "internal: '$(shown "$1")' is not a plain version"
	IFS=. read -r P0 P1 P2 <<<"$1"
	P0=$((10#$P0)) P1=$((10#$P1)) P2=$((10#$P2))
}

# ver_cmp A B: -1, 0 or 1.
ver_cmp() {
	local a0 a1 a2
	parts "$1"
	a0=$P0 a1=$P1 a2=$P2
	parts "$2"
	if ((a0 != P0)); then
		if ((a0 > P0)); then echo 1; else echo -1; fi
	elif ((a1 != P1)); then
		if ((a1 > P1)); then echo 1; else echo -1; fi
	elif ((a2 != P2)); then
		if ((a2 > P2)); then echo 1; else echo -1; fi
	else
		echo 0
	fi
}

# encode 1.5.0 → 105.0 (3.1); fails when the minor is 100 or more, or the version is not plain.
encode() {
	is_plain "$1" || return 1
	parts "$1"
	((P1 < 100)) || return 1
	echo "$((P0 * 100 + P1)).$P2"
}

# decode 105.0.3 → 1.5.0; fails for a number that is not of the form of 3.1.
decode() {
	is_plain "$1" || return 1
	parts "$1"
	((P0 >= 100 && P2 >= 1)) || return 1
	echo "$((P0 / 100)).$((P0 % 100)).$P1"
}

ISO_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$'
iso_epoch() {
	local e
	[[ $1 =~ $ISO_RE ]] || return 1
	e=$(jq -rn --arg t "$1" '$t | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601') || return 1
	[[ $e =~ ^[0-9]{1,12}$ ]] || return 1
	echo "$e"
}
epoch_iso() { jq -rn --argjson e "$1" '$e | todate'; }

# A version from upstream, as a single token: itself when it is made of [0-9A-Za-z.+-] (1 to 64), else "!".
JQ_VER='def ver: if type == "string" and test("^[0-9A-Za-z.+-]{1,64}$") then . else "!" end;'

# The version in COMMIT:package.json: a token as above, or nothing when there is no version.
version_of() {
	git cat-file blob "$1:package.json" 2>/dev/null |
		jq -r "$JQ_VER"' if type == "object" and has("version") then (.version | ver) else "" end' 2>/dev/null || true
}

# bumps_on REF: "commit version" for every bump commit on REF's first-parent history, newest first: the commits
# whose package.json names a version their first parent's does not. Each field is one token: a 40-hex commit, and
# a version token ("!" for anything that is not one).
bumps_on() {
	git rev-list --first-parent "$1" >"$TMP/fp"
	sed 's/$/:package.json/' "$TMP/fp" | git cat-file --batch-check='%(objectname)' >"$TMP/fpb"
	local b v
	grep -E '^[0-9a-f]{40}$' "$TMP/fpb" | sort -u | while read -r b; do
		v=$(git cat-file blob "$b" | jq -r "$JQ_VER"' if type == "object" and has("version") then (.version | ver) else "-" end' 2>/dev/null || echo '!')
		[[ $v =~ ^[0-9A-Za-z.+!-]{1,64}$ ]] || v='!'
		printf '%s %s\n' "$b" "$v"
	done >"$TMP/bv"
	paste -d' ' "$TMP/fp" "$TMP/fpb" |
		awk 'NR == FNR { v[$1] = $2; next } NF == 2 { print $1, (($2 in v) ? v[$2] : "-"); next } { print $1, "-" }' "$TMP/bv" - |
		awk '{ c[NR] = $1; v[NR] = $2 } END { for (i = 1; i <= NR; i++) if (v[i] != "-" && v[i] != v[i + 1]) print c[i], v[i] }'
}

# old_base MAIN BUMPS_FILE: "commit version" of the newest bump commit that is an ancestor of MAIN, its version read
# back from the commit and plain.
old_base() {
	local c v
	while read -r c v; do
		if git merge-base --is-ancestor "$c" "$1"; then
			v=$(version_of "$c")
			is_plain "$v" || return 1
			echo "$c $v"
			return 0
		fi
	done <"$2"
	return 1
}

# --- npm ---------------------------------------------------------------------------------------------------------
# npm, from a neutral folder, with no user or global configuration, against the public registry.
npm_neutral() {
	mkdir -p "$TMP/npm"
	: >"$TMP/npm/user-npmrc"
	: >"$TMP/npm/global-npmrc"
	(cd "$TMP/npm" && npm_config_userconfig="$TMP/npm/user-npmrc" npm_config_globalconfig="$TMP/npm/global-npmrc" \
		npm "$@" --registry="$REGISTRY")
}

# FOLLOW_NPM_DIR (the tests) names a folder of stub registry data: <pkg>.json ({"dist-tags", "time"}) and
# <pkg>@<version>.dist.json ({"tarball": a file path, "integrity"}), "/" and "@" in names read as "_".
stub() { printf '%s/%s%s' "$FOLLOW_NPM_DIR" "$(printf %s "$1" | tr '/@' '__')" "$2"; }

# npm_json ARGS…: npm view … --json; {} when the registry says 404; an error otherwise.
npm_json() {
	local out rc=0
	out=$(npm_neutral view "$@" --json 2>/dev/null) || rc=$?
	if ((rc == 0)) && jq -e 'type == "object"' >/dev/null 2>&1 <<<"$out"; then
		printf '%s\n' "$out"
	elif jq -e '.error.code == "E404"' >/dev/null 2>&1 <<<"$out"; then
		echo '{}'
	else
		die "npm view $(shown "$1") failed (exit $rc)"
	fi
}

# npm_meta PKG: {"dist-tags": …, "time": …}, {} when the package does not exist.
npm_meta() {
	if [[ -n ${FOLLOW_NPM_DIR:-} ]]; then
		if [[ -f $(stub "$1" .json) ]]; then cat "$(stub "$1" .json)"; else echo '{}'; fi
		return 0
	fi
	npm_json "$1" dist-tags time
}

# npm_dist PKG VERSION: {"tarball", "integrity"} of that version, {} when npm lacks it.
npm_dist() {
	if [[ -n ${FOLLOW_NPM_DIR:-} ]]; then
		if [[ -f $(stub "$1" "@$2.dist.json") ]]; then cat "$(stub "$1" "@$2.dist.json")"; else echo '{}'; fi
		return 0
	fi
	npm_json "$1@$2" dist | jq -c '{tarball: (.tarball // ""), integrity: (.integrity // "")}'
}

# npm_githead PKG VERSION: the commit npm recorded for it, or nothing.
npm_githead() {
	if [[ -n ${FOLLOW_NPM_DIR:-} ]]; then
		if [[ -f $(stub "$1" "@$2.githead") ]]; then cat "$(stub "$1" "@$2.githead")"; fi
		return 0
	fi
	npm_json "$1@$2" gitHead version | jq -r '.gitHead // ""'
}

# ships_of COMMIT: the files npm packs from COMMIT's tree, sorted, in $TMP/ships. The tree's regular files are
# written out (links and submodules are not) and npm lists them with --dry-run --ignore-scripts from a neutral
# folder: nothing of the commit runs. Exit 4 when npm cannot pack it, 1 when the export fails.
ships_of() {
	rm -rf "${TMP:?}/ships.tree"
	node "$HERE/tarball.mjs" export "$1" "$TMP/ships.tree" || return 1
	if ! npm_neutral pack --dry-run --ignore-scripts --json "$TMP/ships.tree" >"$TMP/ships.json" 2>"$TMP/ships.err"; then
		echo "release: npm cannot pack the commit $1"
		return 4
	fi
	jq -r '.[0].files[].path' "$TMP/ships.json" | LC_ALL=C sort >"$TMP/ships" || return 1
}

# release_matches V B: the registry's tarball of V is what npm says it is, and it ships exactly the files npm packs
# from B, each with B's bytes (2.1): a file either side lacks is a mismatch. Prints the differences; exit 0 a match,
# 4 a mismatch, 1 the registry or the check failed.
release_matches() {
	local v=$1 b=$2 dist url integ rc=0
	dist=$(npm_dist "$ORIGINAL_PKG" "$v")
	url=$(jq -r '.tarball // ""' <<<"$dist")
	integ=$(jq -r '.integrity // ""' <<<"$dist")
	if [[ -z $url ]]; then
		echo "release: npm gives no tarball for $v"
		return 4
	fi
	rm -f "$TMP/release.tgz"
	if [[ -n ${FOLLOW_NPM_DIR:-} ]]; then
		cp "$url" "$TMP/release.tgz" || return 1
	else
		[[ $url =~ ^https://registry\.npmjs\.org/[A-Za-z0-9@%._/-]+\.tgz$ ]] || {
			echo "release: the tarball of $v is not on $REGISTRY"
			return 4
		}
		curl -sSf --proto =https --max-filesize 67108864 -o "$TMP/release.tgz" "$url" || return 1
	fi
	node "$HERE/tarball.mjs" verify "$TMP/release.tgz" "$integ" || rc=$?
	((rc == 0)) || return "$rc"
	ships_of "$b" || return $?
	node "$HERE/tarball.mjs" compare "$TMP/release.tgz" "$b" "$TMP/ships" || rc=$?
	return "$rc"
}

fetch_original() {
	if [[ ${FOLLOW_NO_FETCH:-} == 1 ]]; then
		git rev-parse -q --verify "$ORIGINAL_REF^{commit}" >/dev/null || die "no $ORIGINAL_REF and FOLLOW_NO_FETCH=1"
		return 0
	fi
	git fetch -q --no-tags "$ORIGINAL_URL" "+refs/heads/main:$ORIGINAL_REF" || die "cannot fetch the original's main"
}

# --- select ------------------------------------------------------------------------------------------------------
finish_select() {
	res_set state "$1"
	res_set reason "$2"
	say "$1: $2"
}

do_select() {
	local want=$1 nowait=$2 main meta latest v ob obc obline count b pub pube age ready fork fmeta rc
	main=$(git rev-parse --verify "${FOLLOW_MAIN:-HEAD}^{commit}") || die "no main"
	res_init
	res_set main "$main"
	fork=$(version_of "$main")
	res_set fork_version "$fork"
	fmeta=$(npm_meta "$PKG")
	if jq -e --arg v "$fork" '(.time // {}) | has($v)' >/dev/null <<<"$fmeta"; then
		res_set fork_published true
	else
		res_set fork_published false
	fi
	# The version asked for is checked before it is used or shown.
	if [[ -n $want ]] && ! is_plain "$want"; then
		finish_select no-release-commit "the version asked for is not a plain X.Y.Z"
		return 0
	fi
	fetch_original
	res_set original "$(git rev-parse "$ORIGINAL_REF")"

	bumps_on "$ORIGINAL_REF" >"$OUT/bumps.txt"
	obline=$(old_base "$main" "$OUT/bumps.txt") || {
		finish_select error "main has no release of the original with a plain version"
		return 0
	}
	obc=${obline%% *}
	ob=${obline#* }
	res_set base_commit "$obc"
	res_set base_version "$ob"

	meta=$(npm_meta "$ORIGINAL_PKG")
	latest=$(jq -r '(."dist-tags" // {}).latest // "" | tostring' <<<"$meta")
	v=${want:-$latest}
	if ! is_plain "$v"; then
		finish_select no-release-commit "npm's latest ($(shown "$v")) is not a plain X.Y.Z"
		return 0
	fi
	res_set version "$v"
	pub=$(jq -r --arg v "$v" '(.time // {})[$v] // "" | tostring' <<<"$meta")
	if ! pube=$(iso_epoch "$pub"); then
		finish_select no-release-commit "$v has no publish time on npm"
		return 0
	fi
	res_set published_at "$pub"
	if [[ $(ver_cmp "$v" "$ob") != 1 ]]; then
		if [[ $v == "$ob" ]]; then
			finish_select up-to-date "main is built on $ob, npm's $v"
		else
			finish_select not-newer "$v is not newer than $ob, the release main is built on"
		fi
		return 0
	fi
	count=$(awk -v v="$v" '$2 == v' "$OUT/bumps.txt" | wc -l | tr -d ' ')
	if [[ $count != 1 ]]; then
		finish_select no-release-commit "$count commits on the original's main set the version $v (one is needed)"
		return 0
	fi
	b=$(awk -v v="$v" '$2 == v { print $1 }' "$OUT/bumps.txt")
	res_set bump "$b"
	if git merge-base --is-ancestor "$b" "$main"; then
		finish_select up-to-date "$v ($b) is in main"
		return 0
	fi
	if ! encode "$v" >/dev/null; then
		finish_select refused "$v has a minor of 100 or more, which the numbering cannot show (docs/FOLLOWING.md 3.1)"
		return 0
	fi
	res_set new_version "$(encode "$v").1"
	age=$((${FOLLOW_NOW:-$(date +%s)} - pube))
	ready=$((pube + WAIT_HOURS * 3600))
	res_set ready_at "$(epoch_iso "$ready")"
	if [[ $nowait != true ]] && ((age < WAIT_HOURS * 3600)); then
		finish_select waiting "$v was published $pub; it is taken from $(epoch_iso "$ready")"
		return 0
	fi
	# The commit is the release npm ships: its tarball, file by file (2.1).
	rc=0
	release_matches "$v" "$b" >"$TMP/release.txt" || rc=$?
	case $rc in
	0) ;;
	4)
		res_json reasons "$(jq -R . <"$TMP/release.txt" | jq -s .)"
		finish_select refused "npm's $v is not its bump commit $b"
		return 0
		;;
	*)
		finish_select error "the release $v could not be read from npm and checked"
		return 0
		;;
	esac
	finish_select take "$v ($b), on top of $ob"
}

cmd_select() {
	local want='' nowait=${FOLLOW_NO_WAIT:-false} a
	for a in "$@"; do
		case $a in
		--no-wait) nowait=true ;;
		-*) die "select: unknown option" ;;
		*) want=$a ;;
		esac
	done
	do_select "${want:-${FOLLOW_VERSION:-}}" "$nowait"
	select_outputs
}

select_outputs() {
	local k
	for k in state reason version bump base_version new_version ready_at fork_version fork_published; do
		gh_out "$k" "$(res_get "$k")"
	done
}

# --- paths -------------------------------------------------------------------------------------------------------
# Names refused at any depth, whatever paths.txt says: package, git and check configuration.
denied() {
	local base=${1##*/}
	case $base in
	.npmrc | .npmignore | .gitattributes | .gitignore | .gitmodules | .yarnrc | .yarnrc.yml | .pnpmfile.cjs) return 0 ;;
	tsconfig*.json | jsconfig*.json | biome.json | biome.jsonc | .biome.json | vitest.config.* | vitest.workspace.* | vite.config.*) return 0 ;;
	esac
	case $1 in .github/* | .forgejo/* | docs/*) return 0 ;; esac
	return 1
}

# The exact paths of paths.txt; a line with a wildcard is ignored.
path_allowed() {
	local p=$1 pat
	denied "$p" && return 1
	while IFS= read -r pat || [[ -n $pat ]]; do
		pat=${pat%%#*}
		pat=$(printf '%s' "$pat" | tr -d '[:space:]')
		[[ -n $pat && $pat != *'*'* && $pat != *'?'* ]] || continue
		[[ $p == "$pat" ]] && return 0
	done <"$HERE/paths.txt"
	return 1
}

refuse() { printf '%s\n' "$1" >>"$TMP/reasons"; }

# A path from git, for a message: as git quotes it (core.quotePath), cut to 200 characters.
qpath() { printf '%s' "$1" | LC_ALL=C tr -d '\000-\037\177' | cut -c1-200; }

# path_check FROM TO [MAIN M]: git objects only, before anything is written. Every path the original changed
# between FROM and TO is on the list and not denied, and is a regular file there; what M changes on MAIN likewise;
# the files the merge writes are regular files on both sides.
path_check() {
	local from=$1 to=$2 main=${3:-} m=${4:-} p mode
	{
		git -c core.quotePath=true diff --name-only --no-renames "$from" "$to"
		if [[ -n $m ]]; then git -c core.quotePath=true diff --name-only --no-renames "$main" "$m"; fi
	} | sort -u >"$TMP/paths"
	while IFS= read -r p; do
		if denied "$p"; then
			refuse "path: the original changes \`$(qpath "$p")\` (package, git or check configuration)"
		elif ! path_allowed "$p"; then
			refuse "path: the original changes \`$(qpath "$p")\`, which is not in .github/follow/paths.txt"
		fi
	done <"$TMP/paths"
	git -c core.quotePath=true diff --raw --no-renames "$from" "$to" |
		awk '$2 !~ /^(100644|100755|000000)$/ { sub(/^[^\t]*\t/, ""); print }' >"$TMP/modes"
	while IFS= read -r p; do refuse "path: \`$(qpath "$p")\` becomes a symbolic link, a submodule or another non-file"; done <"$TMP/modes"
	for p in $WRITTEN; do
		for c in "$to" ${main:+"$main"}; do
			mode=$(git ls-tree "$c" -- "$p" | awk '{ print $1 }')
			[[ -z $mode || $mode == 100644 || $mode == 100755 ]] || refuse "path: \`$p\` is not a regular file in $c"
		done
	done
}

# run_check CMD…: a checker that prints refusals and exits 0 (none) or 4 (some); anything else is an error.
run_check() {
	local rc=0
	"$@" >>"$TMP/reasons" || rc=$?
	case $rc in
	0 | 4) ;;
	*) die "a check failed to run (exit $rc): $(shown "${3:-$2}")" ;;
	esac
}

# --- merge -------------------------------------------------------------------------------------------------------
bot_env() {
	local d
	d=$(git log -1 --format=%cI "$1")
	export GIT_AUTHOR_NAME=$BOT_NAME GIT_AUTHOR_EMAIL=$BOT_EMAIL GIT_COMMITTER_NAME=$BOT_NAME
	export GIT_COMMITTER_EMAIL=$BOT_EMAIL GIT_AUTHOR_DATE=$d GIT_COMMITTER_DATE=$d
}

merge_msg() { echo "Merge $ORIGINAL_NAME $1"; }

# blob_to COMMIT PATH FILE: the file at COMMIT, or an empty file.
blob_to() { git cat-file blob "$1:$2" >"$3" 2>/dev/null || : >"$3"; }

# The tools that merge must not be part of the tree they merge.
outside_tree() {
	local top
	top=$(git rev-parse --show-toplevel 2>/dev/null) || return 0
	top=$(cd "$top" && pwd -P)
	case "$HERE/" in "$top"/*)
		die "run these scripts from outside the tree they merge: cp -R .github/follow /tmp/follow-tools, then /tmp/follow-tools/follow.sh …"
		;;
	esac
}

# No file the merge writes may be a link in the work tree.
no_links() {
	local f
	for f in $WRITTEN; do
		[[ ! -L $f ]] || die "$f is a symbolic link in the work tree; nothing is written"
	done
}

do_merge() {
	local b=$1 v=$2 obc=$3 main rc=0 f kind line
	main=$(git rev-parse HEAD)
	res_set main "$main"
	bot_env "$b"
	gitc merge --no-ff --no-commit --no-edit "$b" >"$TMP/merge.log" 2>&1 || rc=$?
	if [[ ! -e $(git rev-parse --git-path MERGE_HEAD) ]]; then
		sed 's/^/  /' "$TMP/merge.log" | head -n 20 >&2
		die "git merge did not start (exit $rc)"
	fi
	no_links
	res_json conflicts '[]'

	# README.md is the fork's, byte for byte.
	if git cat-file -e "$main:README.md" 2>/dev/null; then
		git checkout -q "$main" -- README.md
	elif git ls-files --error-unmatch README.md >/dev/null 2>&1; then
		git rm -q -f README.md
	fi
	if git diff --quiet "$obc" "$b" -- README.md; then
		res_set readme_changed false
	else
		res_set readme_changed true
		git diff "$obc" "$b" -- README.md >"$OUT/readme.diff"
		res_set readme_diff "$(head -c 40000 "$OUT/readme.diff")"
	fi

	# package.json and package-lock.json by rule.
	for f in package.json package-lock.json; do
		kind=package
		[[ $f == package.json ]] || kind=lock
		if ! git cat-file -e "$main:$f" 2>/dev/null && ! git cat-file -e "$b:$f" 2>/dev/null; then continue; fi
		blob_to "$obc" "$f" "$TMP/base.json"
		blob_to "$main" "$f" "$TMP/ours.json"
		blob_to "$b" "$f" "$TMP/theirs.json"
		rc=0
		node "$HERE/manifest.mjs" merge "$kind" "$TMP/base.json" "$TMP/ours.json" "$TMP/theirs.json" "$TMP/merged.json" >"$TMP/mc" || rc=$?
		case $rc in
		0) ;;
		3) while IFS= read -r line; do res_add conflicts "$line"; done <"$TMP/mc" ;;
		*) die "manifest.mjs merge $f failed" ;;
		esac
		no_links
		cat "$TMP/merged.json" >"$f"
		git add -- "$f"
	done

	git -c core.quotePath=true diff --name-only --diff-filter=U >"$TMP/unmerged"
	while IFS= read -r f; do res_add conflicts "$(qpath "$f")"; done <"$TMP/unmerged"
	if [[ -n $(res_get conflicts) ]]; then
		res_set state conflict
		res_set reason "merging $v conflicts"
		say "conflict merging $v:"
		res_get conflicts | head -n 50 | sed 's/^/  /'
		return 3
	fi
	gitc commit -q --no-verify -m "$(merge_msg "$v")"
	res_set merge "$(git rev-parse HEAD)"
	say "merged $v ($b): $(git rev-parse --short HEAD)"
}

# pre_merge: the guard on git objects, before the merge touches the work tree. Refusal: state refused.
pre_merge() {
	: >"$TMP/reasons"
	path_check "$(res_get base_commit)" "$(res_get bump)" "$(res_get main)"
	if [[ -s $TMP/reasons ]]; then
		res_json reasons "$(jq -R . <"$TMP/reasons" | jq -s .)"
		res_set state refused
		res_set reason "the guard refuses the release before merging it"
		say "refused before merging:"
		head -n 50 "$TMP/reasons" | sed 's/^/  /'
		return 4
	fi
}

cmd_merge() {
	local want=${1:-} state
	outside_tree
	[[ -z $(git status --porcelain --untracked-files=no) ]] || die "the work tree has changes; commit or put them aside first"
	[[ ! -e $(git rev-parse --git-path MERGE_HEAD) ]] || die "a merge is already in progress"
	FOLLOW_MAIN=HEAD do_select "$want" true
	state=$(res_get state)
	case $state in
	take) ;;
	up-to-date) return 0 ;;
	refused)
		res_get reasons | head -n 50 | sed 's/^/  /'
		return 4
		;;
	*) die "nothing to merge: $state, $(res_get reason)" ;;
	esac
	pre_merge
	do_merge "$(res_get bump)" "$(res_get version)" "$(res_get base_commit)"
}

# --- stamp -------------------------------------------------------------------------------------------------------
# Markdown-safe one-line list item: the original's text, shown and never evaluated.
md_item() {
	LC_ALL=C tr -d '\000-\011\013-\037\177' | LC_ALL=C sed -e 's/[]\\`*_[<>&~|#@!]/\\&/g' -e 's/^\([-+]\)/\\\1/' -e 's/^/- /'
}

changelog_entry() {
	local new=$1 v=$2 obc=$3 b=$4 c n=0
	printf '## %s\n\nFrom %s `%s` (merged automatically):\n\n' "$new" "$ORIGINAL_NAME" "$v"
	for c in $(git rev-list --reverse --no-merges "$obc..$b"); do
		[[ $(version_of "$c") == "$(version_of "$c^" 2>/dev/null)" ]] || continue
		git log -1 --format=%s "$c" | cut -c1-300 | md_item
		n=$((n + 1))
	done
	if ((n == 0)); then echo "- No change besides the version."; fi
	echo
}

do_stamp() {
	local m b v main obline obc new f
	no_links
	if [[ -e $(git rev-parse --git-path MERGE_HEAD) ]]; then
		[[ -z $(git diff --name-only --diff-filter=U) ]] || die "the merge still has conflicts"
		b=$(git rev-parse MERGE_HEAD)
		v=$(version_of "$b")
		is_plain "$v" || die "the merged commit's version is not plain"
		bot_env "$b"
		gitc commit -q --no-verify -m "$(merge_msg "$v")"
	fi
	[[ -f $RES ]] || res_init
	m=$(git rev-parse HEAD)
	[[ $(git rev-list --parents -n 1 "$m" | wc -w | tr -d ' ') == 3 ]] || die "HEAD is not a merge of the original"
	main=$(git rev-parse "$m^1")
	b=$(git rev-parse "$m^2")
	v=$(version_of "$b")
	is_plain "$v" || die "the merged commit's version is not plain"
	bumps_on "$b" >"$TMP/bumps"
	obline=$(old_base "$main" "$TMP/bumps") || die "main has no release of the original with a plain version"
	obc=${obline%% *}
	new=$(encode "$v").1 || die "$v cannot be numbered"
	bot_env "$b"
	no_links
	node "$HERE/manifest.mjs" set-version package.json "$new"
	if [[ -f package-lock.json ]]; then node "$HERE/manifest.mjs" set-version package-lock.json "$new"; fi
	changelog_entry "$new" "$v" "$obc" "$b" >"$TMP/entry"
	f=CHANGELOG.md
	[[ -f $f ]] || printf '# Changelog\n' >"$f"
	awk -v entry="$TMP/entry" '
		!done && /^## / { while ((getline l < entry) > 0) print l; done = 1 }
		{ print }
		END { if (!done) { print ""; while ((getline l < entry) > 0) print l } }' "$f" >"$TMP/cl"
	no_links
	cat "$TMP/cl" >"$f"
	git add -- package.json CHANGELOG.md
	if [[ -f package-lock.json ]]; then git add -- package-lock.json; fi
	gitc commit -q --no-verify -m "$PKG $new ($ORIGINAL_NAME $v)"
	res_set main "$main"
	res_set merge "$m"
	res_set candidate "$(git rev-parse HEAD)"
	res_set new_version "$new"
	say "stamped $new: $(git rev-parse --short HEAD)"
}

# By hand: stamp, then the guard on the result. Exit 4: refused, do not push.
cmd_stamp() {
	outside_tree
	do_stamp
	cmd_guard "$(res_get main)" HEAD
}

# --- guard -------------------------------------------------------------------------------------------------------
# blob COMMIT PATH: the object id, or nothing.
blob() { git rev-parse -q --verify "$1:$2" 2>/dev/null || true; }

do_guard() {
	local main=$1 r=$2 m b v obline obc p want line n
	: >"$TMP/reasons"
	m=$(git rev-parse -q --verify "$r^1") || m=''
	# 4. The candidate's shape: on main's line, main..R is M then R (the rest of main..R is the original's).
	git rev-list --first-parent "$main..$r" >"$TMP/range"
	n=$(wc -l <"$TMP/range" | tr -d ' ')
	if [[ $n != 2 || $(sed -n 1p "$TMP/range") != "$r" || $(sed -n 2p "$TMP/range") != "$m" ]]; then
		refuse "shape: main..R is $n commits on main's line, not the merge M and the release commit R"
	fi
	if [[ $(git rev-list --parents -n 1 "$r" | wc -w | tr -d ' ') != 2 ]]; then refuse "shape: R is not a plain commit on M"; fi
	line=$(git rev-list --parents -n 1 "${m:-$r}")
	read -r -a parents <<<"$line"
	if [[ ${#parents[@]} != 3 || ${parents[1]} != "$main" ]]; then
		refuse "shape: M is not a merge of main and one commit of the original"
		return 0
	fi
	b=${parents[2]}
	v=$(version_of "$b")
	if ! is_plain "$v" || [[ $(version_of "$b^") == "$v" ]]; then
		refuse "shape: M's second parent is not a bump commit of a plain version"
		return 0
	fi
	bumps_on "$b" >"$TMP/bumps"
	obline=$(old_base "$main" "$TMP/bumps") || {
		refuse "main has no release of the original with a plain version"
		return 0
	}
	obc=${obline%% *}

	# 1. Paths and kinds of file: what the original changed since the old base, and what M changes on main.
	path_check "$obc" "$b" "$main" "$m"

	# 2. The manifest: the keys the owner decides; the lockfile's sources and install scripts.
	blob_to "$obc" package.json "$TMP/b.json"
	blob_to "$main" package.json "$TMP/o.json"
	blob_to "$b" package.json "$TMP/t.json"
	run_check node "$HERE/manifest.mjs" stops "$TMP/b.json" "$TMP/o.json" "$TMP/t.json"
	blob_to "$main" package-lock.json "$TMP/ml.json"
	blob_to "$r" package-lock.json "$TMP/rl.json"
	blob_to "$r" package.json "$TMP/rp.json"
	# The effective change, main to R, whatever the merge or its resolution did: only the version, devDependencies
	# and engines may differ.
	run_check node "$HERE/manifest.mjs" effective "$TMP/o.json" "$TMP/rp.json"
	run_check node "$HERE/manifest.mjs" lock-check "$TMP/ml.json" "$TMP/rl.json" "$TMP/rp.json"

	# 3. The fork's tests, those it added and those it changed, and what decides which tests run, unchanged.
	git ls-tree -r --name-only "$main" | grep -E '^test/|\.(test|spec)\.[cm]?[jt]sx?$' >"$TMP/tests" || true
	while IFS= read -r p; do
		[[ $(blob "$obc" "$p") != "$(blob "$main" "$p")" ]] || continue
		[[ $(blob "$main" "$p") == "$(blob "$r" "$p")" ]] || refuse "tests: the fork's test \`$(qpath "$p")\` (its own, or changed by it) is changed or removed"
	done <"$TMP/tests"
	[[ $(blob "$main" vitest.config.ts) == "$(blob "$r" vitest.config.ts)" ]] || refuse "tests: vitest.config.ts changes"
	[[ $(jq -c '.scripts // {}' "$TMP/o.json") == "$(jq -c '.scripts // {}' "$TMP/rp.json")" ]] ||
		refuse "tests: package.json scripts change"
	[[ $(blob "$main" README.md) == "$(blob "$r" README.md)" ]] || refuse "README.md is not main's"

	# 4. R changes the version and the changelog only.
	git diff --name-only --no-renames "$m" "$r" >"$TMP/rpaths"
	while IFS= read -r p; do
		case " $R_FILES " in *" $p "*) ;; *) refuse "shape: R changes \`$(qpath "$p")\`" ;; esac
	done <"$TMP/rpaths"
	for p in package.json package-lock.json; do
		blob_to "$m" "$p" "$TMP/m.json"
		blob_to "$r" "$p" "$TMP/r.json"
		rc=0
		node "$HERE/manifest.mjs" same-but-version "$TMP/m.json" "$TMP/r.json" || rc=$?
		case $rc in
		0) ;;
		4) refuse "shape: R changes more than the version in $p" ;;
		*) die "a check failed to run (exit $rc): same-but-version" ;;
		esac
	done

	# 5. The version decodes to V.
	want=$(encode "$v").1 || want=''
	[[ -n $want ]] || refuse "version: $v cannot be numbered (a minor of 100 or more)"
	[[ $(version_of "$r") == "$want" ]] || refuse "version: R says $(shown "$(version_of "$r")"), $v gives $want"
	if [[ -s $TMP/rl.json ]]; then
		[[ $(jq -r '[.version, .packages[""].version] | map(tostring) | join(" ")' "$TMP/rl.json") == "$want $want" ]] ||
			refuse "version: package-lock.json does not say $want twice"
	fi
	res_set guard_version "$v"
	res_set guard_bump "$b"
}

cmd_guard() {
	local main=${1:-} r=${2:-HEAD}
	[[ -f $RES ]] || res_init
	[[ -n $main ]] || main=$(res_get main)
	[[ -n $main ]] || die "guard: name main (follow.sh guard MAIN [R])"
	main=$(git rev-parse --verify "$main^{commit}")
	r=$(git rev-parse --verify "$r^{commit}")
	do_guard "$main" "$r"
	res_json reasons "$(jq -R . <"$TMP/reasons" | jq -s .)"
	if [[ -s $TMP/reasons ]]; then
		res_set state refused
		res_set reason "the guard refuses the candidate"
		say "refused:"
		head -n 50 "$TMP/reasons" | sed 's/^/  /'
		return 4
	fi
	say "the guard passes $r"
}

# recheck MAIN R: what land is given, checked again by content: the guard, and npm's release against M's second
# parent.
cmd_recheck() {
	local main=$1 r=$2 rc=0
	cmd_guard "$main" "$r" || return $?
	release_matches "$(res_get guard_version)" "$(res_get guard_bump)" >"$TMP/release.txt" || rc=$?
	case $rc in
	0) say "npm's $(res_get guard_version) is the merged commit" ;;
	4)
		say "refused: npm's $(res_get guard_version) is not the merged commit:"
		head -n 50 "$TMP/release.txt" | sed 's/^/  /'
		return 4
		;;
	*) die "the release could not be read from npm and checked" ;;
	esac
}

# --- prepare (follow.yml) ----------------------------------------------------------------------------------------
in_worktree() {
	cd "$WORKTREE"
	"$@"
}

cmd_prepare() {
	local state main
	do_select "${FOLLOW_VERSION:-}" "${FOLLOW_NO_WAIT:-false}"
	state=$(res_get state)
	if [[ $state == take ]]; then
		main=$(res_get main)
		run_rc pre_merge
		if ((RC == 0)); then
			WORKTREE=$TMP/candidate
			gitc worktree add -q --detach "$WORKTREE" "$main"
			run_rc in_worktree do_merge "$(res_get bump)" "$(res_get version)" "$(res_get base_commit)"
			if ((RC == 0)); then
				run_rc in_worktree do_stamp
				((RC == 0)) || die "stamp failed"
				git update-ref "$CANDIDATE_REF" "$(res_get candidate)"
				run_rc cmd_guard "$main" "$(res_get candidate)"
				if ((RC == 0)); then
					res_set state candidate
					res_set reason "$(res_get version) merged, checked by the guard: $(res_get new_version) at $(res_get candidate)"
					git bundle create -q "$OUT/candidate.bundle" "$main..$CANDIDATE_REF"
				elif ((RC != 4)); then
					die "guard failed"
				fi
			elif ((RC != 3)); then
				die "merge failed"
			fi
		elif ((RC != 4)); then
			die "the guard on git objects failed"
		fi
	fi
	select_outputs
	gh_out candidate "$(res_get candidate)"
	gh_out result "$(jq -c . "$RES")"
	say "state: $(res_get state)"
}

# --- the candidate between jobs ----------------------------------------------------------------------------------
# fetch-candidate ID DIGEST: prepare's artifact (name follow-candidate) of this run, by the id and digest prepare
# output; checks it, fetches the bundle into refs/follow/candidate and prints the commit.
cmd_fetch_candidate() {
	local id=$1 digest=$2 run=${GITHUB_RUN_ID:?} got
	[[ $id =~ ^[0-9]{1,20}$ && $digest =~ ^(sha256:)?[0-9a-f]{64}$ ]] || die "fetch-candidate: not an artifact id and digest"
	digest="sha256:${digest#sha256:}"
	gh api "repos/$REPO/actions/artifacts/$id" |
		jq -e --arg run "$run" --arg d "$digest" '(.workflow_run.id | tostring) == $run and .name == "follow-candidate" and (.expired | not) and .digest == $d' >/dev/null ||
		die "artifact $id is not follow-candidate of run $run with $digest"
	gh api "repos/$REPO/actions/artifacts/$id/zip" >"$TMP/a.zip" || die "cannot download artifact $id"
	got=$( (sha256sum "$TMP/a.zip" 2>/dev/null || shasum -a 256 "$TMP/a.zip") | cut -d' ' -f1)
	[[ "sha256:$got" == "$digest" ]] || die "artifact $id downloads as sha256:$got, not $digest"
	mkdir -p "$TMP/a"
	unzip -q -o "$TMP/a.zip" -d "$TMP/a"
	git bundle verify -q "$TMP/a/candidate.bundle" >/dev/null 2>&1 || die "the candidate bundle does not verify against this repository"
	git fetch -q "$TMP/a/candidate.bundle" "+$CANDIDATE_REF:$CANDIDATE_REF"
	git rev-parse "$CANDIDATE_REF"
}

# --- land (follow.yml) -------------------------------------------------------------------------------------------
# land STATE MAIN [R]: STATE candidate pushes R to main (fast-forward, no force) after the recheck, then starts
# publish.yml; STATE up-to-date or not-newer only starts publish.yml. Output "landed": landed, dispatched, dry-run,
# moved, refused, push-failed or dispatch-failed; set only once its step is done.
cmd_land() {
	local state=$1 main=$2 r=${3:-} live rc=0 dry=${DRY_RUN:-yes}
	[[ ${GITHUB_REF:-refs/heads/main} == refs/heads/main ]] || die "land runs on refs/heads/main only"
	[[ $main =~ ^[0-9a-f]{40}$ ]] || die "land: main is not a commit id"
	live=$(git ls-remote "${FOLLOW_PUSH_REMOTE:-origin}" refs/heads/main | awk '$2 == "refs/heads/main" { print $1 }')
	[[ $live =~ ^[0-9a-f]{40}$ ]] || die "cannot read main"
	if [[ $state == candidate ]]; then
		[[ $r =~ ^[0-9a-f]{40}$ ]] || die "land: R is not a commit id"
		run_rc cmd_recheck "$main" "$r"
		case $RC in
		0) ;;
		4)
			gh_out landed refused
			return 1
			;;
		*) die "the recheck failed" ;;
		esac
		if [[ $live != "$main" ]]; then
			say "main moved since this run started; nothing lands, the next run starts from it"
			gh_out landed moved
			return 0
		fi
		if [[ $dry != no ]]; then
			git push --dry-run "${FOLLOW_PUSH_REMOTE:-origin}" "$r:refs/heads/main"
			say "dry run: would push $r to main (a fast-forward from $main), then start publish.yml"
			gh_out landed dry-run
			return 0
		fi
		git push "${FOLLOW_PUSH_REMOTE:-origin}" "$r:refs/heads/main" || rc=$?
		if ((rc != 0)); then
			# The owner's own push is outside the concurrency group: when main moved between the read and the push, git
			# refused a non-fast-forward, and that is "moved", not a failure.
			live=$(git ls-remote "${FOLLOW_PUSH_REMOTE:-origin}" refs/heads/main | awk '$2 == "refs/heads/main" { print $1 }')
			if [[ $live =~ ^[0-9a-f]{40}$ && $live != "$main" ]]; then
				say "main moved while landing; nothing landed, the next run starts from it"
				gh_out landed moved
				return 0
			fi
			gh_out landed push-failed
			return 1
		fi
		say "landed: main is $r"
	else
		[[ $live == "$main" ]] || {
			say "main moved; nothing to start"
			gh_out landed moved
			return 0
		}
	fi
	# A push with GITHUB_TOKEN starts no workflow; workflow_dispatch is the exception.
	if [[ $dry != no ]]; then
		say "dry run: would run gh workflow run publish.yml --ref main -f dry_run=no"
		gh_out landed dry-run
		return 0
	fi
	if ! gh workflow run publish.yml -R "$REPO" --ref main -f dry_run=no; then
		gh_out landed dispatch-failed
		return 1
	fi
	say "publish.yml started"
	if [[ $state == candidate ]]; then gh_out landed landed; else gh_out landed dispatched; fi
}

# --- plan (publish.yml) ------------------------------------------------------------------------------------------
cmd_plan() {
	local sha name ver base url lat meta s p obline published=false pc
	[[ ${GITHUB_REF:-refs/heads/main} == refs/heads/main ]] || die "plan runs on refs/heads/main only"
	sha=$(git rev-parse HEAD)
	res_init
	res_set sha "$sha"
	: >"$TMP/reasons"
	# The version first, from git alone: every outcome, an early refusal included, names it, so notify runs.
	git cat-file blob "$sha:package.json" >"$TMP/p.json" 2>/dev/null || : >"$TMP/p.json"
	ver=$(jq -r '.version // "" | tostring' "$TMP/p.json" 2>/dev/null || true)
	is_plain "$ver" || ver="!"
	res_set version "$ver"
	gh_out version "$ver"
	gh_out sha "$sha"
	git ls-tree -r --name-only "$sha" >"$TMP/tracked"
	# Before any npm command: no npm configuration in the tree.
	if grep -Eq '(^|/)\.npmrc$' "$TMP/tracked"; then
		refuse ".npmrc: the tree has one; npm is not run on it"
		res_json reasons "$(jq -R . <"$TMP/reasons" | jq -s .)"
		gh_out publish false
		say "refused to publish:"
		sed 's/^/  /' "$TMP/reasons"
		return 4
	fi
	name=$(jq -r '.name // "" | tostring' "$TMP/p.json")
	meta=$(npm_meta "$PKG")
	if [[ $ver != "!" ]] && jq -e --arg v "$ver" '(.time // {}) | has($v)' >/dev/null <<<"$meta"; then published=true; fi
	res_set published "$published"
	if [[ $published == false ]]; then
		[[ $name == "$PKG" ]] || refuse "name: package.json says '$(shown "$name")', not $PKG"
		url=$(jq -r 'if (.repository | type) == "object" then .repository.url // "" else .repository // "" end | tostring' "$TMP/p.json")
		[[ $url == "git+https://github.com/$REPO.git" ]] || refuse "repository.url is not git+https://github.com/$REPO.git"
		[[ $(jq -r '.private // false' "$TMP/p.json") == false ]] || refuse "package.json sets private"
		pc=$(jq -c '.publishConfig // {}' "$TMP/p.json")
		[[ $pc == '{}' || $pc == '{"access":"public"}' ]] || refuse "publishConfig: only {\"access\": \"public\"} is allowed"
		if base=$(decode "$ver"); then
			fetch_original
			bumps_on "$ORIGINAL_REF" >"$TMP/bumps"
			if obline=$(old_base "$sha" "$TMP/bumps"); then
				[[ $base == "${obline#* }" ]] || refuse "version: $ver is built on $base by its number, git shows ${obline#* }"
			else
				refuse "version: this commit has no release of the original with a plain version"
			fi
		else
			refuse "version: package.json's version is not <major×100+minor>.<patch>.<n> with n from 1 (docs/FOLLOWING.md 3.1)"
		fi
		lat=$(jq -r '(."dist-tags" // {}).latest // "" | tostring' <<<"$meta")
		if [[ -n $lat ]] && is_plain "$ver"; then
			if ! is_plain "$lat" || [[ $(ver_cmp "$ver" "$lat") != 1 ]]; then refuse "version: $ver is not greater than npm's latest"; fi
		fi
		for s in $LIFECYCLE; do
			if jq -e --arg s "$s" '(.scripts // {}) | has($s)' "$TMP/p.json" >/dev/null; then refuse "scripts: a lifecycle script '$s'"; fi
		done
		[[ -z $(git status --porcelain) ]] || refuse "the work tree is not the commit (git status shows changes)"
		: >"$TMP/packed"
		if npm_neutral pack --dry-run --ignore-scripts --json "$PWD" 2>"$TMP/pack.err" >"$TMP/pack.json"; then
			jq -r '.[0].files[].path' "$TMP/pack.json" >"$TMP/packed"
		else
			refuse "npm pack --dry-run fails"
		fi
		while IFS= read -r p; do
			grep -Fxq -- "$p" "$TMP/tracked" || refuse "tarball: \`$(qpath "$p")\` is not a tracked file"
			case " $PACK_FILES " in *" $p "*) continue ;; esac
			[[ $p == extensions/* ]] || refuse "tarball: \`$(qpath "$p")\` is outside extensions/ and the four files"
		done <"$TMP/packed"
		# What pi loads is checked by loading it: the test job imports the packed package's registered extensions
		# (load.mjs). Here only that each registered entry point is in the tarball.
		run_check node "$HERE/tarball.mjs" registered "$TMP/p.json" "$TMP/packed"
	fi
	res_json reasons "$(jq -R . <"$TMP/reasons" | jq -s .)"
	gh_out published "$published"
	if [[ -s $TMP/reasons ]]; then
		gh_out publish false
		say "refused to publish $ver:"
		sed 's/^/  /' "$TMP/reasons"
		return 4
	fi
	if [[ $published == true ]]; then
		gh_out publish false
		say "npm has $PKG@$ver: nothing to publish"
	else
		gh_out publish true
		say "$PKG@$ver is to be published from $sha"
	fi
}

# --- tag (publish.yml) -------------------------------------------------------------------------------------------
# The commit a tag names, an annotated tag followed to its commit; nothing when there is no such tag.
tag_commit() {
	local t=$1 obj type sha
	obj=$(gh api "repos/$REPO/git/ref/tags/$t" 2>/dev/null) || return 0
	type=$(jq -r '.object.type // ""' <<<"$obj")
	sha=$(jq -r '.object.sha // ""' <<<"$obj")
	for _ in 1 2 3 4; do
		[[ $type == tag ]] || break
		obj=$(gh api "repos/$REPO/git/tags/$sha") || die "cannot read the tag object of $t"
		type=$(jq -r '.object.type // ""' <<<"$obj")
		sha=$(jq -r '.object.sha // ""' <<<"$obj")
	done
	[[ $type == commit && $sha =~ ^[0-9a-f]{40}$ ]] || die "$t does not name a commit"
	echo "$sha"
}

# is_release_of COMMIT VERSION: COMMIT is in the live main and its package.json names VERSION.
is_release_of() {
	[[ $1 =~ ^[0-9a-f]{40}$ ]] && git merge-base --is-ancestor "$1" refs/follow/live 2>/dev/null && [[ $(version_of "$1") == "$2" ]]
}

# tag VERSION SHA PUBLISHED: v<VERSION> at the commit published from main, then its GitHub release. Exit 1 when the
# tag or the release cannot be made and is not there: the run is red and the owner is told.
cmd_tag() {
	local v=$1 sha=$2 published=$3 t commit have dry=${DRY_RUN:-yes}
	[[ ${GITHUB_REF:-refs/heads/main} == refs/heads/main ]] || die "tag runs on refs/heads/main only"
	is_plain "$v" || die "tag: not a plain version"
	[[ $sha =~ ^[0-9a-f]{40}$ ]] || die "tag: not a commit id"
	t="v$v"
	git fetch -q --no-tags "$UPSTREAM_URL" "+refs/heads/main:refs/follow/live" || die "cannot fetch the live main"
	commit=$sha
	if [[ $published == true ]]; then
		# Repair: the commit npm recorded, else the existing tag; either only when it is in the live main and its
		# package.json names this very version.
		commit=$(npm_githead "$PKG" "$v")
		if ! is_release_of "$commit" "$v"; then
			have=$(tag_commit "$t")
			if is_release_of "$have" "$v"; then
				commit=$have
			else
				die "npm has $v but no commit of main that names $v, and no $t at one: make the tag by hand (docs/FOLLOWING.md 4.3)"
			fi
		fi
	fi
	git merge-base --is-ancestor "$commit" refs/follow/live || die "$commit is not in the live main"
	[[ $(version_of "$commit") == "$v" ]] || die "$commit's package.json does not name $v: it is not tagged $t"
	have=$(tag_commit "$t")
	if [[ -n $have ]]; then
		[[ $have == "$commit" ]] || die "$t names $have, not $commit: tags are never moved"
	elif [[ $dry != no ]]; then
		say "dry run: would tag $t at $commit"
	else
		gh api -X POST "repos/$REPO/git/refs" -f ref="refs/tags/$t" -f sha="$commit" >/dev/null || die "cannot make $t"
		say "tagged $t at $commit"
	fi
	if gh release view "$t" -R "$REPO" >/dev/null 2>&1; then
		say "the release $t exists"
		return 0
	fi
	git show "$commit:CHANGELOG.md" >"$TMP/changelog" 2>/dev/null || : >"$TMP/changelog"
	awk -v h="## $v" '$0 == h { on = 1; next } /^## / { on = 0 } on' "$TMP/changelog" >"$TMP/notes.md"
	[[ -s $TMP/notes.md ]] || echo "$PKG $v." >"$TMP/notes.md"
	if [[ $dry != no ]]; then
		say "dry run: would create the release $t"
		return 0
	fi
	gh release create "$t" -R "$REPO" --verify-tag --title "$PKG $v" --notes-file "$TMP/notes.md" >/dev/null ||
		die "cannot create the release $t"
	say "released $t"
}

# --- report ------------------------------------------------------------------------------------------------------
# The automation's issues carry the label $LABEL, are opened by the bot, and begin with a hidden key: the body's
# first line is exactly the key marker, its second the state marker. A marker anywhere else (a quoted diff or log)
# counts for nothing. Nothing else is ever edited. Untrusted text is cut to a budget.
key_marker() { printf '<!-- follow-bot:key=%s -->' "$1"; }
state_marker() { printf '<!-- follow-state: %s -->' "$1"; }
# jq: an issue's key line and state line (the body's first two lines), "" when absent.
JQ_KEY='def line($i): ((.body // "") | split("\n") | .[$i] // "" | rtrimstr("\r")); def keyline: line(0); def stateline: line(1);'

fence_for() {
	local n
	n=$(LC_ALL=C grep -o '~*' "$1" 2>/dev/null | awk '{ if (length > m) m = length } END { print m + 0 }')
	((n < 3)) && n=3
	printf '%*s' $((n + 1)) '' | tr ' ' '~'
}

# capped FILE LINES BYTES: the first LINES lines, each cut to 300 characters, at most BYTES bytes.
capped() { head -n "$2" "$1" | LC_ALL=C cut -c1-300 | head -c "$3"; }

# All the bot's issues with the label, every page: [{number, title, body, state}].
bot_issues() {
	gh api --paginate "repos/$REPO/issues?state=all&labels=$LABEL&per_page=100" >"$TMP/issues.raw" || return 1
	jq -s --arg bots " $BOT_LOGINS " --arg label "$LABEL" '[.[] | if type == "array" then .[] else . end
		| (.user.login // "?") as $u
		| select((has("pull_request") | not) and ($bots | contains(" " + $u + " ")) and any(.labels[]?; .name == $label))
		| {number, title, body: (.body // ""), state}]' "$TMP/issues.raw"
}

ensure_label() {
	gh api "repos/$REPO/labels/$LABEL" >/dev/null 2>&1 && return 0
	gh api -X POST "repos/$REPO/labels" -f name="$LABEL" -f color=5319e7 \
		-f description="Opened and updated by the follow and publish workflows" >/dev/null 2>&1 || true
}

# upsert KEY TITLE STATE BODYFILE: the bot's issue with KEY gets TITLE and the body (reopened if closed); a comment
# only when its state changes. None: a new one. Exit 1 when a write fails.
upsert() {
	local key=$1 title=$2 state=$3 body=$4 found num old ost
	{
		key_marker "$key"
		echo
		state_marker "$state"
		echo
		echo
		head -c 60000 "$body"
	} >"$TMP/upsert.md"
	bot_issues >"$TMP/bot.json" || {
		say "cannot list the issues"
		return 1
	}
	found=$(jq -c --arg m "$(key_marker "$key")" "$JQ_KEY"' [.[] | select(keyline == $m)] | sort_by(if .state == "open" then 0 else 1 end, .number) | first // empty' "$TMP/bot.json")
	if [[ -z $found ]]; then
		ensure_label
		gh issue create -R "$REPO" --title "$title" --label "$LABEL" --body-file "$TMP/upsert.md" >/dev/null || return 1
		say "issue opened: $title"
		return 0
	fi
	num=$(jq -r .number <<<"$found")
	ost=$(jq -r .state <<<"$found")
	old=$(jq -r "$JQ_KEY"' (stateline | capture("^<!-- follow-state: (?<s>[^>]*) -->$") | .s) // ""' <<<"$found")
	if [[ $ost != open ]]; then gh issue reopen "$num" -R "$REPO" >/dev/null || return 1; fi
	gh issue edit "$num" -R "$REPO" --title "$title" --body-file "$TMP/upsert.md" >/dev/null || return 1
	if [[ $old != "$state" || $ost != open ]]; then
		gh issue comment "$num" -R "$REPO" --body "Now: **$state**${RUN_URL:+ ($RUN_URL)}" >/dev/null || return 1
		say "issue #$num: now $state"
	else
		say "issue #$num: still $state"
	fi
}

# close_followed BASE WHY: closes the bot's open follow issues of every release up to BASE.
close_followed() {
	local base=$1 why=$2 n x
	bot_issues >"$TMP/bot.json" || return 1
	jq -r "$JQ_KEY"' .[] | select(.state == "open") | (keyline | capture("^<!-- follow-bot:key=follow:(?<v>[0-9.]+) -->$") | .v) as $v | "\(.number) \($v)"' \
		"$TMP/bot.json" >"$TMP/open" 2>/dev/null || : >"$TMP/open"
	while read -r n x; do
		if ! is_plain "$x" || ! is_plain "$base"; then continue; fi
		[[ $(ver_cmp "$x" "$base") != 1 ]] || continue
		gh issue close "$n" -R "$REPO" --comment "$why${RUN_URL:+ ($RUN_URL)}" >/dev/null || return 1
		say "issue #$n closed"
	done <"$TMP/open"
}

# Lines already starting with "- ": the rest of the line made safe.
md_item_keep() { sed 's/^- //' | md_item; }

# What happens next, the same for every state that stops: the automation stops here; nothing is scripted.
by_hand() {
	echo "Nothing landed, and the automation does nothing more with ${1:-this release} (docs/FOLLOWING.md 2.7). Taking it is done by"
	echo "hand, by the owner's staff, on the owner's request."
}

cmd_report() {
	local res=${FOLLOW_RESULT:-$RES} state v body red=1 tests=${FOLLOW_TEST_CANDIDATE:-} orig=${FOLLOW_TEST_ORIGINAL:-}
	local land=${FOLLOW_LAND:-} f failed=0 key
	if [[ ! -s $res ]] || ! jq -e 'type == "object"' "$res" >/dev/null 2>&1; then
		echo '{"state":"error","reason":"the prepare job left no result"}' >"$TMP/r.json"
		res=$TMP/r.json
	fi
	state=$(jq -r '.state // "error" | tostring' "$res")
	v=$(jq -r '.version // "" | tostring' "$res")
	is_plain "$v" || v=''
	key="follow:${v:-unknown}"
	body=$TMP/body.md
	jq -r '.conflicts[]?' "$res" >"$TMP/conflicts"
	jq -r '.reasons[]?' "$res" >"$TMP/reasons.list"
	{
		echo "The follow run${RUN_URL:+ $RUN_URL} for $ORIGINAL_NAME \`${v:-?}\` (npm's \`latest\` or the version asked for)."
		echo
		echo "- main: \`$(jq -r '.main // "?"' "$res" | cut -c1-40)\`, built on $ORIGINAL_NAME \`$(shown "$(jq -r '.base_version // "?"' "$res")")\`"
		[[ -z $(jq -r '.bump // ""' "$res") ]] || echo "- the original's release commit: \`$(jq -r .bump "$res" | cut -c1-40)\`"
		echo
	} >"$body"
	case $state in
	up-to-date | not-newer | waiting)
		red=0
		# main has the release and npm lacks main's version: land only starts publish.yml. A failure there is red.
		case $land in
		dispatch-failed | failure | cancelled)
			state="publish not started" red=1
			echo "main has the release; npm lacks $PKG \`$(shown "$(jq -r '.fork_version // "?"' "$res")")\`, and the job \`land\` could not start \`publish.yml\` (**$(shown "$land")**). Start it: \`gh workflow run publish.yml -R $REPO -f dry_run=no\`." >>"$body"
			;;
		esac
		say "$state"
		# A dry run never closes an issue (4.5): only a live run, with main's release on npm, does.
		if ((red == 0)) && [[ $(jq -r '.fork_published' "$res") == true && $state != waiting && ${DRY_RUN:-yes} != no ]]; then
			say "dry run: no issue is closed"
		elif ((red == 0)) && [[ $(jq -r '.fork_published' "$res") == true && $state != waiting ]]; then
			close_followed "$(jq -r '.base_version // ""' "$res")" "main has the release and npm has $PKG $(shown "$(jq -r .fork_version "$res")")." || failed=1
		fi
		;;
	candidate)
		case $tests:$land in
		success:landed) state=landed red=0 ;;
		success:dry-run) state="passed (dry run, not landed)" red=0 ;;
		success:moved) state="passed (main moved meanwhile; the next run starts from it)" red=0 ;;
		success:dispatch-failed) state="landed, publish not started" ;;
		success:*) state="land failed" ;;
		*) state="check failed" ;;
		esac
		say "$state"
		case $state in
		"check failed")
			{
				echo "\`npm ci\` and \`npm run check\` on the merged tree: **$(shown "$tests")**."
				echo "On the original's release alone: **$(shown "${orig:-unknown}")** (information only)."
				if [[ -s ${FOLLOW_FAILED_STEPS:-/nonexistent} ]]; then
					echo
					echo "Failed steps:"
					capped "$FOLLOW_FAILED_STEPS" 20 2000 | sed 's/^/- /' | md_item_keep
				fi
				if [[ -s ${FOLLOW_FAILED_LOG:-/nonexistent} ]]; then
					tail -n 80 "$FOLLOW_FAILED_LOG" | LC_ALL=C cut -c1-300 | tail -c 16000 >"$TMP/log"
					f=$(fence_for "$TMP/log")
					echo
					echo "The end of its log:"
					echo
					echo "$f"
					cat "$TMP/log"
					echo
					echo "$f"
				fi
				echo
				by_hand "$v"
			} >>"$body"
			;;
		"land failed" | "landed, publish not started")
			echo "The candidate \`$(jq -r .candidate "$res" | cut -c1-40)\` passed; the job \`land\` reports **$(shown "$land")**: see the run." >>"$body"
			;;
		esac
		;;
	conflict)
		{
			echo "Merging the release conflicts in:"
			echo
			capped "$TMP/conflicts" 40 8000 | sed 's/^/- /' | md_item_keep
			echo
			by_hand "$v"
		} >>"$body"
		;;
	refused)
		{
			echo "The guard refuses what tests cannot judge (docs/FOLLOWING.md 2.6):"
			echo
			if [[ -s $TMP/reasons.list ]]; then capped "$TMP/reasons.list" 40 8000; else jq -r '.reason // ""' "$res" | cut -c1-300; fi |
				sed 's/^/- /' | md_item_keep
			echo
			echo "Accepting it is the owner's: a new path is accepted by adding it to \`.github/follow/paths.txt\` in a commit"
			echo "of his own (the next run takes the release); anything else is his decision, made knowingly."
			echo
			by_hand "$v"
		} >>"$body"
		;;
	no-release-commit)
		echo "$(jq -r .reason "$res" | cut -c1-300 | md_item | sed 's/^- //'). Nothing lands until npm's \`latest\` has one bump commit on the original's main." >>"$body"
		;;
	*)
		state=error
		echo "The run failed before a result: $(jq -r '.reason // "see the run"' "$res" | cut -c1-300 | md_item | sed 's/^- //')." >>"$body"
		;;
	esac
	# The principal report first; the README issue after, and a failure of either does not stop the other.
	if ((red == 1)); then
		upsert "$key" "follow: ${v:-?} — $state" "$state" "$body" || {
			say "the issue could not be written"
			failed=1
		}
	elif [[ $state == landed ]]; then
		if bot_issues >"$TMP/bot.json" && jq -e --arg m "$(key_marker "$key")" "$JQ_KEY"' any(.[]; .state == "open" and keyline == $m)' "$TMP/bot.json" >/dev/null; then
			upsert "$key" "follow: $v — landed" landed "$body" || failed=1
		fi
	fi
	if [[ $(jq -r '.readme_changed // false' "$res") == true && -n $v ]]; then readme_issue "$v" "$res" || failed=1; fi
	((red == 0 && failed == 0))
}

readme_issue() {
	local v=$1 key="readme:$1" f diff=${FOLLOW_README_DIFF:-$OUT/readme.diff}
	bot_issues >"$TMP/bot.json" || return 1
	if jq -e --arg m "$(key_marker "$key")" "$JQ_KEY"' any(.[]; keyline == $m)' "$TMP/bot.json" >/dev/null; then return 0; fi
	if [[ ! -s $diff ]]; then
		jq -r '.readme_diff // ""' "$2" >"$TMP/readme.diff"
		diff=$TMP/readme.diff
	fi
	head -c 40000 "$diff" >"$TMP/readme.cut"
	{
		key_marker "$key"
		echo
		state_marker open
		echo
		echo
		echo "$ORIGINAL_NAME $v changed its README. The fork keeps its own (docs/FOLLOWING.md 2.5); what is new may need"
		echo "describing in the fork's words. This blocks nothing."
		echo
		if [[ -s $TMP/readme.cut ]]; then
			f=$(fence_for "$TMP/readme.cut")
			echo "${f}diff"
			cat "$TMP/readme.cut"
			echo
			echo "$f"
		fi
	} >"$TMP/readme.md"
	ensure_label
	gh issue create -R "$REPO" --title "README: after $v" --label "$LABEL" --body-file "$TMP/readme.md" >/dev/null || return 1
	say "issue opened: README: after $v"
}

# report-publish VERSION RESULT: success, outside a dry run and with the version on npm, closes the bot's publish
# issue of VERSION; anything else opens or updates it. A dry run closes nothing.
cmd_report_publish() {
	local v=$1 result=$2 key n dry=${DRY_RUN:-yes}
	# plan names "!" for a version that is not plain: still a report, never a close.
	if ! is_plain "$v"; then
		v=unknown
		[[ $result != success ]] || result="the jobs succeeded, but main's version is not plain"
	fi
	key="publish:$v"
	if [[ $result == success ]]; then
		if [[ $dry != no ]]; then
			say "dry run: no issue is closed"
			return 0
		fi
		if jq -e --arg v "$v" '(.time // {}) | has($v)' >/dev/null <<<"$(npm_meta "$PKG")"; then
			bot_issues >"$TMP/bot.json" || return 1
			for n in $(jq -r --arg m "$(key_marker "$key")" "$JQ_KEY"' .[] | select(.state == "open" and keyline == $m) | .number' "$TMP/bot.json"); do
				gh issue close "$n" -R "$REPO" --comment "npm has $PKG $v now${RUN_URL:+ ($RUN_URL)}." >/dev/null || return 1
				say "issue #$n closed"
			done
			return 0
		fi
		result="the jobs succeeded, but npm does not show $v"
	fi
	{
		echo "main names $PKG \`$v\`; publishing it did not complete${RUN_URL:+: $RUN_URL}. Git installs already have it."
		echo
		echo "Jobs: $(printf '%s' "$result" | LC_ALL=C tr -cd 'A-Za-z0-9 ,.:_-' | cut -c1-300)"
		echo
		echo "After the cause is fixed: \`gh workflow run publish.yml -R $REPO -f dry_run=no\` (docs/FOLLOWING.md 4.3)."
	} >"$TMP/pub.md"
	upsert "$key" "publish: $v — failed" failed "$TMP/pub.md" || say "the issue could not be written"
	return 1
}

# --- main --------------------------------------------------------------------------------------------------------
cmd=${1:-}
[[ $# -eq 0 ]] || shift
case $cmd in
select) cmd_select "$@" ;;
merge) cmd_merge "$@" ;;
stamp) cmd_stamp ;;
guard) cmd_guard "$@" ;;
recheck) cmd_recheck "$@" ;;
prepare) cmd_prepare ;;
fetch-candidate) cmd_fetch_candidate "$@" ;;
land) cmd_land "$@" ;;
plan) cmd_plan ;;
tag) cmd_tag "$@" ;;
report) cmd_report ;;
report-publish) cmd_report_publish "$@" ;;
*)
	sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
	exit 2
	;;
esac
