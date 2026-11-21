#!/usr/bin/env bash
# Following the original (docs/FOLLOWING.md). What follow.yml, publish.yml and the owner's Mac run.
# Bash 3.2 (macOS) and later; needs git, jq and node; gh only for report and fetch-candidate.
#
#   follow.sh select [VERSION] [--no-wait]  which release of the original to take now, and why (2.1, 2.2)
#   follow.sh merge [VERSION]               merges its bump commit into HEAD by the rules of 2.5; commits M when
#                                           clean, else leaves the conflict in the work tree (exit 3)
#   follow.sh stamp                         commits M if a merge is in progress, then R: the version and the
#                                           changelog entry (3)
#   follow.sh guard [MAIN] [R]              the guard of 2.6 on the candidate MAIN..R (default: the merge's main,
#                                           HEAD); exit 4 with the reasons when it refuses
#   follow.sh report                        writes the owner's issue from a run's result (2.7); reads
#                                           FOLLOW_RESULT (default the result file), FOLLOW_TEST_CANDIDATE and
#                                           FOLLOW_TEST_ORIGINAL (a job's result), FOLLOW_LAND (landed, dry-run,
#                                           moved or a job's result), FOLLOW_FAILED_STEPS and FOLLOW_FAILED_LOG
#                                           (files), RUN_URL; exit 1 for the states the owner must see
#   follow.sh report-publish VERSION RESULT the issue of a failed publish, or closes it after a good one (4.3)
#
# For the workflows:
#   follow.sh prepare                       select, then merge, stamp and guard in a temporary worktree; the
#                                           candidate as a git bundle
#   follow.sh fetch-candidate ID DIGEST     prepare's artifact by its id and digest; fetches the candidate
#   follow.sh plan                          publish.yml's publish guard (4.2) on HEAD
#
# The state of a run is $FOLLOW_OUT/result.json (default <git dir>/follow/result.json); exit codes: 0 done (look at
# the state), 1 an error, 3 a conflict, 4 a refusal.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ORIGINAL_URL=${FOLLOW_ORIGINAL_URL:-https://github.com/router-for-me/pi-cliproxyapi-provider.git}
ORIGINAL_PKG=${FOLLOW_ORIGINAL_PKG:-@router-for-me/pi-cliproxyapi-provider}
ORIGINAL_NAME=pi-cliproxyapi-provider
PKG=${FOLLOW_PKG:-pi-provimux}
REPO=${FOLLOW_REPO:-${GITHUB_REPOSITORY:-ngvoicu/pi-provimux}}
WAIT_HOURS=${FOLLOW_WAIT_HOURS:-24}
ORIGINAL_REF=refs/follow/original
CANDIDATE_REF=refs/follow/candidate
BOT_NAME='github-actions[bot]'
BOT_EMAIL='41898282+github-actions[bot]@users.noreply.github.com'
PLAIN_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
R_FILES='CHANGELOG.md package-lock.json package.json'
PACK_FILES='CHANGELOG.md LICENSE README.md package.json'
LIFECYCLE='preinstall install postinstall prepublish prepare prepublishOnly prepack postpack publish postpublish'

die() {
	echo "follow: $*" >&2
	exit 1
}
say() { echo "follow: $*"; }

TMP=$(mktemp -d "${TMPDIR:-/tmp}/follow.XXXXXX")
WORKTREE=''
cleanup() {
	if [[ -n $WORKTREE ]]; then git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true; fi
	rm -rf "${TMP:?}"
}
trap cleanup EXIT

git rev-parse --git-dir >/dev/null 2>&1 || die "not in a git repository"
OUT=${FOLLOW_OUT:-$(git rev-parse --path-format=absolute --git-common-dir)/follow}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
RES=$OUT/result.json

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

# git without the user's hooks, signing or recorded resolutions: the same inputs give the same commits.
gitc() { git -c core.hooksPath=/dev/null -c commit.gpgsign=false -c rerere.enabled=false "$@"; }

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

# ver_cmp A B: -1, 0 or 1.
ver_cmp() {
	local -a a b
	IFS=. read -r -a a <<<"$1"
	IFS=. read -r -a b <<<"$2"
	local i
	for i in 0 1 2; do
		if ((10#${a[i]} > 10#${b[i]})); then
				echo 1
				return
		fi
		if ((10#${a[i]} < 10#${b[i]})); then
				echo -1
				return
		fi
	done
	echo 0
}

# encode 1.5.0 → 105.0 (3.1); fails when the minor is 100 or more.
encode() {
	local -a v
	IFS=. read -r -a v <<<"$1"
	((10#${v[1]} < 100)) || return 1
	echo "$((10#${v[0]} * 100 + 10#${v[1]})).$((10#${v[2]}))"
}

# decode 105.0.3 → 1.5.0; fails for a number that is not of the form of 3.1.
decode() {
	is_plain "$1" || return 1
	local -a v
	IFS=. read -r -a v <<<"$1"
	((10#${v[0]} >= 100 && 10#${v[2]} >= 1)) || return 1
	echo "$((10#${v[0]} / 100)).$((10#${v[0]} % 100)).$((10#${v[1]}))"
}

iso_epoch() { jq -rn --arg t "$1" '$t | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601'; }
epoch_iso() { jq -rn --argjson e "$1" '$e | todate'; }

# The version in COMMIT:package.json, or nothing.
version_of() {
	git cat-file blob "$1:package.json" 2>/dev/null |
		jq -r 'if type == "object" then (.version // "" | tostring) else "" end' 2>/dev/null || true
}

# bumps_on REF: "commit version" for every bump commit on REF's first-parent history, newest first: the commits
# whose package.json names a version their first parent's does not.
bumps_on() {
	git rev-list --first-parent "$1" >"$TMP/fp"
	sed 's/$/:package.json/' "$TMP/fp" | git cat-file --batch-check='%(objectname)' >"$TMP/fpb"
	local b
	: >"$TMP/bv"
	grep -v ' ' "$TMP/fpb" | sort -u | while read -r b; do
		printf '%s %s\n' "$b" "$(git cat-file blob "$b" | jq -r 'if type == "object" then (.version // "" | tostring) else "" end' 2>/dev/null || true)"
	done >"$TMP/bv"
	paste -d' ' "$TMP/fp" "$TMP/fpb" |
		awk 'NR == FNR { if ($2 != "") v[$1] = $2; next } { print $1, (($2 in v) ? v[$2] : "-") }' "$TMP/bv" - |
		awk '{ c[NR] = $1; v[NR] = $2 } END { for (i = 1; i <= NR; i++) if (v[i] != "-" && v[i] != v[i + 1]) print c[i], v[i] }'
}

# old_base MAIN BUMPS_FILE: "commit version" of the newest bump commit that is an ancestor of MAIN.
old_base() {
	local c v
	while read -r c v; do
		if git merge-base --is-ancestor "$c" "$1"; then
			echo "$c $v"
			return 0
		fi
	done <"$2"
	return 1
}

# --- npm ---------------------------------------------------------------------------------------------------------
# npm_meta PKG: {"dist-tags": …, "time": …} from the registry, {} when the package does not exist.
# FOLLOW_NPM_DIR (the tests) names a folder of <pkg>.json files instead ("/" and "@" read as "_").
npm_meta() {
	local out rc=0 f
	if [[ -n ${FOLLOW_NPM_DIR:-} ]]; then
		f="$FOLLOW_NPM_DIR/$(printf %s "$1" | tr '/@' '__').json"
		if [[ -f $f ]]; then cat "$f"; else echo '{}'; fi
		return 0
	fi
	out=$(npm view "$1" dist-tags time --json 2>/dev/null) || rc=$?
	if ((rc == 0)) && jq -e 'type == "object"' >/dev/null 2>&1 <<<"$out"; then
		printf '%s\n' "$out"
		return 0
	fi
	if jq -e '.error.code == "E404"' >/dev/null 2>&1 <<<"$out"; then
		echo '{}'
		return 0
	fi
	die "npm view $1 failed (exit $rc)"
}

fetch_original() {
	if [[ ${FOLLOW_NO_FETCH:-} == 1 ]]; then
		git rev-parse -q --verify "$ORIGINAL_REF^{commit}" >/dev/null || die "no $ORIGINAL_REF and FOLLOW_NO_FETCH=1"
		return 0
	fi
	git fetch -q --no-tags "$ORIGINAL_URL" "+refs/heads/main:$ORIGINAL_REF" || die "cannot fetch the original's main from $ORIGINAL_URL"
}

# --- select ------------------------------------------------------------------------------------------------------
# finish STATE REASON: the state of select, also as step outputs.
finish_select() {
	res_set state "$1"
	res_set reason "$2"
	say "$1: $2"
}

do_select() {
	local want=$1 nowait=$2 main meta latest v ob obc obline count b pub age ready fork fmeta
	main=$(git rev-parse --verify "${FOLLOW_MAIN:-HEAD}^{commit}") || die "no main"
	res_init
	res_set main "$main"
	fetch_original
	res_set original "$(git rev-parse "$ORIGINAL_REF")"
	fork=$(version_of "$main")
	res_set fork_version "$fork"
	fmeta=$(npm_meta "$PKG")
	if jq -e --arg v "$fork" '(.time // {}) | has($v)' >/dev/null <<<"$fmeta"; then
		res_set fork_published true
	else
		res_set fork_published false
	fi

	bumps_on "$ORIGINAL_REF" >"$OUT/bumps.txt"
	obline=$(old_base "$main" "$OUT/bumps.txt") || {
		finish_select error "main has none of the original's releases"
		return 0
	}
	obc=${obline%% *}
	ob=${obline#* }
	res_set base_commit "$obc"
	res_set base_version "$ob"

	meta=$(npm_meta "$ORIGINAL_PKG")
	latest=$(jq -r '(."dist-tags" // {}).latest // ""' <<<"$meta")
	v=${want:-$latest}
	res_set version "$v"
	if ! is_plain "$v"; then
		if [[ -n $want ]]; then
			finish_select no-release-commit "the version asked for, '$v', is not a plain X.Y.Z"
		else
			finish_select no-release-commit "npm's latest is '$v', not a plain X.Y.Z"
		fi
		return 0
	fi
	pub=$(jq -r --arg v "$v" '(.time // {})[$v] // ""' <<<"$meta")
	if [[ -z $pub ]]; then
		finish_select no-release-commit "$v is not published on npm"
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
	age=$((${FOLLOW_NOW:-$(date +%s)} - $(iso_epoch "$pub")))
	ready=$(($(iso_epoch "$pub") + WAIT_HOURS * 3600))
	res_set ready_at "$(epoch_iso "$ready")"
	if [[ $nowait != true ]] && ((age < WAIT_HOURS * 3600)); then
		finish_select waiting "$v was published $pub; it is taken from $(epoch_iso "$ready")"
		return 0
	fi
	finish_select take "$v ($b), on top of $ob"
}

cmd_select() {
	local want='' nowait=${FOLLOW_NO_WAIT:-false} a
	for a in "$@"; do
		case $a in
		--no-wait) nowait=true ;;
		-*) die "select: unknown option $a" ;;
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

do_merge() {
	local b=$1 v=$2 obc=$3 main rc=0 f kind
	main=$(git rev-parse HEAD)
	res_set main "$main"
	bot_env "$b"
	gitc merge --no-ff --no-commit --no-edit "$b" >"$TMP/merge.log" 2>&1 || rc=$?
	if [[ ! -e $(git rev-parse --git-path MERGE_HEAD) ]]; then
		cat "$TMP/merge.log" >&2
		die "git merge $b did not start (exit $rc)"
	fi
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
		res_set readme_diff "$(head -c 60000 "$OUT/readme.diff")"
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
		node "$HERE/manifest.mjs" merge "$kind" "$TMP/base.json" "$TMP/ours.json" "$TMP/theirs.json" "$f" >"$TMP/mc" || rc=$?
		case $rc in
		0) ;;
		3) while IFS= read -r line; do res_add conflicts "$line"; done <"$TMP/mc" ;;
		*) die "manifest.mjs merge $f failed" ;;
		esac
		git add -- "$f"
	done

	git diff --name-only --diff-filter=U >"$TMP/unmerged"
	while IFS= read -r f; do res_add conflicts "$f"; done <"$TMP/unmerged"
	if [[ -n $(res_get conflicts) ]]; then
		res_set state conflict
		res_set reason "merging $v conflicts"
		say "conflict merging $v:"
		res_get conflicts | sed 's/^/  /'
		return 3
	fi
	gitc commit -q --no-verify -m "$(merge_msg "$v")"
	res_set merge "$(git rev-parse HEAD)"
	say "merged $v ($b): $(git rev-parse --short HEAD)"
}

cmd_merge() {
	local want=${1:-} state
	[[ -z $(git status --porcelain --untracked-files=no) ]] || die "the work tree has changes; commit or put them aside first"
	[[ ! -e $(git rev-parse --git-path MERGE_HEAD) ]] || die "a merge is already in progress"
	FOLLOW_MAIN=HEAD do_select "$want" true
	state=$(res_get state)
	case $state in
	take) ;;
	up-to-date) return 0 ;;
	*) die "nothing to merge: $state, $(res_get reason)" ;;
	esac
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
		git log -1 --format=%s "$c" | md_item
		n=$((n + 1))
	done
	if ((n == 0)); then echo "- No change besides the version."; fi
	echo
}

cmd_stamp() {
	local m b v main obline obc new f
	if [[ -e $(git rev-parse --git-path MERGE_HEAD) ]]; then
		[[ -z $(git diff --name-only --diff-filter=U) ]] || die "the merge still has conflicts: $(git diff --name-only --diff-filter=U | tr '\n' ' ')"
		b=$(git rev-parse MERGE_HEAD)
		bot_env "$b"
		gitc commit -q --no-verify -m "$(merge_msg "$(version_of "$b")")"
	fi
	[[ -f $RES ]] || res_init
	m=$(git rev-parse HEAD)
	[[ $(git rev-list --parents -n 1 "$m" | wc -w | tr -d ' ') == 3 ]] || die "HEAD is not a merge of the original"
	main=$(git rev-parse "$m^1")
	b=$(git rev-parse "$m^2")
	v=$(version_of "$b")
	is_plain "$v" || die "the merged commit's version is '$v'"
	bumps_on "$b" >"$TMP/bumps"
	obline=$(old_base "$main" "$TMP/bumps") || die "main has none of the original's releases"
	obc=${obline%% *}
	new=$(encode "$v").1 || die "$v cannot be numbered"
	bot_env "$b"
	node "$HERE/manifest.mjs" set-version package.json "$new"
	if [[ -f package-lock.json ]]; then node "$HERE/manifest.mjs" set-version package-lock.json "$new"; fi
	changelog_entry "$new" "$v" "$obc" "$b" >"$TMP/entry"
	f=CHANGELOG.md
	[[ -f $f ]] || printf '# Changelog\n' >"$f"
	awk -v entry="$TMP/entry" '
		!done && /^## / { while ((getline l < entry) > 0) print l; done = 1 }
		{ print }
		END { if (!done) { print ""; while ((getline l < entry) > 0) print l } }' "$f" >"$TMP/cl"
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

# --- guard -------------------------------------------------------------------------------------------------------
path_allowed() {
	local p=$1 pat
	while IFS= read -r pat || [[ -n $pat ]]; do
		pat=${pat%%#*}
		pat=$(echo "$pat" | tr -d '[:space:]')
		[[ -n $pat ]] || continue
		if [[ ${#pat} -gt 3 && ${pat: -3} == "/**" ]]; then
			[[ $p == "${pat%/**}"/* ]] && return 0
		elif [[ $p == "$pat" ]]; then
			return 0
		fi
	done <"$HERE/paths.txt"
	return 1
}

refuse() {
	echo "$1" >>"$TMP/reasons"
}

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
	set -- $line
	if [[ $# != 3 || $2 != "$main" ]]; then
		refuse "shape: M is not a merge of main and one commit of the original"
		return 0
	fi
	b=$3
	v=$(version_of "$b")
	if ! is_plain "$v" || [[ $(version_of "$b^") == "$v" ]]; then
		refuse "shape: M's second parent is not a bump commit of a plain version"
		return 0
	fi
	bumps_on "$b" >"$TMP/bumps"
	obline=$(old_base "$main" "$TMP/bumps") || {
		refuse "main has none of the original's releases"
		return 0
	}
	obc=${obline%% *}

	# 1. Paths: what the original changed since the old base, and what M changes on main.
	{
		git diff --name-only --no-renames "$obc" "$b"
		git diff --name-only --no-renames "$main" "$m"
	} | sort -u >"$TMP/paths"
	while IFS= read -r p; do
		path_allowed "$p" || refuse "path: the original changes \`$p\`, which is not in .github/follow/paths.txt"
	done <"$TMP/paths"
	git diff --raw --no-renames "$obc" "$b" | awk '$2 ~ /^1(2|6)0000$/ { sub(/^[^\t]*\t/, ""); print }' |
		while IFS= read -r p; do refuse "path: \`$p\` becomes a symbolic link or a submodule"; done

	# 2. The manifest: the keys the owner decides; the lockfile's sources.
	blob_to "$obc" package.json "$TMP/b.json"
	blob_to "$main" package.json "$TMP/o.json"
	blob_to "$b" package.json "$TMP/t.json"
	node "$HERE/manifest.mjs" stops "$TMP/b.json" "$TMP/o.json" "$TMP/t.json" >>"$TMP/reasons" || true
	blob_to "$main" package-lock.json "$TMP/ml.json"
	blob_to "$r" package-lock.json "$TMP/rl.json"
	node "$HERE/manifest.mjs" lock-check "$TMP/ml.json" "$TMP/rl.json" >>"$TMP/reasons" || true

	# 3. The fork's own tests, and what decides which tests run, unchanged.
	git ls-tree -r --name-only "$main" | grep -E '^test/|\.(test|spec)\.[cm]?[jt]sx?$' >"$TMP/tests" || true
	while IFS= read -r p; do
		[[ -z $(blob "$obc" "$p") ]] || continue
		[[ $(blob "$main" "$p") == "$(blob "$r" "$p")" ]] || refuse "tests: the fork's own test \`$p\` is changed or removed"
	done <"$TMP/tests"
	[[ $(blob "$main" vitest.config.ts) == "$(blob "$r" vitest.config.ts)" ]] || refuse "tests: vitest.config.ts changes"
	[[ $(jq -c '.scripts // {}' "$TMP/o.json") == "$(git cat-file blob "$r:package.json" | jq -c '.scripts // {}')" ]] ||
		refuse "tests: package.json scripts change"
	[[ $(blob "$main" README.md) == "$(blob "$r" README.md)" ]] || refuse "README.md is not main's"

	# 4. R changes the version and the changelog only.
	git diff --name-only --no-renames "$m" "$r" >"$TMP/rpaths"
	while IFS= read -r p; do
		case " $R_FILES " in *" $p "*) ;; *) refuse "shape: R changes \`$p\`" ;; esac
	done <"$TMP/rpaths"
	for p in package.json package-lock.json; do
		blob_to "$m" "$p" "$TMP/m.json"
		blob_to "$r" "$p" "$TMP/r.json"
		node "$HERE/manifest.mjs" same-but-version "$TMP/m.json" "$TMP/r.json" || refuse "shape: R changes more than the version in $p"
	done

	# 5. The version decodes to V.
	want=$(encode "$v").1 || want=''
	[[ -n $want ]] || refuse "version: $v cannot be numbered (a minor of 100 or more)"
	[[ $(version_of "$r") == "$want" ]] || refuse "version: R says $(version_of "$r"), $v gives $want"
	if [[ -s $TMP/rl.json ]]; then
		[[ $(jq -r '[.version, .packages[""].version] | join(" ")' "$TMP/rl.json") == "$want $want" ]] ||
			refuse "version: package-lock.json does not say $want twice"
	fi
	res_set guard_version "$v"
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
		sed 's/^/  /' "$TMP/reasons"
		return 4
	fi
	say "the guard passes $r"
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
		WORKTREE=$TMP/candidate
		git worktree add -q --detach "$WORKTREE" "$main"
		run_rc in_worktree do_merge "$(res_get bump)" "$(res_get version)" "$(res_get base_commit)"
		if ((RC == 0)); then
			run_rc in_worktree cmd_stamp
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
	[[ $id =~ ^[0-9]+$ && $digest =~ ^(sha256:)?[0-9a-f]{64}$ ]] || die "fetch-candidate: id '$id', digest '$digest'"
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

# --- plan (publish.yml) ------------------------------------------------------------------------------------------
cmd_plan() {
	local sha name ver base url lat meta s p obline published=false
	sha=$(git rev-parse HEAD)
	res_init
	res_set sha "$sha"
	git cat-file blob "$sha:package.json" >"$TMP/p.json"
	name=$(jq -r '.name // ""' "$TMP/p.json")
	ver=$(jq -r '.version // ""' "$TMP/p.json")
	res_set version "$ver"
	meta=$(npm_meta "$PKG")
	if jq -e --arg v "$ver" '(.time // {}) | has($v)' >/dev/null <<<"$meta"; then published=true; fi
	res_set published "$published"
	: >"$TMP/reasons"
	if [[ $published == false ]]; then
		[[ $name == "$PKG" ]] || refuse "name: package.json says '$name', not $PKG"
		url=$(jq -r 'if (.repository | type) == "object" then .repository.url // "" else .repository // "" end' "$TMP/p.json")
		[[ $url == "git+https://github.com/$REPO.git" ]] || refuse "repository.url is '$url', not git+https://github.com/$REPO.git"
		[[ $(jq -r '.private // false' "$TMP/p.json") == false ]] || refuse "package.json sets private"
		if base=$(decode "$ver"); then
			fetch_original
			bumps_on "$ORIGINAL_REF" >"$TMP/bumps"
			if obline=$(old_base "$sha" "$TMP/bumps"); then
				[[ $base == "${obline#* }" ]] || refuse "version: $ver is built on $base by its number, git shows ${obline#* }"
			else
				refuse "version: this commit has none of the original's releases"
			fi
		else
			refuse "version: '$ver' is not <major×100+minor>.<patch>.<n> with n from 1 (docs/FOLLOWING.md 3.1)"
		fi
		lat=$(jq -r '(."dist-tags" // {}).latest // ""' <<<"$meta")
		if [[ -n $lat ]] && is_plain "$ver"; then
			if ! is_plain "$lat" || [[ $(ver_cmp "$ver" "$lat") != 1 ]]; then refuse "version: $ver is not greater than npm's latest $lat"; fi
		fi
		for s in $LIFECYCLE; do
			if jq -e --arg s "$s" '(.scripts // {}) | has($s)' "$TMP/p.json" >/dev/null; then refuse "scripts: a lifecycle script '$s'"; fi
		done
		[[ -z $(git status --porcelain) ]] || refuse "the work tree is not the commit (git status shows changes)"
		git ls-tree -r --name-only "$sha" >"$TMP/tracked"
		: >"$TMP/packed"
		if grep -Eq '(^|/)\.npmrc$' "$TMP/tracked"; then
			refuse ".npmrc: the tree has one (npm would read it; the tarball is not looked at)"
		elif npm pack --dry-run --ignore-scripts --json 2>"$TMP/pack.err" >"$TMP/pack.json"; then
			jq -r '.[0].files[].path' "$TMP/pack.json" >"$TMP/packed"
		else
			refuse "npm pack --dry-run fails: $(tail -n 1 "$TMP/pack.err")"
		fi
		while IFS= read -r p; do
			grep -Fxq -- "$p" "$TMP/tracked" || refuse "tarball: \`$p\` is not a tracked file"
			case " $PACK_FILES " in *" $p "*) continue ;; esac
			[[ $p == extensions/* ]] || refuse "tarball: \`$p\` is outside extensions/ and the four files"
		done <"$TMP/packed"
	fi
	res_json reasons "$(jq -R . <"$TMP/reasons" | jq -s .)"
	gh_out version "$ver"
	gh_out sha "$sha"
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

# --- report ------------------------------------------------------------------------------------------------------
# The issues are found by their title; the body carries the state, so a state is said once.
fence_for() {
	local n
	n=$(LC_ALL=C grep -o '~*' "$1" 2>/dev/null | awk '{ if (length > m) m = length } END { print m + 0 }')
	((n < 3)) && n=3
	printf '%*s' $((n + 1)) '' | tr ' ' '~'
}

issues_json() { gh issue list -R "$REPO" --state "$1" --limit 300 --json number,title,body,state; }

# upsert_issue PREFIX TITLE STATE BODYFILE: the open issue whose title starts with PREFIX gets TITLE and the body;
# a comment only when its state changes. None: a new issue.
upsert_issue() {
	local prefix=$1 title=$2 state=$3 body=$4 found num old
	printf '\n<!-- follow-state: %s -->\n' "$state" >>"$body"
	found=$(issues_json open | jq -c --arg p "$prefix" '[.[] | select(.title | startswith($p))] | sort_by(.number) | first // empty')
	if [[ -z $found ]]; then
		gh issue create -R "$REPO" --title "$title" --body-file "$body" >/dev/null
		say "issue opened: $title"
		return 0
	fi
	num=$(jq -r .number <<<"$found")
	old=$(jq -r '(.body // "" | capture("<!-- follow-state: (?<s>[^>]*) -->") | .s) // ""' <<<"$found")
	gh issue edit "$num" -R "$REPO" --title "$title" --body-file "$body" >/dev/null
	if [[ $old != "$state" ]]; then
		gh issue comment "$num" -R "$REPO" --body "Now: **$state**${RUN_URL:+ ($RUN_URL)}" >/dev/null
		say "issue #$num: $old → $state"
	else
		say "issue #$num: still $state"
	fi
}

# close_followed BASE WHY: closes the open "follow: X — …" issues of every release X up to BASE.
close_followed() {
	local base=$1 why=$2 n x
	issues_json open | jq -r '.[] | select(.title | startswith("follow: ")) | "\(.number) \(.title | ltrimstr("follow: ") | split(" ") | .[0])"' >"$TMP/open"
	while read -r n x; do
		is_plain "$x" && is_plain "$base" || continue
		[[ $(ver_cmp "$x" "$base") != 1 ]] || continue
		gh issue close "$n" -R "$REPO" --comment "$why${RUN_URL:+ ($RUN_URL)}" >/dev/null
		say "issue #$n closed"
	done <"$TMP/open"
}

cmd_report() {
	local res=${FOLLOW_RESULT:-$RES} state v title body red=1 tests=${FOLLOW_TEST_CANDIDATE:-} orig=${FOLLOW_TEST_ORIGINAL:-}
	local land=${FOLLOW_LAND:-} f
	if [[ ! -s $res ]]; then
		echo '{"state":"error","reason":"the prepare job left no result"}' >"$TMP/r.json"
		res=$TMP/r.json
	fi
	state=$(jq -r '.state // "error"' "$res")
	v=$(jq -r '.version // ""' "$res")
	body=$TMP/body.md
	: >"$body"
	{
		echo "The follow run${RUN_URL:+ $RUN_URL} for $ORIGINAL_NAME \`${v:-?}\` (npm's \`latest\` or the version asked for)."
		echo
		echo "- main: \`$(jq -r '.main // "?"' "$res")\`, built on $ORIGINAL_NAME \`$(jq -r '.base_version // "?"' "$res")\`"
		[[ -z $(jq -r '.bump // ""' "$res") ]] || echo "- the original's release commit: \`$(jq -r .bump "$res")\`"
		echo
	} >>"$body"
	case $state in
	up-to-date | not-newer | waiting)
		red=0
		say "$state: $(jq -r .reason "$res")"
		if [[ $(jq -r '.fork_published' "$res") == true && $state != waiting ]]; then
			close_followed "$(jq -r '.base_version // ""' "$res")" "main has the release and npm has $PKG $(jq -r .fork_version "$res")."
		fi
		;;
	candidate)
		if [[ $tests == success && ($land == landed || $land == dry-run || $land == moved) ]]; then
			red=0
			case $land in
			landed) state=landed ;;
			dry-run) state="passed (dry run, not landed)" ;;
			moved) state="passed (main moved meanwhile; the next run starts from it)" ;;
			esac
			say "$state"
		elif [[ $tests != success ]]; then
			state="check failed"
			{
				echo "\`npm ci\` and \`npm run check\` on the merged tree: **$tests**."
				echo "On the original's release alone: **${orig:-unknown}** (information only)."
				if [[ -s ${FOLLOW_FAILED_STEPS:-/nonexistent} ]]; then
					echo
					echo "Failed steps:"
					sed 's/^/- /' "$FOLLOW_FAILED_STEPS" | md_item_keep
				fi
				if [[ -s ${FOLLOW_FAILED_LOG:-/nonexistent} ]]; then
					f=$(fence_for "$FOLLOW_FAILED_LOG")
					echo
					echo "The end of its log:"
					echo
					echo "$f"
					cat "$FOLLOW_FAILED_LOG"
					echo "$f"
				fi
				echo
				echo "By hand, the same merge: \`.github/follow/follow.sh merge $v\`, then \`.github/follow/follow.sh stamp\`, fix, \`npm run check\`, push to GitHub."
			} >>"$body"
		else
			state="land failed"
			echo "The candidate \`$(jq -r .candidate "$res")\` passed, but the job \`land\` ended **$land**: see the run." >>"$body"
		fi
		;;
	conflict)
		{
			echo "Merging the release conflicts in:"
			echo
			jq -r '.conflicts[]?' "$res" | sed 's/^/- /' | md_item_keep
			echo
			echo "Merge by hand (the same rules for README.md, package.json and package-lock.json):"
			echo
			echo '```sh'
			echo ".github/follow/follow.sh merge $v    # leaves the conflict in the work tree"
			echo "# resolve, git add, then:"
			echo ".github/follow/follow.sh stamp        # the merge commit, then the version and the changelog"
			echo "npm run check"
			echo "git push upstream main               # GitHub; publish.yml publishes it"
			echo '```'
		} >>"$body"
		;;
	refused)
		{
			echo "The guard refuses what tests cannot judge (docs/FOLLOWING.md 2.6):"
			echo
			jq -r '.reasons[]?, (if (.reasons // []) == [] then .reason else empty end)' "$res" | sed 's/^/- /' | md_item_keep
			echo
			echo "Accepting it is the owner's: a new path is accepted by adding it to \`.github/follow/paths.txt\` in a commit"
			echo "of his own (the next run takes the release); anything else is merged by hand with"
			echo "\`.github/follow/follow.sh merge $v\` and \`stamp\`, reviewed, and pushed."
		} >>"$body"
		;;
	no-release-commit)
		echo "$(jq -r .reason "$res" | md_item | sed 's/^- //'). Nothing lands until npm's \`latest\` has one bump commit on the original's main." >>"$body"
		;;
	*)
		state=error
		echo "The run failed before a result: $(jq -r '.reason // "see the run"' "$res" | md_item | sed 's/^- //')." >>"$body"
		;;
	esac
	if [[ $(jq -r '.readme_changed // false' "$res") == true && -n $v ]]; then readme_issue "$v" "$res"; fi
	if ((red == 0)); then
		if [[ $state == landed ]]; then
			if issues_json open | jq -e --arg p "follow: $v — " 'any(.title | startswith($p))' >/dev/null; then
				upsert_issue "follow: $v — " "follow: $v — landed" landed "$body"
			fi
		fi
		return 0
	fi
	upsert_issue "follow: ${v:-?} — " "follow: ${v:-?} — $state" "$state" "$body"
	return 1
}

# Lines already starting with "- ": the rest of the line made safe.
md_item_keep() { sed 's/^- //' | md_item; }

readme_issue() {
	local v=$1 title="README: after $1" f
	if issues_json all | jq -e --arg t "$title" 'any(.title == $t)' >/dev/null; then return 0; fi
	if [[ ! -s ${FOLLOW_README_DIFF:-$OUT/readme.diff} ]]; then
		jq -r '.readme_diff // ""' "$2" >"$TMP/readme.diff"
		FOLLOW_README_DIFF=$TMP/readme.diff
	fi
	{
		echo "$ORIGINAL_NAME $v changed its README. The fork keeps its own (docs/FOLLOWING.md 2.5); what is new may need"
		echo "describing in the fork's words. This blocks nothing."
		echo
		if [[ -s ${FOLLOW_README_DIFF:-$OUT/readme.diff} ]]; then
			f=$(fence_for "${FOLLOW_README_DIFF:-$OUT/readme.diff}")
			echo "${f}diff"
			head -c 60000 "${FOLLOW_README_DIFF:-$OUT/readme.diff}"
			echo
			echo "$f"
		fi
	} >"$TMP/readme.md"
	gh issue create -R "$REPO" --title "$title" --body-file "$TMP/readme.md" >/dev/null
	say "issue opened: $title"
}

# report-publish VERSION RESULT: RESULT success closes "publish: VERSION — failed"; anything else opens or updates it.
cmd_report_publish() {
	local v=${1:?} result=${2:?} prefix
	prefix="publish: $v — "
	if [[ $result == success ]]; then
		for n in $(issues_json open | jq -r --arg p "$prefix" '.[] | select(.title | startswith($p)) | .number'); do
			gh issue close "$n" -R "$REPO" --comment "npm has $PKG $v now${RUN_URL:+ ($RUN_URL)}." >/dev/null
			say "issue #$n closed"
		done
		return 0
	fi
	{
		echo "main names $PKG \`$v\`; publishing it did not complete${RUN_URL:+: $RUN_URL}. Git installs already have it."
		echo
		echo "Jobs: $result"
		echo
		echo "After the cause is fixed: \`gh workflow run publish.yml -R $REPO\` (docs/FOLLOWING.md 4.3)."
	} >"$TMP/pub.md"
	upsert_issue "$prefix" "${prefix}failed" failed "$TMP/pub.md"
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
prepare) cmd_prepare ;;
fetch-candidate) cmd_fetch_candidate "$@" ;;
plan) cmd_plan ;;
report) cmd_report ;;
report-publish) cmd_report_publish "$@" ;;
*)
	sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
	exit 2
	;;
esac
