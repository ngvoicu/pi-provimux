# pi-provimux: following the original, versions, npm, the mirror, the rename

**Status: live.** Scheduled `follow` runs land a release of the original that passes, and `publish.yml` publishes
it, with no person in between: the owner's choice of fully automatic releases (2.8, the risk he accepted in 6.2). A
dry run is only one asked for by hand with `dry_run=yes` (4.5). When a build shows this file wrong, it is corrected.

**pi 1.6.0 or newer only** (the owner's decision of 2026-11-24). `peerDependencies` say `>=1.6.0`, the lockfile's pi
is 1.6.0, and every check runs on it. The fork carries no code for older pi, and none for its own older versions or
their files (2.3).

- **The original:** `router-for-me/pi-cliproxyapi-provider` (MIT), npm `@router-for-me/pi-cliproxyapi-provider`.
- **The fork:** `ngvoicu/pi-provimux` on GitHub (renamed from `ngvoicu/pi-cliproxyapi-provider` on 2026-11-22),
  npm `pi-provimux`.
- **The pattern it borrows from:** Provimux's `.github/provimux/SYNC.md`. This extension is much smaller: no build,
  no binary, one `npm run check`, so most of that machinery is left out. What is kept is its trust shape: the jobs
  that run the original's code can do nothing else, and the job that publishes runs none of it.

Facts in this file were read on 2026-11-21 (repository state, pi's package manager, npm's and GitHub's
documentation) and checked while building ([9](#9-what-was-checked-while-building)).

## 1. In short

1. Every 3 hours a workflow looks at the original's newest **release**: the version npm calls `latest`, and the
   commit on the original's `main` that set that version. Not the head of its `main`.
2. A release is taken once it has been public for 24 hours.
3. It is **merged** into `main`, never rebased: `main` only ever moves forward.
4. Before anything lands, the merged tree must pass `npm run check` (typecheck, lint and all tests, the fork's
   included) and a guard that refuses what tests cannot judge: new runtime dependencies, install scripts, new kinds
   of files, workflow files, a licence change.
5. A conflict, a failed check or a refusal lands **nothing**; the owner is told in an issue, once per state.
6. A clean update lands on `main` by itself and is published to npm by itself, with provenance, through npm trusted
   publishing. The repository holds **no secret at all**.
7. The version shows the original's version: `105.0.1` is the first pi-provimux release on the original's `1.5.0`.
8. The owner's Forgejo mirror follows GitHub hourly, fast-forward only. People push to GitHub only.

| Piece | File | What it is |
|---|---|---|
| Follow | `.github/workflows/follow.yml` | Finds the release, merges, checks, lands, starts the publish, reports. |
| Publish | `.github/workflows/publish.yml` | Publishes the version `main` names when npm lacks it; tags it. The only workflow npm trusts. |
| The scripts | `.github/follow/` | What both workflows and the owner's Mac run: select, merge, manifest rule, guard, stamp, report. |
| The path list | `.github/follow/paths.txt` | The paths the original may change without the owner. |
| The mirror | `.forgejo/workflows/follow-github.yml` | Runs on the NAS only: brings its `main` and tags up to GitHub's. |

## 2. Following the original

### 2.1 What is followed

The original releases by a version-bump commit on `main` followed by an `npm publish`; its git tags stopped at
`v1.4.23` and it has no GitHub releases to read. So a **release of the original** is defined from both sides:

1. `V` = the `latest` dist-tag of `@router-for-me/pi-cliproxyapi-provider` on npm. It must be a plain `X.Y.Z`
   (no pre-release part), newer than the version `main` is built on.
2. `B` = **the bump commit** of `V`: on the first-parent history of the original's `main`, the one commit whose
   `package.json` says `V` while its parent's says something else.

Both must exist. A version on npm with no bump commit on the original's `main`, or two such commits, is reported and
nothing lands.

3. **`B` is what npm ships, both ways.** Before anything is merged, npm's tarball of `V` is downloaded from
   `https://registry.npmjs.org/` only, checked against the registry's `sha512` integrity, its headers pre-scanned, then
   unpacked by npm's own `node-tar` into a fresh temporary folder (below); nothing of it runs. On the other side, `B`'s regular files are written to a temporary folder and npm lists what it would
   pack from them (`npm pack --dry-run --ignore-scripts`, from a neutral folder: nothing of `B` runs). The two must
   be the same set of files, each a regular file of `B` with the same bytes (`.github/follow/tarball.mjs compare`).
   A file that differs, a file `B` lacks, **a file `B` ships that the tarball lacks**, a link, or no tarball at all:
   `refused`. Neither `gitHead` nor npm's attestations are relied on; the original's 1.5.0 has neither, and its
   twelve files are `5a1641b`'s byte for byte. This binds the shipped files to the commit both ways, so a rewritten
   branch cannot bring another tree under an aged version number, and a release that leaves out a file cannot let
   the commit's unvetted copy of it into the fork. It cannot authenticate what the tarball does not carry: the tests
   and `package-lock.json` (2.6 guards those by policy). If npm's packing rules ever differ between the original's
   npm and the runner's, the check refuses; it never passes a difference.

   **First, a strict header pre-scan, independent of any `node-tar` version** (`.github/follow/headers.mjs`).
   Versions of `node-tar` do not all read the same headers the same way. A global PAX `size` and a per-file PAX
   `size` that disagree give a README 79 bytes under npm 11.19.1's `node-tar` 7 and 78 under npm 10.9.3's
   `node-tar` 6. npm 10 ships with Node 22.19.0, the package's minimum Node, so users can still install with it.
   So before any extraction, the raw tar headers are read, only to classify them, never to take a file's bytes.
   The tarball is refused unless it is one gzip member (no gzip name, extra field or comment), and every header is:
   - a plain ustar regular file (`0`) or directory (`5`, size 0) under `package/`, with a valid checksum, plain
     octal numbers and no link target. Its path has no empty, `.` or `..` segment, appears once and is ASCII
     unless a PAX path gives it;
   - or a **per-file** PAX header (`x`) with only the keys `npm pack` writes. That is `path`, `mtime` and `size`,
     and `size` must equal the following header's own size. It must be followed by the file or directory it
     describes.

   `npm pack` (pacote's `portable: true`) writes exactly `path`, `mtime` and `size`, the same bytes with npm
   10.9.3 and 11.19.1. For `docs/café.md` that is `path=package/docs/café.md`, `mtime=499162500`, `size=6`. It
   never writes `atime`, `ctime`, `charset`, `comment`, owners or `linkpath`, the last only for links, which it
   does not pack. Refused before extraction: a global PAX header (`g`), GNU `L`/`K`, any link, any other type or
   PAX key, a dangling PAX header, a lone zero block and any data after the two end blocks. Afterwards, the files
   `node-tar` writes must be exactly those the pre-scan saw.

   **No file's bytes are taken from that scan.** The tarball is extracted by **npm's own `node-tar`, the copy bundled
   with the job's npm** (found from that npm's install, `npm root -g` with no user or global configuration, and
   checked to be the install of the `npm --version` on `PATH`; never from the repository's dependencies), and
   extracted **with the options npm's `pacote` uses when it installs a package** (strip the first folder, no
   chmod, no mtime, no owner, links filtered out, `.gitignore` read as `.npmignore`) into a fresh temporary folder
   (`.github/follow/nodetar.mjs`). The files so extracted are what is compared with `B`, both ways. So the check
   sees what npm installs, by construction. A PAX name such as `docs/café.md`, which `npm pack` writes for any
   non-ASCII name, reads as npm reads it. What the pre-scan let through reads the same under npm 10's and npm 11's
   `node-tar`. Also refused, as a second line: any link or entry outside `package/` that `node-tar` lists (with the
   `onentry` callback, which both `node-tar` 6 and 7 call), any warning of `node-tar`, and a job whose npm has no
   bundled `node-tar` or none whose version can be read. The registry's `sha512` is
   checked before the tarball is read. The original's 1.5.0 passes.

Every string from upstream is checked before it is used: versions are tokens of `[0-9A-Za-z.+-]` (anything else reads
as `!`), only plain `X.Y.Z` versions with at most six digits a part reach arithmetic, and the old base's version is
read back from its commit. A version asked for by hand is checked before it is shown. Inside GitHub Actions, the
script stops runner commands (`::stop-commands::`) for everything it prints.

Why not the head of the original's `main`: commits between two bumps are work the original has not released
(`90611c1 feat: add Ultra Fast mode` stood on `main` before `5a1641b` bumped to 1.5.0). The fork ships what the
original shipped, nothing earlier. Why npm as well as git: npm's publish time is set by the registry, so the wait
below cannot be shortened by a commit with a false date.

The base of `main` (**the old base**) is read from git, never stored: the newest bump commit of the original that
is an ancestor of `main`, and the version in its `package.json`.

### 2.2 When

- **Schedule:** every 3 hours (`cron: '47 */3 * * *'`), and by hand (`workflow_dispatch`). One run at a time.
- **The wait:** `V` is taken when npm published it at least **24 hours** ago (`FOLLOW_WAIT_HOURS` in `follow.yml`).
  A run that finds a younger `V` ends green and says when it will be taken; no issue. Because only `latest` is
  looked at, two releases in quick succession (1.4.26 and 1.5.0 came 54 minutes apart) make the fork wait for the
  second one and skip publishing the first on its own.
- **By hand:** `gh workflow run follow.yml -R ngvoicu/pi-provimux`, with the inputs `version` (a published version
  of the original newer than the old base; empty = `latest`) and `no_wait` (take it now).

GitHub disables scheduled workflows of a public repository after 60 days without repository activity, and mails the
owner before it does. If the original is silent that long: `gh workflow enable follow.yml -R ngvoicu/pi-provimux`.

### 2.3 Merge, not rebase

`main` takes a release by a merge commit. It is never rewritten.

- **`main` is public and is itself a release channel.** A git install (`pi install git:github.com/ngvoicu/…`)
  follows `main`: whatever lands there reaches those users at their next `pi update`, before and whether or not
  npm gets a version. Tags and npm provenance point at commits of `main`; with a merge they stay its ancestors.
- **What `pi update` does with a git install** (read in pi-coding-agent 1.6.0, `dist/core/package-manager.js`,
  `ensureGitRef`): it fetches the branch, then `git reset --hard` to it, `git clean -fdx`, and installs
  dependencies. So pi itself would survive a rewritten `main`. Everything else would not: a plain clone or a fork
  of this repository, a `git pull`, and the Forgejo mirror, which is fast-forward only by design and would stop.
- **Nothing forces.** The automation pushes with a plain `git push`, which git refuses unless it is a
  fast-forward, and a ruleset forbids force pushes to `main` for everyone.
- **A conflict is resolved once.** With a rebase, every patch of the fork meets every release again.
- **The cost:** the fork is no longer "the original plus N patches" in the log. What the fork changes is read with
  `git diff router-for-me/main...main`.

**Where the fork's code differs from the original's on purpose.** A release of the original that touches these
lines stops in a conflict, and the resolution keeps the fork's side:

- **No `cliproxyapi` name.** The original's names are `cliproxyapi` throughout; the fork's are `provimux`, with no
  fallback to the old ones (the owner's decision of 2026-11-24):

  | The original | The fork |
  |---|---|
  | provider id `cliproxyapi`, name `CLIProxyAPI` (`DEFAULT_PROVIDER_ID`/`_NAME`, `lib.ts`) | `provimux`, `Provimux` |
  | settings `cliproxyapi.json`, models cache `cliproxyapi-models.json` | `provimux.json`, `provimux-models.json` |
  | `CLIPROXYAPI_*` environment variables | `PROVIMUX_*` |
  | API id `cliproxyapi-codex-responses`, `CLIPROXYAPI_CODEX_API` | `provimux-codex-responses`, `PROVIMUX_CODEX_API` |
  | `CliproxyCodexStream*`, `CliproxyConfigFile`, `loadCliproxyCodexStreams` | `ProvimuxCodexStream*`, `ProvimuxConfigFile`, `loadProvimuxCodexStreams` |
  | global keys and temp names `pi-cliproxyapi-provider…`, status key `cliproxyapi-fast-refresh` | `pi-provimux…`, `provimux-fast-refresh` |
  | `cliproxyapi.example.json` | `provimux.example.json`, without `providerId`/`providerName` |

  `extensions/index.ts`: the original passes `[identity.providerId, "cliproxyapi"]` to the Codex stream loader; the
  fork passes `[identity.providerId]`. `resolveIdentity` is the original's: a value in the settings file or the
  environment is used as written. A release of the original that brings a new `cliproxyapi` name (an identifier, a
  variable, a file name, a provider id) is renamed in the resolution; a clean merge can still bring one in, and no
  guard looks for it: after a merge, `grep -rnE 'cliproxyapi|CLIPROXYAPI|Cliproxy' extensions test` should show nothing.
  `.github/follow/paths.txt` keeps the original's `cliproxyapi.example.json`: it lists the original's paths, and a
  change the original makes there conflicts with the rename.
- **No code for pi before 1.6.0.** `extensions/codex-stream.ts`: the original carries a mid-conversation effort patch
  for pi-ai 1.3 to 1.5 (`MID_CONVO_RESOLVER_SNIPPET`, `patchMidConvoEffort`, `sharedSupportsConfigurationUpdate`,
  `hasNativeMidConvoEffort`), the classic-context path for pi before 0.86 (`adaptTranscriptContext`,
  `supportsTranscriptSource`, `adaptContextForModule`) and the move of the `instructions` pi before 1.6.0 built; the
  fork has none of them. pi 1.6.0 does that work itself; the fork keeps only what still acts on 1.6.0 (the
  configuration_update placement, the default GPT base prompt, a hook's `instructions`). A resolution does not bring
  them back.
- **No reader of the fork's own older values.** A settings value is read as written, no old file name or variable
  is read, and `claudeMessagesMode` reads only `"on"` and `"auto"` (anything else is `"off"`).
- **No other host and no install layout pi 1.6.0 does not have.** The original's support for Oh My Pi (the
  `.omp/plugins` module paths, its key-based settings API in `auto-compact.ts`, a context's `sessionId`) and for
  `~/.pi/runtime`, `~/.pi/bin/pi` and a flat `dist/openai-codex-responses.js` is gone from the fork.
- **Provimux 8.1.1-pmx.1 or newer names what answered.** An answer that gives the kind without the provider names
  nobody; the original's guess from the credential list for such an answer is gone.
- **No guard for an API pi 1.6.0 has.** `getPackageDir`, `closeOpenAICodexWebSocketSessions` (`codex-stream.ts`),
  `theme.getColorMode` (`fast-footer.ts`), `getBuiltinModels` (`lib.ts`, `upstreams.ts`), pi's model resolvers and
  the registry's `getAvailable`/`hasConfiguredAuth` (`thinking-levels.ts`) are called without a `typeof` or `?.`
  check.

The CLI test (`test/cli.test.ts`, "the provider id, in pi's CLI") fails if the models stop showing under `provimux`
or the owner-shaped setup stops answering.

### 2.4 The run: `follow.yml`

Every job checks out the run's own commit (`github.sha`, the `main` the run names) and runs **that commit's**
`.github/follow/` scripts, never a copy from the candidate.

| Job | What it does | What it runs | Permissions |
|---|---|---|---|
| `prepare` | Selects the release and binds it to npm's tarball (2.1, 2.2). Decides whether there is anything to do. Runs the guard on git objects (paths and kinds of file) before anything is written, then merges `B` into `main` in a temporary worktree, applies the file rules (2.5), stamps the version and the changelog (3) and runs the whole guard (2.6). Uploads the candidate as a git bundle. | git, `npm view` and npm's tarball (data, never run), `npm pack --dry-run --ignore-scripts` on `B`'s regular files written out (a list, nothing run), `jq`, the run's own scripts. No code of the original or of the candidate. | `contents: read` |
| `test (candidate)` | Writes the candidate's tree with `git checkout-index` (no `.git`, no export attribute) to a folder of its own, then **in a container** (pinned `node:24` image) that gets that tree, this run's scripts read-only and the network, and none of the runner's variables, tokens or caches: `npm pack` of the clean tree, before anything is installed; `npm ci`; **that archive loaded by pi's own loader** from a consumer folder of its own (`load.mjs`, 4.2); `npm run check`, on the lockfile's pi, 1.6.0 (4.2, "The pi version"). | **The original's and the fork's code, and their dev dependencies**, in the container. | `contents: read`, `actions: read` |
| `test (original)` | The same on `B` alone. Information only: it tells the owner whether a failure is the original's own. It never decides. | **The original's code**, in the container. | `contents: read` |
| `land` | Needs `prepare` and a successful `test (candidate)`. Takes the bundle by the id and digest `prepare` output, checks it is the commit `prepare` named, then **checks it again by content** (`follow.sh recheck`: the whole guard, and npm's tarball against `M`'s second parent), pushes it to `main` without force, then starts `publish.yml`. | git, `gh`, the run's own scripts. | `contents: write`, `actions: write`; environment `main-only` |
| `report` | Always. Writes the issue (2.7). | The run's own script, `gh`. | `issues: write`; environment `main-only` |

**The candidate** is two commits on top of `main`:

- `M`, the merge: parents `main` and `B`, message `Merge pi-cliproxyapi-provider <V>`.
- `R`, the release commit: `pi-provimux <new version> (pi-cliproxyapi-provider <V>)`. It changes only the version
  in `package.json` and `package-lock.json`, and `CHANGELOG.md`.

Both carry the bot's identity and `B`'s committer date, so the same inputs give the same commits and a rerun
reproduces the candidate instead of making a second one.

**Hand-over between jobs.** A job that runs the original's code holds the run's artifact token and could upload an
artifact under any name. So `land` reads the bundle by the artifact **id and digest** that `prepare` wrote as job
outputs, and takes from the test jobs nothing but their conclusion. No job uses a cache. `follow.sh fetch-candidate`
prints exactly the commit on standard output, inside Actions too: its runner-command markers (`::stop-commands::`)
go to standard error, which the runner reads for commands as well.

**The push.** `git push origin <R>:refs/heads/main`, no force. If `main` moved since `prepare` (the owner pushed),
git refuses, the run ends without landing, and the next run starts from the new `main`. A push made with the
workflow's `GITHUB_TOKEN` starts no workflow, so `land` then runs `gh workflow run publish.yml --ref main`
(`workflow_dispatch` is one of the two events that token may start).

**Nothing to do** (green, no issue): `B` is already in `main`; `V` is not newer than the old base; `V` is waiting.
When `B` is in `main` but npm lacks the version `main` names, `land` only starts `publish.yml` again.

`land` tells `report` what it did, each only once its step is done: `landed` (pushed, and `publish.yml` started),
`dispatched` (only `publish.yml` started), `dry-run` (it pushed nothing; `git push --dry-run` checked the push),
`moved` (`main` moved since the run started, or while the push was on its way: nothing lands, green, the next run
starts from the new `main`), `refused` (the recheck refused), `push-failed`, or `dispatch-failed` (`publish.yml`
did not start: red, whether the release was just landed or `land` only retried the publish of a `main` that already
had it; the issue says `publish not started`).

**Where and by whom.** Every job of both workflows runs only on github.com (`github.server_url`) and only from
`refs/heads/main`: its first step compares `GITHUB_REF` with `refs/heads/main` in the shell, exactly and
case-sensitively (Actions' own `==` ignores case). That check is part of the workflow file, and a dispatch of
another branch runs that branch's file; so **every job that can write or holds the OIDC token is also in a GitHub
environment whose deployment-branch policy admits the branch `main` alone** (6.3): `publish` in `npm`, and `land`,
`report`, `tag` and `notify` in `main-only`. GitHub refuses such a job from any other ref before it starts. What
this binds outside the YAML, and what it does not, is in 6.3.

`land`, `publish` and `tag` share the concurrency group `pi-provimux-main`, so only one of them writes at a time.
**The owner's direct pushes to `main` are outside that group**, and nothing serializes them with it. What makes that
safe is that every write re-reads `main` at the last moment: `land` pushes without force, so git refuses a push
onto a `main` that moved, and `land` reports `moved` (green; the next run starts from the new `main`); `publish`
checks, in the same step and right before `npm publish`, that the live `main` is the commit it tests, and otherwise
publishes nothing; `tag` tags only a commit of the live `main` whose `package.json` names the version. An owner's
push can still land between that last read and the registry write (seconds); the version then published is the
one that was `main` a moment before, and the owner's push starts its own `publish.yml` run.

**Self-test.** `prepare` first runs `.github/follow/test.sh` (11), so a run whose scripts are broken stops before it
merges anything.

### 2.5 Three files have a rule instead of a textual merge

The fork and the original both change the same lines of these files at every release, so a textual merge would
conflict every time (the worker's merge of 1.5.0 did, on the version). They are merged by rule
(`.github/follow/manifest.mjs` for the two JSON files), and every other file must merge cleanly.

**`README.md` is the fork's.** The merge keeps `main`'s README byte for byte, whatever the original did to its own,
conflict or not: a "clean" textual merge would put the original's install lines into pi-provimux's README. When the
original changed its README in the release, the run opens a second, non-blocking issue, `README: after <V>`, with
the original's README diff, so that what is new gets described in the fork's words. It blocks nothing.

**`package.json` is merged key by key**, three ways (old base, `main`, `B`):

| Keys | Rule |
|---|---|
| `name`, `version`, `description`, `keywords`, `repository`, `homepage`, `bugs`, `author` | The fork's, always. What the original does to them is ignored (its `version` is read as `V`, not copied). |
| `devDependencies`, `engines` | Three-way: a key only one side changed takes that side. Both sides changed it differently: stop. The original may change its development dependencies on the terms of 2.6 (the owner's decision of 2026-11-22, 6.2): only lockfile entries the root's runtime, optional and peer dependencies do not reach, each the registry's tarball of its own name and version. They are installed only in the test container, never for users and never in a job that holds a credential. |
| `peerDependencies`, `optionalDependencies` | Merged key by key, three ways (so that a merge by hand gets them right), but the original changing them at all is **a stop for the guard, the owner decides**: they can be installed on users' machines. |
| `dependencies`, `bundleDependencies`, `overrides`, `scripts`, `bin`, `files`, `pi`, `main`, `exports`, `type`, `publishConfig`, `license`, and any key the original adds | The original changed it: **stop, the owner decides.** These decide what is installed on a user's machine, what runs at install, what pi loads, what the check runs, and under which licence. |

**`package-lock.json`** is merged the same way: the entries of `packages` are compared whole, three ways; the root
entry's name and version are the fork's; both sides changed one entry differently: stop. The test job's `npm ci`
fails when the result does not match `package.json`.

### 2.6 The guard

The guard reads git objects only. Any refusal stops the run before the tests. Its paths and kinds of file are
checked **before the merge writes anything** (a link where the merge writes would otherwise be followed); the rest
after. A checker that fails to run is an error, never a pass.

1. **Paths.** Every path the original changed between the old base and `B`, and every path `M` changes on `main`,
   must be **exactly** a line of `.github/follow/paths.txt`: today's files under `extensions/` and `test/`, one by
   one, and `README.md`, `package.json`, `package-lock.json`, and the original's `cliproxyapi.example.json`. No wildcards: a new file
   of the original stops the run until the owner adds it. Refused whatever the list says, at any depth: `.npmrc`,
   `.npmignore`, `.gitattributes`, `.gitignore`, `.gitmodules` and other package or git configuration;
   `tsconfig*.json`, `biome.json`, `vitest.config.*` and other check configuration; anything under `.github/`,
   `.forgejo/` or `docs/`. Deliberately not on the list: `LICENSE`, `CHANGELOG.md`. A path that becomes a link, a
   submodule or anything but a regular file is refused, and so is one of the four files the merge writes
   (`README.md`, `package.json`, `package-lock.json`, `CHANGELOG.md`) that is not a regular file on either side.
2. **The manifest.** The stop-keys of 2.5 (what the original changed between the old base and `B`), and the
   **effective** change from `main` to `R`, whatever the merge or a resolution by hand did: only `version`,
   `devDependencies` and `engines` may differ (`manifest.mjs effective`). Then the candidate's `package-lock.json`
   (`manifest.mjs lock-check`), the development-dependency exception on these terms only:
   - the root entry is there, its `dependencies`, `devDependencies`, `optionalDependencies` and `peerDependencies`
     are `package.json`'s, and each of them has its entry `node_modules/<name>` (an optional peer excepted);
   - **"development only" is read from the lockfile's own graph**, never from its `dev` flag: an entry is what users
     would get when the lock's resolution (the nearest `node_modules/<name>` going up, as npm resolves) reaches it
     from the root's `dependencies`, `optionalDependencies` or `peerDependencies`, through the `dependencies`,
     `optionalDependencies` and `peerDependencies` of what it reaches. An entry added, changed or removed that is
     reached so, in `main`'s lock or in the candidate's, is refused, install scripts or not: the owner decides;
   - **every entry** is a `node_modules/` path whose `resolved` is exactly the registry's tarball of **that entry's
     own name and version** (`https://registry.npmjs.org/<name>/-/<basename>-<version>.tgz`; for an alias, the
     real package its `name` field names), with a full `sha512` integrity;
   - **every declaration the lock resolves to an entry asks for that entry's package, from the registry**: the
     root's four maps and each entry's `dependencies`, `optionalDependencies` and `peerDependencies`. An entry
     whose `name` differs from its key's must be asked for as that alias (`npm:<name>@…`) by every declaration that
     reaches it, and an alias declaration must reach an entry of the package it names; a declaration of another
     source (`file:`, `link:`, git, a URL, a path, `owner/repo`) refuses;
   - anything else refuses: a link, a bundled package, a git, file or other source, another package's tarball under
     this name, no root, a declared dependency with no entry, a lockfile version other than 2 or 3.

   Today 121 of the lock's 205 entries are reached from the root's `peerDependencies` (`@earendil-works/pi-ai` and
   `@earendil-works/pi-coding-agent`, which are also development dependencies), `protobufjs` and `@google/genai`
   among them: a change the original makes to those stops for the owner. The other 84 (Biome, TypeScript, Vitest,
   `@types/node` and what they bring) may change by themselves, install scripts included, because only the test
   container installs them. (pi's own git install, with its recognised npm configuration, runs
   `npm install --omit=dev --legacy-peer-deps`, which installs no root peer from this lock; the rule is stricter than
   that path, by the owner's decision of 2026-11-22. With a package manager pi does not recognise, see 6.2.)
3. **The fork's tests**: every test file the fork added *or changed* (its blob on `main` is not the old base's;
   today four of the original's test files carry fork changes) is in the candidate unchanged. Together with
   `scripts` and the check configuration being the owner's, what `npm run check` runs cannot shrink without him.
4. **The candidate's shape:** `main..R` is exactly `M` then `R`; `M`'s parents are `main` and `B`; `R` changes only
   the three files it may.
5. **The version** of `R` decodes to `V` (3).

Also refused: a `README.md` that is not `main`'s; a change to `vitest.config.ts` or to `scripts`. The shape is read
on `main`'s line (`git rev-list --first-parent main..R` is `R`, `M`): `main..R` itself also holds the original's
commits.

What pi loads from the package is not judged from the source (an import can be written many ways, and a comment
can name a file that is gone): the test jobs pack the package and load it with pi's own loader (4.2), and a package
that does not load fails the test.

### 2.7 What the owner is told

One issue per release of the original, `follow: <V> — <state>`, updated in place, with a comment only when the state
changes (a refusal that repeats every 3 hours says it once). The run is red for every state in this table.

The automation finds its issues by **the label `follow-bot` (checked on each issue, not only asked of the API), its
own author (`github-actions[bot]`) and a hidden key that is the body's very first line**
(`<!-- follow-bot:key=follow:1.5.1 -->`; the second line holds the state, `<!-- follow-state: conflict -->`), over
every page of issues, open and closed; never by title. A key anywhere else, in a quoted diff or log, counts for
nothing. It never edits an issue someone else opened. A closed issue of the same key is reopened rather than
duplicated. The failure issue is written first; the `README: after <V>` issue (its own key, `readme:<V>`) after it,
and a failed write of either does not stop the other (the run is red). Text from upstream or from a log is cut to a
budget (lists to 40 items of 300 characters, the log to its last 80 lines and 16 kB, the body to 60 kB).

| State | The issue gives |
|---|---|
| `conflict` | The files that conflicted. |
| `check failed` | The step that failed (install, the packed package's load, typecheck, lint, tests) with its output, and whether the original's own tree fails the same step. |
| `refused` | Each guard reason, and what accepting it means. |
| `no release commit` | npm's `latest` has no single bump commit on the original's `main`, or is not a plain `X.Y.Z`. |
| `land failed` | The candidate passed, the job `land` did not: see the run. |
| `landed, publish not started` | `main` has the release, `publish.yml` could not be started: start it by hand. |
| `publish not started` | `main` already had the release and npm lacked its version; `land` retried the publish and could not start `publish.yml`: start it by hand. |
| `error` | The run failed before it had a result (a fetch, npm's registry): see the run. |

A failed publish has its own issue, `publish: <version> — failed`, from `publish.yml` (4.3). It is closed only by a
publish that is not a dry run, once npm shows the version. When a release lands, its open `follow:` issue, if any, becomes `follow: <V> — landed`.

The issue is closed by the first run that finds `B` in `main` and `main`'s version on npm.

**When a run stops, the automation stops.** On a conflict, a failed check or a refusal it writes its issue and does
nothing more with that release; every later run finds the same state and says nothing new. There is **no scripted
recovery**: taking such a release is done by hand, by the owner's staff, on request, and the issue carries no
commands to run. (Until 2026-11-22 the issue and this section gave commands that ran the original's code in a
container over the operator's whole checkout and pushed `HEAD` from it; both are removed.) The subcommands `merge`,
`stamp` and `guard` of `follow.sh` stay, because `prepare` and the tests use them, and they refuse to run from inside
the tree they merge; `stamp` ends with the guard, which checks the effective change (2.6), so a key added while
resolving a conflict is refused.

### 2.8 Does it land and publish by itself?

**Yes, as designed:** a release of the original that has waited 24 hours, merges cleanly, passes the guard and the
check, lands on `main` and is published to npm with no step by the owner.

What that accepts, said plainly: the original's code is a third party's, and this extension handles the user's
proxy address and client key. Tests find a broken release; they do not find a well-made hostile one. The wait, the
guard and npm's provenance (6) narrow that; they do not close it. It is the same decision the owner made for
Provimux, with the same upstream.

If the owner wants a human step, there are two places for one, and they are not equal:

- **At the landing** (the place that actually gates): `land` opens a pull request `follow: <V>` instead of pushing,
  and the owner merges it. Git users and npm users both wait for him. One click per release of the original.
- **At the publish only:** the environment `npm` gets the owner as required reviewer, or the trusted publisher is
  left at staging only (4.2) and he approves each version on npm with 2FA. npm users wait; git users already have
  the code from `main`. This gates the smaller half and is not recommended on its own.

## 3. Versions

### 3.1 The numbering

```
<original major × 100 + original minor> . <original patch> . <pi-provimux release on that base>
```

| Built on the original's | pi-provimux versions |
|---|---|
| 1.5.0 | `105.0.1`, then `105.0.2`, `105.0.3` for the fork's own releases |
| 1.5.1 | `105.1.1` |
| 1.6.0 | `106.0.1` |
| 2.0.3 | `200.3.1` |

Read it as: the first number is the original's major and minor (`105` = 1.5), the second its patch, the third counts
pi-provimux's releases on it, from 1. The README says this once.

- **It is a plain version.** No pre-release part, so `latest`, ranges and every installer treat it as an ordinary
  release.
- **It only goes up**, in the order the releases happen: a newer base is always a greater version, and so is a
  further release on the same base. That is all `pi update` needs: for `npm:pi-provimux` it asks npm for the
  `latest` version and installs it when it is greater than the installed one.
- **Every publish goes to `latest`** (npm's default tag). No other dist-tag is used.
- **Limits:** the original's minor must stay below 100 and its version a plain `X.Y.Z`; the guard refuses anything
  else, and the scheme is revisited then. Nothing depends on this package by range, so a first number that moves
  with the original's minor costs nobody anything.
- **Git tags:** `v<version>` (`v105.0.1`), made by `publish.yml` at the published commit, never moved (a tag
  ruleset forbids updating and deleting `v*`).

### 3.2 Where the version is written

In one place: `"version"` in `package.json` on `main` (and its two copies in `package-lock.json`). What git has is
what npm gets; nothing is stamped at publish time.

- **The original's bump commits never conflict there**, because that key is the fork's by rule (2.5).
- **A new base:** `follow` writes `<base>.1` in the commit `R`.
- **The fork's own release:** whoever makes it raises the third number (`npm version patch --no-git-tag-version`
  does exactly that), adds the changelog entry, and pushes `main`. `publish.yml` publishes it. A push that leaves
  the version alone publishes nothing to npm (git installs still get it).
- **The base is never written down.** It is read from git (2.1), and the guard requires the number to agree with
  it, in `follow` and in `publish`.

`R` also prepends the changelog entry: `## <version>`, then "From pi-cliproxyapi-provider `<V>` (merged
automatically):" and the subjects of the original's commits in the release, bump commits left out. The subjects are
the original's text: written as plain list items, escaped, cut to one line each, evaluated by nothing.

When an update lands, any commits of the fork that were on `main` but not yet released go out with it. `main` is
therefore kept releasable at all times, which a git install requires anyway.

## 4. Publishing on npm

### 4.1 npm's rules today

Read on 2026-11-21 in npm's documentation (9).

- **Trusted publishing (OIDC) can be used**, from GitHub-hosted runners, with npm CLI 11.5.1 or later and Node
  22.14.0 or later. The job needs `id-token: write`. No token exists anywhere.
- **Provenance is automatic** with trusted publishing from a public repository for a public package; `--provenance`
  is not needed. `repository.url` in `package.json` must match the repository exactly, case included
  (`git+https://github.com/ngvoicu/pi-provimux.git`): so the GitHub rename comes **before** the first publish.
- **A trusted publisher is set on a package that exists.** The first version (105.0.1) was published by the owner,
  from his Mac.
- **A trusted publisher names:** the user (`ngvoicu`), the repository (`pi-provimux`), the workflow file name
  (`publish.yml`, the name only) and optionally an environment (`npm`). All case-sensitive. npm does not check them
  when they are saved; a mistake shows at the first publish.
- **Staging is the default; direct publishing is a box to tick.** A publisher created now may always
  `npm stage publish` (the version waits on npm, not public, until a maintainer approves it with 2FA). `npm publish`
  itself is allowed only if chosen (`--allow-publish`). Automatic publishing needs it.
- **A new trusted publisher must publish within 2 days**, or it expires and is made again. So it is created when
  the first automatic release is ready to go.
- **Tokens:** only granular tokens exist; publishing directly with a token is announced to end in January 2027. No
  token is part of this design.
- **After it works:** the package's publishing access is set to "Require two-factor authentication and disallow
  tokens". Trusted publishing keeps working; no token can publish.

### 4.2 `publish.yml`

It publishes **the version `main` names, if npm does not have it**. It reads state, not events, so a rerun is
always safe.

Triggers: `push` to `main` (the owner's pushes), `workflow_dispatch` (how `follow` starts it, and "publish now").
One run at a time, never cancelled midway.

| Job | What it does | What it runs | Permissions |
|---|---|---|---|
| `plan` | Names `main`'s version first, from git alone, so that every outcome, an early refusal included, reaches `notify`. Refuses an `.npmrc` anywhere in the tree before npm runs on it (only the version check, 6.1, comes first). Asks npm, from a neutral folder with no configuration and `--registry=https://registry.npmjs.org/`, whether it has that version: yes, nothing to publish, go to `tag`. Otherwise the publish guard (below). | git, `jq`, `npm view`, `npm pack --dry-run --ignore-scripts`. No repository code. | `contents: read` |
| `test` | Writes that commit's tree with `git checkout-index` to a folder of its own (no `.git`; the workspace, whose `.git` the checkout action's cleanup opens afterwards with a credential, is never given to the container). In the same container as `follow`'s tests: `npm pack` of the clean tree, before anything is installed; then, on the runner and still before any dependency code runs, that archive's sha512 recorded as the job's output and the archive uploaded as the artifact `publish-archive` ("The tested archive", below); `npm ci`; that archive loaded by pi (below); `npm run check`, on the lockfile's pi (below). | **The repository's code and dev dependencies**, in the container. | `contents: read` |
| `publish` | Needs `plan` and `test`. Checks out the commit with no stored credential. Takes **the archive `test` packed, loaded and checked** (`follow.sh archive`, below). Then **in one step** checks that archive's sha512 again, that the tree is clean and that the live `main` is still that commit, and runs `npm publish --ignore-scripts --access public --registry https://registry.npmjs.org/ <that archive>`. | `git`, the npm CLI, the run's own scripts (`follow.sh archive`, `tarball.mjs`). **No code of the package:** no `npm ci`, no lifecycle script, no build, no pack. | `id-token: write`, `contents: read`, `actions: read` (the artifact); environment `npm` |
| `tag` | `follow.sh tag`: the tag `v<version>` at the commit just published, which must be in the live `main` and whose `package.json` must name that version, and the GitHub release with the changelog entry; a missing release is made even when the tag exists. When the version was already on npm (repair), the commit npm recorded (`gitHead`), else the existing tag, each only if it is in the live `main` **and its `package.json` names the version**; with neither, the job **fails** and `notify` tells the owner to make the tag. An annotated tag is followed to its commit. | git, `gh`, `npm view`, the run's own script. | `contents: write`; environment `main-only` |
| `notify` | After a failure: the issue `publish: <version> — failed` (`publish: unknown — failed` when `main`'s version is not plain). After a success that is not a dry run, and only once npm shows the version, it closes that issue. npm lists a version a while after its upload, so `notify` asks again every 30 s for up to 15 minutes (`FOLLOW_NPM_SHOW_WAIT`, `FOLLOW_NPM_SHOW_POLL`); only a version still missing then counts as a failed publish. | The run's own script, `gh`, `npm view`. | `issues: write`; environment `main-only` |

**The publish guard** (`plan`):

- the name is `pi-provimux`, `repository.url` is exactly the repository's, `private` is not set;
- the version has the form of 3.1, decodes to the base git shows, and is greater than npm's `latest`;
- `scripts` has no lifecycle script (`preinstall`, `install`, `postinstall`, `prepublish`, `prepare`,
  `prepublishOnly`, `prepack`, `postpack`, `publish`, `postpublish`);
- there is no `.npmrc` in the tree (checked first, before any npm command);
- `publishConfig` is absent or exactly `{"access": "public"}` (no other dist-tag, registry or provenance setting);
- the tarball would hold only tracked files under `extensions/`, plus `package.json`, `README.md`, `LICENSE` and
  `CHANGELOG.md`, and it holds every extension `pi.extensions` registers (a nested `.npmignore` cannot leave one
  out).

**The packed package loads** (the `test` job, and `follow`'s `test (candidate)` before landing). **Before
`npm ci`**, a container packs the clean export (`npm pack --ignore-scripts`, the tree mounted read-only) into a
folder of its own: what publication builds from the same commit, never a tree an install has written into (an
install that generates a file under `extensions/` would otherwise make a package load that npm would ship without
it). After `npm ci`, a second container gets that archive read-only, and `.github/follow/load.mjs` (this run's copy,
mounted read-only) extracts the tarball as npm installs it (npm's own `node-tar` in the container, pacote's options,
as in 2.1) into a consumer folder of its own (`node_modules/pi-provimux`, nothing else of the tree), links
in only the package's `peerDependencies` from the tree's `node_modules` (what pi provides at run time), clears
`HOME`, pi's agent folder and the `PROVIMUX_*` variables, and has **pi's own loader**
(`discoverAndLoadExtensions` of `@earendil-works/pi-coding-agent`) load the package. Every registered extension must
load with no error, or the job fails and nothing lands or is published. A file the extension imports that the
tarball lacks fails here however the import is written (a template literal included); a comment naming a file
that is gone does not. This replaced a scan of the source for imports. What it does not do: run the extension's
commands or talk to a proxy; a module imported only later, on use, is not loaded.

The same publish guard applies to every route: the owner's own pushes and `follow`'s landings alike.

**The tested archive is the one published.** npm versions compress differently: on the same commit, npm 11.19.1 and
11.5.1 pack the same 16 files, byte for byte, into archives with different sha512s. So `publish` never packs
again. In `test`, right after `npm pack` and before `npm ci`, a step on the runner checks that the pack folder holds
the one file `pi-provimux-<version>.tgz`, records its sha512 as the job's output `integrity`, and copies it to a
folder no container sees, from which `actions/upload-artifact` uploads it as `publish-archive` (its id and digest
are the job's outputs too). Nothing of the package or its dependencies has run by then; the loads and checks that
follow read the same bytes. `publish` runs `follow.sh archive` with those outputs: the artifact must be
`publish-archive` of this run with that digest (as `land` takes `prepare`'s bundle, 2.4), hold that one file alone,
have the recorded sha512, and ship exactly the files npm packs from the commit, each with the commit's bytes
(`tarball.mjs compare`, the check of 2.1). Anything else refuses, and nothing is published. The publishing step
checks the sha512 once more, then runs `npm publish` on that file. With a file argument npm uploads the file's own
bytes (pacote reads the tarball as it is; checked with npm 11.20.0: `npm publish --dry-run <file>` reports the
file's sha512), and the OIDC exchange and provenance do not depend on the argument: npm exchanges the token for the
package the manifest names, and the provenance statement's subject is that name, version and the uploaded bytes'
sha512. The trusted publisher accepts it: every version since 105.0.2 was published this way.

**The pi version.** `npm ci` gives the lockfile's pi, 1.6.0, the floor `peerDependencies` name; the check step
first names it (`npm ls @earendil-works/pi-ai @earendil-works/pi-coding-agent`). `follow`'s `test (candidate)` runs
the same steps, so that nothing lands that this test would refuse. A change to that pi is a change to a lockfile
entry the root's peers reach, so the original cannot make it without the owner (2.6).

The file keeps its name and the publish job its environment `npm`: the trusted publisher names both.

**The environments** (GitHub, 6.3): `npm` for the job `publish`, which the trusted publisher names; `main-only` for
`tag` and `notify` here and `land` and `report` in `follow.yml`. Both admit the branch `main` alone; no secret; no
reviewer (unless the owner chooses the human step of 2.8). No job runs on a tag ref (the tag job makes the tag
through the API from a `main` run), so neither environment has, or needs, a tag pattern.

**The npm CLI:** Node 24 from `actions/setup-node`, pinned; the job asserts `npm --version` is at least 11.5.1 and
fails otherwise. No `NODE_AUTH_TOKEN`, and no `registry-url` for `setup-node`: with it, `setup-node` writes an
`.npmrc` with `_authToken=${NODE_AUTH_TOKEN}` (and a placeholder value), which gets in the way of OIDC.

Every action is one of GitHub's own (`actions/checkout`, `actions/setup-node`, `actions/upload-artifact`,
`actions/download-artifact`), pinned by full commit SHA.

### 4.3 When a publish fails

`main` already has the code (git installs have it); npm does not. A version npm only lists some time after the upload
is not a failure: `notify` waits up to 15 minutes for npm to show it (4.2) before it opens the issue. Nothing is retried blindly: the issue says which
step failed. After the cause is fixed, "publish now" is `gh workflow run publish.yml -R ngvoicu/pi-provimux`. If npm
took the version but the run died after, the next run finds the version on npm and only makes the tag, when npm
recorded the commit (it does not always: the original's 1.5.0 has no `gitHead`) or the tag exists, and only at a
commit of the live `main` whose `package.json` names that version; otherwise the issue names the tag to make by
hand.

**Taking a release back.** pi installs a version only when it is *greater* than the installed one, so moving
`latest` back helps new installs only. The fix is always a new, greater version: revert on `main`
(`git revert -m 1 <M>` for a merged release), raise the third number, push. `npm deprecate pi-provimux@<bad> "…"`
marks the bad one. To stop following meanwhile: `gh workflow disable follow.yml -R ngvoicu/pi-provimux`. A reverted
merge stays merged for git: the original's next release is then merged by hand (2.7), reverting the revert first.

### 4.4 Settings outside the repository

Made once (2026-11-22); the commands rebuild or check them.

1. **The two environments** (GitHub), each admitting the branch `main` alone (6.3). Before any run of either
   workflow, they must exist with this rule: a job that names an environment GitHub does not know makes GitHub
   create it with no rule.
   ```sh
   gh api -X PUT repos/ngvoicu/pi-provimux/environments/npm \
     -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true'
   gh api -X POST repos/ngvoicu/pi-provimux/environments/npm/deployment-branch-policies -f name=main -f type=branch
   gh api -X PUT repos/ngvoicu/pi-provimux/environments/main-only \
     -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true'
   gh api -X POST repos/ngvoicu/pi-provimux/environments/main-only/deployment-branch-policies -f name=main -f type=branch
   gh api repos/ngvoicu/pi-provimux/environments --jq '.environments[] | {name, deployment_branch_policy}'
   gh api repos/ngvoicu/pi-provimux/environments/npm/deployment-branch-policies --jq '.branch_policies[] | {name, type}'
   gh api repos/ngvoicu/pi-provimux/environments/main-only/deployment-branch-policies --jq '.branch_policies[] | {name, type}'
   ```
   Each must show `custom_branch_policies: true` and the one policy `main`, of type `branch`. No tag policy: no job
   runs on a tag ref.
2. **Trusted publisher** (npm 11.15 or later), by the owner:
   ```sh
   npm trust github pi-provimux --file publish.yml --repo ngvoicu/pi-provimux --env npm --allow-publish
   npm trust list pi-provimux
   ```
   Or on npmjs.com: the package → Settings → Trusted Publisher → GitHub Actions: user `ngvoicu`, repository
   `pi-provimux`, workflow `publish.yml`, environment `npm`, and tick `npm publish` under allowed actions. A new
   publisher must publish within 2 days (4.1).
3. **No tokens:** the package → Settings → Publishing access → **Require two-factor authentication and disallow
   tokens**.

There is no secret to store on GitHub.

### 4.5 The dry-run switch

Both workflows have an input `dry_run` (`yes` or `no`, default `no`) and the line
`DRY_RUN: ${{ inputs.dry_run || 'no' }}`. A run by hand chooses; a scheduled `follow` run and a `push` to `main` have
no input and take the fallback, `no`: **they are live.** A dry run is one started by hand:
`gh workflow run follow.yml -R ngvoicu/pi-provimux --ref main -f dry_run=yes` (or `publish.yml`).

In a dry run everything is checked and nothing changes: `follow`'s `land` fetches and rechecks the candidate, checks
the push with `git push --dry-run`, and says what it would push and start; `publish` runs every check and
`npm publish --dry-run` on the tested archive, run with `ACTIONS_ID_TOKEN_REQUEST_URL`,
`ACTIONS_ID_TOKEN_REQUEST_TOKEN` and `NPM_ID_TOKEN` removed from its environment: npm asks for the OIDC token before
it looks at `--dry-run`, and without those variables it skips that exchange (npm 11.20.0, `lib/utils/oidc.js`), so
nothing is exchanged and nothing uploaded; `tag` says which tag
and release it would make. Failure issues are still written; a dry run never closes one, neither `follow`'s
`report` nor `publish`'s `notify` (`DRY_RUN` unset counts as a dry run). The `publish` job still
enters the environment `npm` and holds `id-token: write`; it uses neither.

**The switch** is one commit: in `.github/workflows/follow.yml` and `.github/workflows/publish.yml`,
`default: '…'` ("the switch (1 of 2)") and `inputs.dry_run || '…'` ("the switch (2 of 2)"), four lines in all.
**To put the dry run back**, for example while a
release of the original is in doubt, change the four lines back to `'yes'`, in one commit pushed by a person (the
workflows' own token cannot change workflow files); or, at once and without a commit,
`gh workflow disable follow.yml -R ngvoicu/pi-provimux` stops the scheduled runs. A single dry run without the
commit: `gh workflow run follow.yml -R ngvoicu/pi-provimux --ref main -f dry_run=yes` (and `publish.yml`
likewise).

Before **any** run of either workflow, dry or not, the environments `npm` and `main-only` must exist with their
branch rule (4.4, 6.3): a job that names an environment GitHub does not know makes GitHub create it with no
rule.

## 5. The Forgejo mirror

`.forgejo/workflows/follow-github.yml`, the site's workflow with tags added:

- **Where it runs:** on the owner's Forgejo (the NAS) only. GitHub reads `.github/workflows/` and never sees it.
  Forgejo, while `.forgejo/workflows/` exists, ignores `.github/workflows/` (as the site's workflow states and its
  NAS shows, and Forgejo's documentation now says): on the NAS this is the only workflow, so `follow` and `publish`
  never run there. **Every revision of this repository that has `.github/workflows/` without
  `.forgejo/workflows/` has exactly one of two known files there**: `main`'s 105.0.1 revisions, whose only workflow is
  the tag-triggered `publish.yml` of `dad67d5` or of `ecce622` (blobs `67b7efe` and `96781b1`), each checking the
  server in both its jobs; the branch `follow`'s history was arranged so that it has none, and `test.sh` checks every
  commit against those two blobs. Every GitHub job also runs only when the server is
  github.com. **The deploy is one ref update:** the NAS's `main` moves straight to the merged tip, never through
  an intermediate revision.
- **When:** hourly (`cron: '13 * * * *'`), and by hand.
- **What:** fetches `main` and the `v*` tags from `https://github.com/ngvoicu/pi-provimux.git` into fully qualified
  refs (`refs/remotes/…`), with a fresh inventory of GitHub's tags every run (the tracking namespace
  `refs/remotes/github-tags/` is emptied first and the fetch prunes it, so a reused workspace cannot remember a tag
  GitHub no longer has), checks everything, then pushes `main` and the new tags in **one `git push --atomic`**, with
  `--force-with-lease` on the NAS's `main` at the commit it read. **The NAS is a mirror:** `main` is a fast-forward
  when it can be one; when GitHub's `main` is not a descendant of the NAS's (GitHub's `main` was rewritten, or the
  NAS got a commit GitHub lacks), the same push first keeps the NAS's `main` as `refs/nas-backup/main-<UTC time>`
  (e.g. `main-20261122T151300Z`), so no commit is ever lost on the NAS, then sets `main` to GitHub's. If a `v*` tag
  is on GitHub differently or not at all, or the server refuses any ref (the backup included), nothing changes: a
  tag is never moved, only reported. No merge commit; GitHub is only read. The backups:
  `git ls-remote origin 'refs/nas-backup/*'`.
- **Permissions:** `contents: write` on the NAS's own repository, given to `actions/checkout` pinned by commit
  (`11d5960…`, v4.4.0, the same commit on data.forgejo.org and GitHub). Otherwise git only, on a public address,
  with no secret. It does not judge tags (semver, ancestry, npm): it copies GitHub's `v*` tags, which a ruleset
  protects there.
- **Other branches** are not mirrored.

**Nobody pushes to the NAS.** Locally the remotes keep the names every repository of the owner uses: `origin` is the
NAS, `upstream` is GitHub, `router-for-me` is the original. Work is pushed to `upstream`; `origin` catches up
within the hour. The push addresses of `origin` and `router-for-me` are set to fail on purpose
(`git remote set-url --push origin no-push-the-NAS-follows-GitHub`, and the same for `router-for-me`).

The Forgejo repository needs Actions switched on and a runner that serves `ubuntu-latest`, as the site's has.

## 6. Security

### 6.1 Which jobs run the original's code

| Job | Runs | Token | Secrets | Can push or publish |
|---|---|---|---|---|
| `follow.yml` → `test (candidate)` | the merged tree: `npm ci`, `npm run check` | `contents: read` | none | no |
| `follow.yml` → `test (original)` | the original's release alone | `contents: read` | none | no |
| `publish.yml` → `test` | `main`: `npm ci`, `npm run check` | `contents: read` | none | no |

These three are the only jobs that install dependencies or execute anything from the tree. None has `id-token`,
none declares an environment, and there is no secret in the repository for them to find. The code runs **in a
container** (`node:24.22.3-bookworm-slim`, pinned by digest) that is given the network and two folders: the tree,
written by `git checkout-index` into a folder of its own under `$RUNNER_TEMP` (no `.git`), and this run's
`.github/follow` scripts, read-only. Never the workspace: its `.git` is what the checkout action's post-step opens,
with the job's credential, after the dependency code is done; nothing a later step reads or runs is in a folder the
container can write. Nothing of the runner: no `GITHUB_TOKEN`, no Actions runtime token (so no artifact or cache
writes), no `GITHUB_*` file, no sudo, all capabilities dropped. No job uses a cache, and every `setup-node` has
`package-manager-cache: false`. What leaves them is their conclusion and nothing else: no later job reads a file
they wrote (2.4). The one exception is `publish.yml`'s `test`, whose archive `publish` uploads: it is fixed (its
sha512 recorded, the archive uploaded) by steps on the runner before any dependency code runs, and `publish` checks
it against that record and against the commit (4.2).

**No job that holds a credential installs dependencies or runs their scripts.** `npm ci` runs only in these three
jobs, inside the container, which is the one place development dependencies and their install scripts run. The
credentialed jobs (`land`, `report`, `plan`, `publish`, `tag`, `notify`, and `prepare` with its read token) run
`npm view`, and `npm pack` / `npm publish` with `--ignore-scripts`, which install nothing; this was already so and
needed no change. `test.sh` checks it in the workflows and in `follow.sh`.

**`--ignore-scripts` is not enough on npm 10, so the follow scripts hold two more locks.** npm 10.9.3 (Node
22.19.0's) still starts a tree's `prepare` script on `npm pack --dry-run --ignore-scripts`, even with
`npm_config_ignore_scripts=true`. That shell inherits the caller's environment, so `GH_TOKEN` in `land`'s
environment would reach upstream code. npm 11.19.1 starts no hook.
1. **One helper for every npm call** (`follow.sh`'s `npm_env`; `nodetar.mjs` does the same). npm runs from a
   neutral folder with `env -i`, given only `PATH`, a throwaway `HOME`, `npm_config_userconfig` and
   `npm_config_globalconfig` pointing at empty files, `npm_config_ignore_scripts=true` and the registry. No
   `GH_TOKEN`, `GITHUB_TOKEN`, `NODE_AUTH_TOKEN`, `ACTIONS_*` or any other variable reaches npm, or anything it
   starts.
2. **npm 11.5.1 or later, or no run.** At the top of the dispatcher, **every command** first checks
   `npm --version`. That includes `merge`, which selects and dry-packs the release like `prepare`, and any unknown
   word. There is no list of commands to keep up to date; only a plain help (no command, `help`, `-h`, `--help`)
   skips the check. Older npm stops the run with the reason, before any other npm call. Every job that runs
   `follow.sh` sets up Node 24 with `actions/setup-node` first, and `test.sh` checks this. In `test (candidate)`
   that is on the host, only for this check, before the candidate's tree is written out; its code still runs only
   in the container.

**What remains:** the container has the network (npm needs it), so code in it can reach anything public; the
runner around it still holds its runtime credential, which a container escape would expose; and the job's own
token (`contents: read`, `actions: read`) is used by the step before, outside the container.

The jobs that can change something run none of that code:

| Job | Can | Runs |
|---|---|---|
| `follow.yml` → `land` | push `main` (fast-forward), start `publish.yml` (environment `main-only`) | git, `gh`, the run's scripts (recheck) |
| `publish.yml` → `publish` | publish to npm (OIDC, environment `npm`, `main` only) | git, the npm CLI with `--ignore-scripts` |
| `publish.yml` → `tag` | create a `v*` tag and a release (environment `main-only`, live `main` only) | git, `gh`, the run's script |
| `report`, `notify` | write issues (environment `main-only`) | the run's own script, `gh` |

There is no `pull_request_target` workflow and none is added. A workflow run for a pull request from a fork gets a
read-only token and no `id-token`.

### 6.2 What stops a hostile or broken upstream commit from being published

In the order a commit meets them:

1. **Only a release.** A commit is taken only as part of a version the original published on npm as `latest`, and
   only up to that version's bump commit, whose files must be the bytes npm ships (2.1). A push to the original's
   `main` alone changes nothing here.
2. **The wait.** 24 hours from npm's own timestamp. A release that is pulled or replaced inside that time never
   arrives.
3. **A clean merge.** Any conflict outside the three ruled files stops it.
4. **The guard** (2.6). The things a test cannot judge need the owner: a runtime dependency, any lockfile entry the
   root's `dependencies`, `optionalDependencies` or `peerDependencies` reach, an install script of the package itself
   (pi runs `npm install --omit=dev --legacy-peer-deps` in a git install, so a `postinstall` would run on the user's
   machine), `bin`, `files`, the `pi` manifest, the licence, the test configuration, an `.npmrc`, a workflow file,
   any new kind of path, and any key a merge or its resolution changes besides the version, `devDependencies` and
   `engines`.
5. **The check.** Typecheck, lint and every test, the fork's own included, on the merged tree. This is what catches
   a *broken* release.
6. **The publish runs none of it.** `npm publish --ignore-scripts` of the tested archive, at a clean checkout of the
   live `main`, in a job that installed nothing, with the registry fixed on the command line; the publish guard
   (4.2) runs before it, and the very archive published has been loaded by pi and checked in the test container,
   and compared with the commit, file by file.
7. **Only `main`, only forward.** The environments `npm` and `main-only` admit only `main` (6.3); `main` cannot be
   force-pushed; `v*` tags cannot be moved.
8. **Afterwards.** Every version on npm carries provenance: the workflow, the run and the commit it came from. A
   bad release is answered by a greater version (4.3).

**What is left, and accepted by the owner.** Hostile code that merges cleanly, touches only existing source files,
passes the tests and survives a day in public lands on `main` (git installs get it at their next `pi update`) and
is published to npm. Nothing automatic sees it. A merge also makes the original's whole history reachable from
`main`: an intermediate change the original later reverted stays in git history even though the guard, which
compares trees, never sees it in the installed files.

**The owner's decision, 2026-11-22:** "make it fully automatic and write tests". Landing and publishing stay
unattended: no pull request and no approval step (2.8's human steps are not taken). The security review of
2026-11-22 (finding 1) found this residual risk; the owner accepts it. What narrows it, all automatic: only npm
releases, bound byte for byte and both ways to their commit (2.1); the 24-hour wait; an exact list of paths and no
new file without him; no runtime, optional or peer dependency, no lockfile entry users would get, no install script
of the package itself and no check configuration changing without him (2.5, 2.6); development dependencies only on
the terms below; the fork's tests, its changes to the original's tests included, kept; the original's code run in
a container without the runner's credentials (6.1); the delivered package loaded by pi before it lands and before
it is published (4.2); and the changelog entry and release of every update.

**Development dependencies, decided 2026-11-22 as part of the same acceptance, and narrowed the same day.** This is
the one exception to "no dependency changes without him", and it holds only on these terms (2.6): a lockfile entry
may be added, changed or removed by the original without the owner only when **the lockfile's own graph** does not
reach it from the root's `dependencies`, `optionalDependencies` or `peerDependencies` (in `main`'s lock or the
candidate's; the `dev` flag is never read), and every entry resolves to **the registry's tarball of its own name
and version** with a full `sha512`. Anything else refuses. Their install scripts run in the test container only. A
hostile development dependency can therefore make the tests pass whatever the code does: the same class of risk as
hostile code passing CI, accepted with it. By the graph, it reaches no user of an npm install (a package's
development dependencies are never installed for its users) nor of pi's git install as pi runs it with its
recognised npm configuration (`npm install --omit=dev --legacy-peer-deps`), and no credential (6.1). **One
qualification:** with a package-manager command pi does not recognise (an uncommon choice in the user's pi
settings), pi runs a plain install in the git checkout, which installs development dependencies too; a git
install so configured gets them, install scripts included. npm installs (`pi install npm:pi-provimux`) are not
affected. Today this covers 84 of the lock's 205 entries; the other 121, reached from the root's peers, stop
for the owner.

Two more residual points: the test jobs' result is produced by the code they run, so a hostile release can make
its own tests pass (they guard against breakage, not intent); and whoever can push to this repository can publish,
by pushing a new version to `main`. That is the owner alone: the repository has no collaborators.

### 6.3 Settings the design relies on

- **Ruleset on `main`:** no force push, no deletion. (No required pull request: `land` pushes directly.)
- **Ruleset on tags `v*`:** no update, no deletion.
- **Environments `npm` and `main-only`:** each with a deployment-branch policy that admits the branch `main` alone
  (custom policies, one policy `main` of type `branch`; the `gh api` commands are in 4.4); no secret, no
  reviewer. `npm` holds the job `publish` (`id-token: write`); `main-only` holds every other job that can write:
  `land` and `report` (`follow.yml`), `tag` and `notify` (`publish.yml`). The jobs that only read declare none. No
  job runs on a tag ref, so neither needs a tag pattern; if a workflow ever published from a tag, its environment
  would need a `type=tag` policy for `v*`, which would also admit any `v*` tag ref anyone with push access creates.
  **What this binds outside the YAML, and what it does not.** GitHub refuses a job that names one of these
  environments from any ref but `main`, before it starts, whatever the branch's workflow file checks. And npm's
  trusted publisher names the environment `npm`, so an OIDC token from a job outside it, from any ref, cannot
  publish: that binding holds even against a branch whose workflow drops the `environment:` line. The
  `GITHUB_TOKEN`'s write permissions are not bound that way: a branch's workflow that omits the environment still
  gets the permissions it asks for, for that run. That requires push access to the repository (the owner alone),
  which can write `main` directly anyway. The in-job `GITHUB_REF` check stays in every job. Each job in an
  environment records a deployment on GitHub (one per `report` run, every 3 hours); that is noise, not a cost.
- **Issues:** on (they are off today, as on every GitHub fork).
- **Repository secrets:** none, ever. A workflow that needs one is a change to this design.
- **npm:** 2FA on the account; trusted publisher as in 4.4; tokens disallowed for the package.

## 7. Open: the owner's project

The repository was renamed from `pi-cliproxyapi-provider` on 2026-11-22, and the owner's pi installs
`npm:pi-provimux`. One step of the owner's own is open (as of 2026-11-23): twelve files under his project's `v1/`
(and one README there) still load the extension by the path of pi's old git checkout,
`pi -e ~/.pi/agent/git/github.com/ngvoicu/pi-cliproxyapi-provider/extensions/index.ts`. The npm install lives in
`~/.pi/agent/npm/node_modules/pi-provimux/`; the change, in that project and only by him:

```sh
grep -rIl '.pi/agent/git/github.com/ngvoicu/pi-cliproxyapi-provider/' v1 |
  xargs sed -i '' 's#~/.pi/agent/git/github.com/ngvoicu/pi-cliproxyapi-provider/#~/.pi/agent/npm/node_modules/pi-provimux/#g'
grep -rn 'pi-cliproxyapi-provider' v1    # nothing left
```

## 8. The owner's choices

- A clean, passing update lands and is published by itself, as Provimux's are (2.8); no pull request, no approval.
- A release of the original waits 24 hours before it is taken; `no_wait` skips that by hand.
- The numbering `105.0.1` (3.1): the base is in the number and it is a plain version.
- The trusted publisher may `npm publish` directly (no staging).
- pi 1.6.0 or newer only, and no code for the extension's own older versions or their files (2026-11-24).

## 9. What was checked while building

1. **npm and the environment: npm compares it, both ways.** npm's page still calls the field optional and says
   nothing more, but projects report both failures: a publisher that names an environment refuses a job that
   declares none (GitHub then puts no `environment` claim in the token; `j-256/reorg` `6904ada`), and a job that
   declares one fails against a publisher that names none (`Adyen/adyen-node-api-library` #1705,
   `Get-Concord-AI/concord-mcp` `5210c44`), both as a misleading E404. So `npm` must be named on both sides, exactly,
   as designed; the design still relies on GitHub's branch rule, not on npm.
2. **npm and the trigger: no event is excluded.** npm's page names none; what it checks is the workflow file of the
   run (`workflow_ref`), the repository, the environment. A `workflow_dispatch` started by another workflow is a run
   of `publish.yml` itself, so `publish.yml` is what is checked (projects publish this way, e.g.
   `citrusquant/citrusquant`'s `publish-wasm-npm.yml`, started by `gh workflow run`). npm's warning about
   "`workflow_call` or `workflow_dispatch`" concerns a publish inside a *called* (reusable) workflow, where the
   caller's file is checked: `publish.yml` calls nothing. GitHub confirms that `workflow_dispatch` (and
   `repository_dispatch`) are the events a `GITHUB_TOKEN` may still start. The first live release stays the test.
3. **How many trusted publishers: up to 10** per package (npm's trusted-publishers page, twice). One is used.
4. **Whether a staged publish binds a new publisher:** still not said anywhere (the staged-publishing page is
   silent; the trusted-publishers page says "the first successful publish"). The design does not stage. New: a
   publisher created now allows `npm stage publish` always and `npm publish` only when chosen
   (`npm trust github … --allow-publish`, npm 11.15 or later), as 4.1 says.
5. **Node 24's npm:** Node 24.22.0 (2026-10-14) bundles npm 11.19.1; 24.22.3 is the current 24. The job still
   asserts 11.5.1.
6. **pi 1.6.0** (`dist/core/package-manager.js`): a git update
   fetches, `git reset --hard`, `git clean -fdx`, then `npm install --omit=dev --legacy-peer-deps`; an npm update asks
   `npm view <name> version --json` and installs when it is greater (`gt`). Dev dependencies are not installed for a
   git install, so the lockfile check of 2.6 protects the CI jobs, not users.
7. **Forgejo:** the precedence is now in Forgejo's documentation ("In the absence of a `.forgejo/workflows`
   directory, workflows will be looked up in the `.github/workflows` directory"). The redirect after a rename is
   still not checked and still not relied on.
8. **`GITHUB_TOKEN` and workflow files:** GitHub refuses such a push ("refusing to allow a GitHub App to create or
   update workflow … without `workflows` permission"), as expected; the guard refuses every `.github/` path first.

Also confirmed: `actions/checkout` v7.0.1 (`3d3c42e`), `actions/setup-node` v7.1.0 (`949feb2`) and
`actions/upload-artifact` v7.0.2 (`cf430e0`) are each action's newest release and the commits pinned. Scheduled
workflows of a public repository are still disabled after 60 days without activity.

## 11. The tests

`bash .github/follow/test.sh` (or `test.sh clean conflict …` for some) builds an "original" with releases and a
"fork" built on its 1.5.0 in a temporary folder, with a stub npm registry (`FOLLOW_NPM_DIR`, with each release's
tarball), a stub `gh` and a fake `npm`; no network. It also reads the workflows as text for what a local run cannot
exercise, and checks every commit's tree (12). `FOLLOW_TEST_SCRIPTS` and `FOLLOW_TEST_TREE` point it at another
revision's scripts and tree. **Every case runs twice, side by side: with `GITHUB_ACTIONS` unset and with
`GITHUB_ACTIONS=true`**, because the scripts behave differently inside Actions (runner commands);
`FOLLOW_TEST_ACTIONS=unset` or `=true` runs one way only. It runs on macOS's bash 3.2 and on Linux (bash 5, GNU
tools), offline, with real `npm` for `npm pack` only, and `follow.yml` runs it before every `prepare`. It is not
part of `npm run check`, which only `package.json`'s `scripts` decide. What only GitHub can show (environments,
mounts, the container steps) is checked as text in `workflows`.

**Under npm older than 11.5.1** (npm 10), `follow.sh` refuses every command, and the suite takes that refusal as
the expected outcome. `run` asserts it: exit 1, the reason, and no npm call but `--version`. The case's later
assertions about what would follow are skipped and counted, and a group whose next steps build on a candidate stops
there and says so. Cases that do not run `follow.sh` (e.g. `tarball.mjs`'s header checks) run in full.

| Case | What it shows |
|---|---|
| `numbers` | `1.5.0` → `105.0`, `2.0.3` → `200.3`, back again; a minor of 100 and other forms refused. |
| `clean` | A clean release: `M` (main and `B`), `R` (`105.1.1`, the changelog entry with the subjects escaped and the bump commits left out), the bot and `B`'s date, README the fork's, the bundle; by hand (`merge`, `stamp`, `guard`) the same commits. |
| `rerun` | Two runs, and a copy at another hour, give the same candidate. |
| `waiting` | A release 2 hours old waits, with the time it is taken; `no_wait` and a shorter wait take it. |
| `states` | Up to date, not newer, not on npm, not plain, no bump commit, two bump commits, a minor of 100. |
| `conflict` | A conflict in a source file lands nothing and leaves the work tree alone; by hand it stops, and after resolving `stamp` and `guard` finish. |
| `manifest_conflict`, `manifest_merge` | `devDependencies` changed on both sides is a conflict; changed on one side each, a merge by hand gets both keys, `description` stays the fork's, tabs kept, and the guard refuses it. |
| `refusals` | Each refusal: `LICENSE`, a workflow, a new top-level file, `vitest.config.ts`, `.npmrc`, `docs/`, a symbolic link, `dependencies`, a `postinstall`, `license`, a new key, `pi`, `files`, a package from another registry. |
| `f2_release` | The header pre-scan, then npm's own `node-tar`. Pass: a per-file PAX path, and `npm pack`'s own `path`, `mtime` and `size`. A PAX file name (`docs/café.md`, packed by `npm pack`) reads as npm's, and its PAX keys are exactly `path`, `mtime`, `size`. Refused before extraction, also with an npm that has no `node-tar`: the review's global-against-per-file PAX size on `README.md`, a PAX size longer than its base header's (the hidden `globalThis.stolen`), a regular-file header carrying a link target, a PAX global header, GNU `L`/`K`, hard and symbolic links, a FIFO, a file or directory outside `package/`, `package/../x/`, a tree under another root, a dangling PAX header, trailing data, a gzip name, two gzip members, and each PAX key `npm pack` does not write (`linkpath`, `uid`, `gid`, `uname`, `gname`, `atime`, `ctime`, `charset`, `comment`, a second `path`, a `size` other than the header's). No bundled `node-tar` refuses. Also refused: npm's tarball with a changed file, with a file the commit lacks, **without a file the commit ships**, with a wrong integrity, or missing, and a rewritten bump commit. |
| `f3_strings`, `f3_handoff`, `f3_links`, `f3_checker` | A version string with a line break adds no record; a hostile old-base version is never evaluated; a version input with a runner command is not echoed; runner commands are stopped; `fetch-candidate` prints exactly the commit on standard output with `GITHUB_ACTIONS` unset and true, the stop markers on standard error; a link where the merge writes is refused and nothing is written through it; a checker that fails is an error, not a pass. |
| `f4_deps`, `f4_dev_lands` | Refused: a development dependency moved to `dependencies`; a changed peer, new `optionalDependencies`; an entry the root's peer reaches, changed (with install scripts), marked `dev` and changed, removed, or shadowed by a new nested `dev` entry; another package's tarball and digest under a development dependency's name; a link; a local-file development dependency with no entry; an entry installing another package than its declaration asks for (a stale same-version alias), an alias declaration whose entry installs the alias's own name, a git declaration; a short or missing integrity; a root entry unlike `package.json`; a lock with no root. Lands: a bump of two development dependencies, one with install scripts; a development alias (`npm:a@1.0.0`). |
| `f5_paths`, `f5_pack`, `f5_load`, `f5_order` | A nested `.npmrc`, `.npmignore`, `.gitattributes`; `tsconfig.json`; a new extension file; a test the fork changed; a nested `.npmignore` leaving the registered extension out of the tarball; a comment naming a retired import is no refusal; `load.mjs` loads a packed package with its files, refuses one whose template-literal import the tarball lacks, and gives the package nothing but its peers; the test jobs' container steps, replayed in the workflow's order with an install that generates a file the extension needs, fail at the load, and pass with the file in the commit. |
| `f6_refs` | `plan`, `land`, `tag` refuse `refs/heads/Main` and a tag ref. |
| `f8_recovery` | `merge` from inside the tree refused; a hand merge carrying a refused change ends in the guard's refusal; a key added while resolving a conflict is refused (the effective manifest); no container or push command in the issues or this file; `plan` refuses an `.npmrc` before npm runs (only `--version`, from the neutral folder), runs npm from a neutral folder against the public registry, and refuses a publish tag in `publishConfig`. |
| `f9_issues` | Past 350 issues; a contributor's issue with the bot's title and key untouched; the bot's closed issue reopened, not duplicated; the failure issue first, written even when the README issue fails; a 5000-line list kept under GitHub's limit; a README issue quoting the failure key, and a bot issue without the label, untouched. |
| `f10_publish`, `f10_land` | A dry run closes nothing; a success without the version on npm closes nothing; a version npm shows only after a delay opens no issue, one it never shows opens `publish: <v> — failed` once the wait is over, and a dry run does not wait; an annotated tag at the commit passes; a missing release is made; no `gitHead` and no tag fails; a long changelog; a commit outside the live `main` is not tagged; a tag or `gitHead` at a commit of `main` naming another version is not taken; `plan` names the version when it refuses an `.npmrc`; a failed retry dispatch is red with an issue; a failed dispatch is `dispatch-failed`, never `landed`; a tampered candidate is refused by `land` and nothing is pushed; `main` moved during the push is `moved`. |
| `f11_mirror` | A tag the NAS refuses leaves `main` unmoved too; a tag named `origin/main` does not stand in for the branch; the mirror follows; in a reused workspace, a tag gone from GitHub is seen as on the NAS only; GitHub's `main` rewritten: the NAS's old `main` kept as `refs/nas-backup/main-<UTC time>`, `main` and the new tag GitHub's, GitHub untouched; a backup the server refuses leaves `main` unmoved; the NAS's `main` moved between the read and the push: the lease refuses, nothing changes. |
| `workflows` | Read as text: every job's first step checks the exact ref, every job runs on GitHub only; every job that writes is in `main-only`, the OIDC job in `npm`, the others in none, and this file has the `gh api` commands for both; the version input checked; the test jobs in a container with no `setup-node` and no `git archive` (`test (candidate)`: one `setup-node`, for `follow.sh`'s npm gate, before the tree and any container); every job that runs `follow.sh` sets up Node 24 before it, mounting only the exported tree and the scripts, never the workspace; the clean tree packed read-only before `npm ci` and nothing packed after, and that archive given read-only to the loader, in `test (candidate)` and `publish`'s `test`; no cache; `land` by `follow.sh land`; no credentialed job (nor `follow.sh`) runs `npm ci`, `npm install` or `npm rebuild`, `npm pack` and `npm publish` only with `--ignore-scripts`, and the test jobs install only in the container (`npm ci`), and pack, `npm ci`, load, check on the lockfile's pi, in that order; `land`, `publish`, `tag` in one concurrency group; main checked in the publish step; the mirror atomic, qualified and pinned; every action pinned by SHA; `publish.yml`'s `test` records the archive's sha512 and uploads it before `npm ci`, and `publish` takes it by `follow.sh archive` by the test job's id and digest, packs nothing, checks the sha512 again in the publishing step, and publishes or dry-runs that file alone, the dry run without the OIDC request variables. |
| `f12_history` | A commit with `.github/workflows/` but no `.forgejo/workflows/` has exactly `publish.yml`, one of the two known blobs of `main`'s 105.0.1 revisions; both are met in the history and run their two jobs on GitHub only; on a throwaway repository, another workflow beside it, a changed `publish.yml`, or the known bytes under another name fail the rule. |
| `archive` | `follow.sh archive`: the tested archive is taken and its path alone printed; refused: a recorded sha512 of another archive (a digest mismatch, nothing written), the same files compressed again, another artifact digest, an artifact of another name, an artifact with another file, an archive whose files are not the commit's. |
| `npm_gate` | Every command of `follow.sh`'s dispatcher, read from the script itself, and an unknown word, under a stand-in npm 10.9.3 with tokens in the environment: each exits 1 with the reason after exactly one `--version`, with no other npm call. The review's `merge` of a release whose tree has a `prepare` starts no hook and leaves the fork alone. `help`, `-h` and `--help` run without npm. |
| `npm_boundary` | npm 10.9.3 (a stand-in that would start `prepare`) with tokens in the environment: `prepare` and `plan` stop at the version check, saying why, before any npm call, and no hook runs; 11.5.0 refused, 11.5.1 runs. An npm that starts `prepare` as npm 10 does, given synthetic `GH_TOKEN`, `GITHUB_TOKEN`, `NODE_AUTH_TOKEN`, `NPM_TOKEN`, `ACTIONS_*` and another variable: the upstream tree's and the fork's `prepare` and every npm call see none of them, only `PATH`, `HOME`, the two empty configurations, `ignore_scripts=true` and the registry. The real npm (11.5.1 or later) with tokens set and a `prepare` that prints its environment: no token. |
| `shape` | Candidates spoiled after the merge: the fork's own test changed, README changed, `R` changing another file or more than the version, a wrong version, a third commit, no merge. |
| `readme` | The original's README change: the fork's README byte for byte, the diff kept; both sides changing it is no conflict. |
| `report` | A conflict opens the issue (its key the first line, no recovery commands) and the README issue; a rerun writes no comment; a new state renames it with one comment; check failed with its log in a longer fence; dry run green; land failed; landed; up to date and published closes it only in a live run, never in a dry run; the publish issue opens and closes. |
| `plan` | The publish guard: to publish, already published, first publish, a version of another form or base, a lifecycle script, an untracked file in the tarball, a dirty tree, an `.npmrc`. |
