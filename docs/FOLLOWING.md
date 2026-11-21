# pi-provimux: following the original, versions, npm, the mirror, the rename

**Status: design.** Nothing here is built yet. It says what the automation around pi-provimux is, so that workers
build to it; when a build shows the design wrong, this file is corrected.

- **The original:** `router-for-me/pi-cliproxyapi-provider` (MIT), npm `@router-for-me/pi-cliproxyapi-provider`.
- **The fork:** `ngvoicu/pi-provimux` on GitHub (today still `ngvoicu/pi-cliproxyapi-provider`), npm `pi-provimux`.
- **The pattern it borrows from:** Provimux's `.github/provimux/SYNC.md`. This extension is much smaller: no build,
  no binary, one `npm run check`, so most of that machinery is left out. What is kept is its trust shape: the jobs
  that run the original's code can do nothing else, and the job that publishes runs none of it.

Facts in this file were read on 2026-11-21 (repository state, pi's package manager, npm's and GitHub's
documentation). [What was read, and what is not verified](#9-what-was-read-and-what-is-not-verified) lists what a
worker must confirm while building.

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
- **What `pi update` does with a git install** (read in pi-coding-agent 1.3.0, `dist/core/package-manager.js`,
  `ensureGitRef`): it fetches the branch, then `git reset --hard` to it, `git clean -fdx`, and installs
  dependencies. So pi itself would survive a rewritten `main`. Everything else would not: a plain clone or a fork
  of this repository, a `git pull`, and the Forgejo mirror, which is fast-forward only by design and would stop.
- **Nothing forces.** The automation pushes with a plain `git push`, which git refuses unless it is a
  fast-forward, and a ruleset forbids force pushes to `main` for everyone.
- **A conflict is resolved once.** With a rebase, every patch of the fork meets every release again.
- **The cost:** the fork is no longer "the original plus N patches" in the log. What the fork changes is read with
  `git diff router-for-me/main...main`.

### 2.4 The run: `follow.yml`

Every job checks out the run's own commit (`github.sha`, the `main` the run names) and runs **that commit's**
`.github/follow/` scripts, never a copy from the candidate.

| Job | What it does | What it runs | Permissions |
|---|---|---|---|
| `prepare` | Selects the release (2.1, 2.2). Decides whether there is anything to do. Merges `B` into `main` in a temporary worktree, applies the file rules (2.5), runs the guard (2.6), stamps the version and the changelog (3). Uploads the candidate as a git bundle. | git, `npm view` (registry data, parsed as JSON), `jq`, the run's own scripts. No code of the original or of the candidate. | `contents: read` |
| `test (candidate)` | Exports the candidate's tree (no `.git`), `npm ci`, `npm run check`. | **The original's and the fork's code, and their dev dependencies.** | `contents: read` |
| `test (original)` | The same on `B` alone. Information only: it tells the owner whether a failure is the original's own. It never decides. | **The original's code.** | `contents: read` |
| `land` | Needs `prepare` and a successful `test (candidate)`. Takes the bundle by the id and digest `prepare` output, checks the candidate is the commit `prepare` named, pushes it to `main` without force, then starts `publish.yml`. | git and `gh` only. | `contents: write`, `actions: write` |
| `report` | Always. Writes the issue (2.7). | The run's own script, `gh`. | `issues: write` |

**The candidate** is two commits on top of `main`:

- `M`, the merge: parents `main` and `B`, message `Merge pi-cliproxyapi-provider <V>`.
- `R`, the release commit: `pi-provimux <new version> (pi-cliproxyapi-provider <V>)`. It changes only the version
  in `package.json` and `package-lock.json`, and `CHANGELOG.md`.

Both carry the bot's identity and `B`'s committer date, so the same inputs give the same commits and a rerun
reproduces the candidate instead of making a second one.

**Hand-over between jobs.** A job that runs the original's code holds the run's artifact token and could upload an
artifact under any name. So `land` reads the bundle by the artifact **id and digest** that `prepare` wrote as job
outputs, and takes from the test jobs nothing but their conclusion. No job uses a cache.

**The push.** `git push origin <R>:refs/heads/main`, no force. If `main` moved since `prepare` (the owner pushed),
git refuses, the run ends without landing, and the next run starts from the new `main`. A push made with the
workflow's `GITHUB_TOKEN` starts no workflow, so `land` then runs `gh workflow run publish.yml --ref main`
(`workflow_dispatch` is one of the two events that token may start).

**Nothing to do** (green, no issue): `B` is already in `main`; `V` is not newer than the old base; `V` is waiting.
When `B` is in `main` but npm lacks the version `main` names, `land` only starts `publish.yml` again.

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
| `devDependencies`, `peerDependencies`, `engines` | Three-way: a key only one side changed takes that side. Both sides changed it differently: stop. |
| `dependencies`, `optionalDependencies`, `bundleDependencies`, `overrides`, `scripts`, `bin`, `files`, `pi`, `main`, `exports`, `type`, `publishConfig`, `license`, and any key the original adds | The original changed it: **stop, the owner decides.** These decide what is installed on a user's machine, what runs at install, what pi loads, what the check runs, and under which licence. |

**`package-lock.json`** is merged the same way: the entries of `packages` are compared whole, three ways; the root
entry's name and version are the fork's; both sides changed one entry differently: stop. The test job's `npm ci`
fails when the result does not match `package.json`.

### 2.6 The guard

The guard reads git objects only. Any refusal stops the run before the tests.

1. **Paths.** Every path the original changed between the old base and `B` must match `.github/follow/paths.txt`:
   `extensions/**`, `test/**`, `README.md`, `package.json`, `package-lock.json`, `biome.json`, `tsconfig.json`,
   `cliproxyapi.example.json`, `.gitignore`. Deliberately **not** on it: `LICENSE`; `vitest.config.ts` (it decides
   which tests run); `.npmrc`; anything under `.github/`, `.forgejo/` or `docs/`; `CHANGELOG.md`; any new top-level
   name. The owner accepts a new path by adding it to the list in a commit of his own; the next run then passes.
2. **The manifest** stop-keys of 2.5.
3. **The fork's own tests** (test files the old base does not have) are in the candidate, unchanged. Together with
   `scripts` and `vitest.config.ts` being the owner's, this means what `npm run check` runs cannot shrink without
   him.
4. **The candidate's shape:** `main..R` is exactly `M` then `R`; `M`'s parents are `main` and `B`; `R` changes only
   the three files it may.
5. **The version** of `R` decodes to `V` (3).

### 2.7 What the owner is told

One issue per release of the original, `follow: <V> — <state>`, updated in place, with a comment only when the state
changes (a refusal that repeats every 3 hours says it once). The run is red for every state in this table.

| State | The issue gives |
|---|---|
| `conflict` | The files that conflicted, and the commands to merge by hand (below). |
| `check failed` | The step that failed (install, typecheck, lint, tests) with its output, and whether the original's own tree fails the same step. |
| `refused` | Each guard reason, and what accepting it means. |
| `no release commit` | npm's `latest` has no single bump commit on the original's `main`, or is not a plain `X.Y.Z`. |
| `landed, not published` | From `publish.yml` (4.3): `main` has the release, npm does not. |

The issue is closed by the first run that finds `B` in `main` and `main`'s version on npm.

**By hand, when a run stopped** (the same scripts, on the owner's Mac or a worker's branch):

```sh
.github/follow/follow.sh merge 1.5.1     # the same merge and rules; leaves a conflict in the work tree
# resolve, then:
.github/follow/follow.sh stamp           # the version and the changelog entry, as commit R
npm run check
git push upstream main                   # GitHub; publish.yml publishes it
```

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

**On the code branch** (`pi-provimux` at `20f06a0`, which says `2.0.0`), this numbering changes: `"version"` in
`package.json`, its two copies in `package-lock.json`, and in `CHANGELOG.md` the heading `## 2.0.0` and the line
"Already in this fork before 2.0.0". Nothing else: the four internal symbol keys that keep the old name on purpose
are not part of a version or of the rename.

Alternatives, for the owner's choice:

| Numbering | Shows the base | Cost |
|---|---|---|
| **`105.0.1`** (this design) | In the number, by a rule to learn once. | An unusual first number. |
| `2.0.0`, `2.0.1`, … with a field `"upstream": {"version": "1.5.0"}` in `package.json`, the base in the changelog and the release title | Not in the number. | `pi list` and npm show nothing about the base. The worker's branch has this today. |
| `1.5.0-pmx.1` (Provimux's own form) | Exactly. | A pre-release: it sorts *below* 1.5.0; ranges skip it; npm demands an explicit `--tag` to publish it; pi's update works only while the install is unpinned. |
| `1.5.<patch × 100 + n>` | Partly. | On a base with patch 0 the first release is `1.5.1`, which reads as the original's 1.5.1. |

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
- **A trusted publisher is set on a package that exists.** The first version is therefore published another way:
  by the owner, from his Mac (4.4).
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
| `plan` | Reads `main`'s name and version. npm already has that version: nothing to publish, go to `tag`. Otherwise the publish guard (below). | git, `jq`, `npm view`, `npm pack --dry-run --ignore-scripts`. No repository code. | `contents: read` |
| `test` | `npm ci`, `npm run check` on that commit. | **The repository's code and dev dependencies.** | `contents: read` |
| `publish` | Needs `plan` and `test`. Checks out the commit with no stored credential, checks it is still the live `main` and the tree is clean, then `npm publish --ignore-scripts --access public --registry https://registry.npmjs.org/`. | `git` and the npm CLI. **No repository code:** no `npm ci`, no lifecycle script, no build (the package has none: pi loads the `.ts` files). | `id-token: write`, `contents: read`; environment `npm` |
| `tag` | After `publish`: the tag `v<version>` at the commit that was just published, and the GitHub release with the changelog entry. When the version was already on npm and the tag is missing, it tags the commit npm recorded (`gitHead`) if npm recorded one and it is in `main`; otherwise it says so and tags nothing. | git and `gh` only. | `contents: write` |
| `notify` | After a failure: the issue `publish: <version> — failed`, or the state `landed, not published` on the open `follow:` issue. | The run's own script, `gh`. | `issues: write` |

**The publish guard** (`plan`):

- the name is `pi-provimux`, `repository.url` is exactly the repository's, `private` is not set;
- the version has the form of 3.1, decodes to the base git shows, and is greater than npm's `latest`;
- `scripts` has no lifecycle script (`preinstall`, `install`, `postinstall`, `prepublish`, `prepare`,
  `prepublishOnly`, `prepack`, `postpack`, `publish`, `postpublish`);
- there is no `.npmrc` in the tree;
- the tarball would hold only tracked files under `extensions/`, plus `package.json`, `README.md`, `LICENSE` and
  `CHANGELOG.md`.

**The environment `npm`** (GitHub): deployments from the branch `main` only, no secret, no reviewer (unless the
owner chooses the human step of 2.8). Only the job `publish` declares it, and the trusted publisher names it.

**The npm CLI:** Node 24 from `actions/setup-node`, pinned; the job asserts `npm --version` is at least 11.5.1 and
fails otherwise. No `NODE_AUTH_TOKEN`.

Every action is one of GitHub's own (`actions/checkout`, `actions/setup-node`, `actions/upload-artifact`,
`actions/download-artifact`), pinned by full commit SHA.

### 4.3 When a publish fails

`main` already has the code (git installs have it); npm does not. Nothing is retried blindly: the issue says which
step failed. After the cause is fixed, "publish now" is `gh workflow run publish.yml -R ngvoicu/pi-provimux`. If npm
took the version but the run died after, the next run finds the version on npm and only makes the tag, when npm
recorded the commit (it does not always: the original's 1.5.0 has no `gitHead`); otherwise the issue names the tag to
make by hand.

**Taking a release back.** pi installs a version only when it is *greater* than the installed one, so moving
`latest` back helps new installs only. The fix is always a new, greater version: revert on `main`
(`git revert -m 1 <M>` for a merged release), raise the third number, push. `npm deprecate pi-provimux@<bad> "…"`
marks the bad one. To stop following meanwhile: `gh workflow disable follow.yml -R ngvoicu/pi-provimux`. A reverted
merge stays merged for git: the original's next release is then merged by hand (2.7), reverting the revert first.

### 4.4 The owner's one-time steps

Steps 2 to 4 belong together: do them on one day, when the chief says the automation is ready to merge.

1. **npm account.** Sign in at npmjs.com (create the account if there is none) and turn on two-factor
   authentication: a security key or passkey (Touch ID works), or an authenticator app. Then, in a terminal:
   `npm login`.
2. **First publish, from the Mac** (after the GitHub rename; the chief names the commit):
   ```sh
   git clone https://github.com/ngvoicu/pi-provimux.git /tmp/pi-provimux-first
   cd /tmp/pi-provimux-first && git checkout <the commit>
   npm publish --ignore-scripts --access public
   npm view pi-provimux version
   ```
   npm asks for the second factor. This one version has no provenance; every later one has.
3. **Trusted publisher** (needs npm 11.15 or later; this Mac has 11.19):
   ```sh
   npm trust github pi-provimux --file publish.yml --repo ngvoicu/pi-provimux --env npm --allow-publish
   npm trust list pi-provimux
   ```
   Or on npmjs.com: the package → Settings → Trusted Publisher → GitHub Actions: user `ngvoicu`, repository
   `pi-provimux`, workflow `publish.yml`, environment `npm`, and tick `npm publish` under allowed actions.
4. **Tell the chief.** A worker then merges the automation with the next version (`<base>.2`); `publish.yml`
   publishes it from GitHub, which binds the publisher (it must happen within 2 days of step 3). Check the version's
   page on npmjs.com: it shows "Provenance" with the commit.
5. **Close the door to tokens:** the package → Settings → Publishing access → **Require two-factor authentication
   and disallow tokens** → Update Package Settings.

There is no secret to store on GitHub.

## 5. The Forgejo mirror

`.forgejo/workflows/follow-github.yml`, the site's workflow with tags added:

- **Where it runs:** on the owner's Forgejo (the NAS) only. GitHub reads `.github/workflows/` and never sees it.
  Forgejo, while `.forgejo/workflows/` exists, ignores `.github/workflows/` (as the site's workflow states and its
  NAS shows): on the NAS this is the only workflow, so `follow` and `publish` never run there. For that reason this
  file lands **in the same commit as, or before,** the GitHub workflows.
- **When:** hourly (`cron: '13 * * * *'`), and by hand.
- **What:** fetches `main` and the `v*` tags from `https://github.com/ngvoicu/pi-provimux.git`. `main` is pushed to
  the NAS only as a fast-forward; a new tag is pushed; if the NAS has a commit GitHub lacks, or a tag that differs,
  the job fails and changes nothing. No force, no merge commit.
- **Permissions:** `contents: write` on the NAS's own repository. It runs git only, on a public address, with no
  secret.
- **Other branches** are not mirrored.

**Nobody pushes to the NAS.** Locally the remotes keep the names every repository of the owner uses: `origin` is the
NAS, `upstream` is GitHub, `router-for-me` is the original. Work is pushed to `upstream`; `origin` catches up
within the hour. The runbook makes a push to the other two fail on purpose.

The Forgejo repository needs Actions switched on and a runner that serves `ubuntu-latest`, as the site's has.

## 6. Security

### 6.1 Which jobs run the original's code

| Job | Runs | Token | Secrets | Can push or publish |
|---|---|---|---|---|
| `follow.yml` → `test (candidate)` | the merged tree: `npm ci`, `npm run check` | `contents: read` | none | no |
| `follow.yml` → `test (original)` | the original's release alone | `contents: read` | none | no |
| `publish.yml` → `test` | `main`: `npm ci`, `npm run check` | `contents: read` | none | no |

These three are the only jobs that install dependencies or execute anything from the tree. None has `id-token`,
none declares an environment, and there is no secret in the repository for them to find. What leaves them is their
conclusion and nothing else: no later job reads a file they wrote (2.4), and no cache is shared.

The jobs that can change something run none of that code:

| Job | Can | Runs |
|---|---|---|
| `follow.yml` → `land` | push `main` (fast-forward), start `publish.yml` | git, `gh` |
| `publish.yml` → `publish` | publish to npm (OIDC, environment `npm`, `main` only) | git, the npm CLI with `--ignore-scripts` |
| `publish.yml` → `tag` | create a `v*` tag and a release | git, `gh` |
| `report`, `notify` | write issues | the run's own script, `gh` |

There is no `pull_request_target` workflow and none is added. A workflow run for a pull request from a fork gets a
read-only token and no `id-token`.

### 6.2 What stops a hostile or broken upstream commit from being published

In the order a commit meets them:

1. **Only a release.** A commit is taken only as part of a version the original published on npm as `latest`, and
   only up to that version's bump commit. A push to the original's `main` alone changes nothing here.
2. **The wait.** 24 hours from npm's own timestamp. A release that is pulled or replaced inside that time never
   arrives.
3. **A clean merge.** Any conflict outside the three ruled files stops it.
4. **The guard** (2.6). The things a test cannot judge need the owner: a runtime dependency, an install script
   (pi runs `npm install` in a git install, so a `postinstall` would run on the user's machine), `bin`, `files`,
   the `pi` manifest, the licence, the test configuration, an `.npmrc`, a workflow file, any new kind of path.
5. **The check.** Typecheck, lint and every test, the fork's own included, on the merged tree. This is what catches
   a *broken* release.
6. **The publish runs none of it.** `npm publish --ignore-scripts` from a clean checkout of the live `main`, in a
   job that installed nothing, with the registry fixed on the command line; the publish guard (4.2) runs before it.
7. **Only `main`, only forward.** The environment `npm` admits only `main`; `main` cannot be force-pushed; `v*`
   tags cannot be moved.
8. **Afterwards.** Every version on npm carries provenance: the workflow, the run and the commit it came from. A
   bad release is answered by a greater version (4.3).

**What is left.** Hostile code that merges cleanly, touches only existing source files, passes the tests and
survives a day in public is published. Nothing automatic sees it. The owner's remaining defences are the wait and
the changelog entry and release each update produces. Choosing the pull request of 2.8 closes this, at the price of
a click per release.

Two more residual points: the test jobs' result is produced by the code they run, so a hostile release can make
its own tests pass (they guard against breakage, not intent); and whoever can push to this repository can publish,
by pushing a new version to `main`. That is the owner alone: the repository has no collaborators.

### 6.3 Settings the design relies on

- **Ruleset on `main`:** no force push, no deletion. (No required pull request: `land` pushes directly.)
- **Ruleset on tags `v*`:** no update, no deletion.
- **Environment `npm`:** branch `main` only; no secret.
- **Issues:** on (they are off today, as on every GitHub fork).
- **Repository secrets:** none, ever. A workflow that needs one is a change to this design.
- **npm:** 2FA on the account; trusted publisher as in 4.4; tokens disallowed for the package.

## 7. The rename: runbook

For a later worker, in this order. The steps marked **owner** are his own; workers never install into or edit the
owner's pi, and never touch his npm account.

**Before:** the pi-provimux code is on `main`, on GitHub and the NAS (pushed to both, as until now); the
automation is built and reviewed on a branch but **not merged**; nobody is working in a worktree of this repository
(`git worktree list`, and ask the chief).

1. **GitHub: rename.**
   ```sh
   gh repo rename pi-provimux -R ngvoicu/pi-cliproxyapi-provider --yes
   gh api repos/ngvoicu/pi-provimux --jq .full_name
   ```
   What GitHub's redirect keeps working: the old web address, issues, and `git clone`, `git fetch` and `git push`
   to the old address. So:
   - **a git install keeps updating.** pi's checkout for `git:github.com/ngvoicu/pi-cliproxyapi-provider` has the
     old address as its `origin`; `pi update` fetches it and GitHub answers for the new one. This holds for the
     owner's pi too, whose settings name that source: he needs to do nothing until step 9;
   - what is **not** redirected: a `uses:` of an action hosted in the renamed repository (there is none);
   - what **ends** the redirect: a new repository named `pi-cliproxyapi-provider` under `ngvoicu`. Never create or
     fork one under that name.
2. **GitHub: settings.** Issues on (`gh repo edit ngvoicu/pi-provimux --enable-issues`); the two rulesets and the
   environment `npm` of 6.3. The repository stays a fork of the original on GitHub ("forked from" is the credit).
3. **Forgejo: rename**, in its web interface (the repository → Settings → Repository name → `pi-provimux`). Switch
   Actions on for it. Whether Forgejo redirects the old address afterwards is not relied on: the next step sets
   every address.
4. **Local: remotes and folder.**
   ```sh
   cd <the local checkout of this repository>
   git remote set-url upstream https://github.com/ngvoicu/pi-provimux.git
   git remote set-url origin ssh://git@zeenas:2222/ngvoicu/pi-provimux.git
   git remote set-url --push origin no-push-the-NAS-follows-GitHub
   git remote set-url --push router-for-me no-push-this-is-the-original
   git fetch --all --prune
   cd .. && mv pi-cliproxyapi-provider pi-provimux && cd pi-provimux
   git worktree repair
   git worktree list
   git worktree prune --dry-run
   ```
   `git worktree repair`, run in the moved main folder, rewrites the link each worktree keeps to it; the worktrees
   themselves (`/tmp/pi-provimux`, `/tmp/pi-cliproxyapi-provider-answered`, `/tmp/pi-provimux-follow`) did not
   move. Check each with `git -C <worktree> status`. A worktree whose folder is gone (a restart empties `/tmp`) is
   listed by the dry run; prune it only then, and its branch stays. `main` tracks `origin/main`; set it to
   GitHub's so that a plain `git push` goes there: `git branch -u upstream/main main`.
5. **Other places that name the old repository** (list them first: `grep -rIl pi-cliproxyapi-provider` over
   `providers.dev`, without `node_modules` and `.git`): `pi-cache-keeper/README.md` links it; the
   `providers-dev-sme` brain names it (through kluris, never by hand). Mentions of the original
   (`router-for-me/…`, `@router-for-me/…`) stay as they are. The owner's project `team-vs-solo` is **not** in this
   step: it is his, and it is step 9.
6. **Owner: npm account and first publish** (4.4, steps 1 and 2). A worker then tags that commit on GitHub
   (`git tag v<version> <the commit>`, `git push upstream v<version>`): no workflow exists yet to do it.
7. **Owner: trusted publisher** (4.4, step 3).
8. **Merge the automation** to `main` on GitHub, with the next version: the workflows, the scripts, the mirror
   workflow, this file. `publish.yml` publishes it (4.4, step 4). Push `main` to the NAS one last time, with the
   push address given in full, so that the mirror workflow is there to run; from then on the NAS follows. Check: the
   version on npm with provenance, the tag `v<version>`, the NAS equal to GitHub within the hour, and only "Follow
   GitHub" in the NAS's Actions. Then the owner sets "disallow tokens" (4.4, step 5).
9. **Owner: his own pi, from git to npm.** The login and the settings stay (`~/.pi/agent/cliproxyapi.json` is not
   the package's):
   ```sh
   pi remove git:github.com/ngvoicu/pi-cliproxyapi-provider
   pi install npm:pi-provimux
   pi list
   ```
   `pi list` must show `npm:pi-provimux` once and the old source not at all. Then, at once, `team-vs-solo`
   (below): its setups stop working at the `pi remove`.

**`team-vs-solo` (the owner's project, the owner's step).** Twelve files under `v1/` load this extension by the path
of pi's git checkout, `pi -e ~/.pi/agent/git/github.com/ngvoicu/pi-cliproxyapi-provider/extensions/index.ts`:
`judges/deepseek.json`, five setups in `suites/smoke/setups/` and six in `suites/tally/setups/` (15 lines), and
`suites/tally/README.md:111` shows the same line.

- **What keeps them working through the rename:** that folder is named after the source in the owner's pi settings,
  not after the repository on GitHub. Renaming the repository on GitHub and on the NAS, and the local folder,
  change nothing in it, and `pi update` keeps refreshing it through GitHub's redirect. So steps 1 to 8 break
  nothing there, and for as long as the owner keeps the git install, nothing ever does.
- **What breaks them:** only `pi remove git:github.com/ngvoicu/pi-cliproxyapi-provider` in step 9. pi deletes the
  checkout with the entry.
- **The owner's step, right after `pi install npm:pi-provimux`**, with no team-vs-solo run in progress. The npm
  install lives in `~/.pi/agent/npm/node_modules/pi-provimux/` (check: `ls ~/.pi/agent/npm/node_modules/pi-provimux/extensions/index.ts`):
  ```sh
  cd <the local checkout of team-vs-solo>
  grep -rIl '.pi/agent/git/github.com/ngvoicu/pi-cliproxyapi-provider/' v1 |
    xargs sed -i '' 's#~/.pi/agent/git/github.com/ngvoicu/pi-cliproxyapi-provider/#~/.pi/agent/npm/node_modules/pi-provimux/#g'
  grep -rn 'pi-cliproxyapi-provider' v1    # nothing left
  git diff --stat                           # 13 files, 16 lines
  ```
- **Or he does not switch.** Step 9 is his to do when he likes, or never: the git install keeps following `main`,
  which has every release the npm package has. Then `team-vs-solo` stays as it is.

**The README says the move once**, in "Coming from pi-cliproxyapi-provider", for anyone who installed from git:

> Installed from git? It keeps working: GitHub redirects the old address, and a git install follows `main`. To move
> to the npm package, remove the git one first:
>
> ```bash
> pi remove git:github.com/ngvoicu/pi-cliproxyapi-provider
> pi install npm:pi-provimux
> ```
>
> Keep only one. pi counts the old git address, the new one and the npm package as three different packages, and
> each would register the provider `cliproxyapi`.

(pi identifies a git package by its repository address and an npm package by its name, so nothing replaces the old
entry by itself.)

## 8. The owner's choices

| # | Choice | Recommended | The other answers |
|---|---|---|---|
| 1 | Does a clean, passing update land and publish by itself? | **Yes**, as he asked, and as Provimux does. | A pull request he merges for each release of the original (2.8): closes the residual risk of 6.2, costs a click each time. |
| 2 | How long a release of the original waits before it is taken. | **24 hours.** The cost is only lateness; `no_wait` skips it by hand. | None (within 3 hours, as Provimux); 72 hours. |
| 3 | The numbering. | **`105.0.1`** (3.1): the base is in the number and it is a plain version. | `2.0.0` with the base in a field; `1.5.0-pmx.1`. |
| 4 | The first publish. | **From his Mac** (4.4): no token is ever made. The one cost: that version has no provenance. | A one-day token in an Actions secret, so that the first version has provenance too: more steps, and a token that can publish for his whole account while it lives. |
| 5 | What the trusted publisher may do. | **`npm publish` directly** (needed for choice 1). | Staging only: he approves every version on npm with 2FA, while git installs already have it. |

## 9. What was read, and what is not verified

**Read:**

- This repository at `59e0947`, the original at `5a1641b` (npm `latest` 1.5.0, published 2026-11-18), the worker's
  branch `pi-provimux` at `20f06a0`.
- pi-coding-agent 1.3.0: `docs/packages.md`, `docs/cli.md`, `dist/core/package-manager.js` (`updateGit`,
  `ensureGitRef`, `npmHasAvailableUpdate`, `getLatestNpmVersion`).
- Provimux: `.github/provimux/SYNC.md`, `provimux-check.yml`, `provimux-publish.yml`, `provimux-release.yml`.
- The site's `.forgejo/workflows/follow-github.yml`.
- npm's documentation: trusted publishers, provenance, staged publishing, `npm trust`, `npm stage`, `npm publish`,
  scripts, access tokens, 2FA for packages. `npm trust --help` and `npm stage --help` on npm 11.19.0.
- GitHub's documentation: renaming a repository, events that trigger workflows, environments.

**Not verified; a worker confirms each while building, and corrects this file where it is wrong:**

1. **npm and the environment.** The documentation calls the environment optional and does not say that npm refuses
   a job without the one the publisher names. The design sets it on both sides and relies on GitHub admitting only
   `main` to it; it does not rely on npm enforcing it.
2. **npm and the trigger.** The documentation lists no allowed events. `publish.yml` runs on `push` and
   `workflow_dispatch`; the first automatic release (4.4, step 4) is the test. Its examples use a tag push and a
   release event.
3. **How many trusted publishers.** One page says up to 10 per package, another says one. The design needs one.
4. **Whether staging counts** as the publish that binds a new trusted publisher. The design does not stage.
5. **Node 24's npm** is at least 11.5.1 on the runner; the job asserts it.
6. **pi 1.6.0** (the owner's) updates git and npm installs as 1.3.0 does. Only 1.3.0 was read.
7. **Forgejo:** that a renamed repository redirects, and that Actions prefers `.forgejo/workflows/` over
   `.github/workflows/`. The first is not relied on; the second is taken from the site's working setup.
8. **`GITHUB_TOKEN` and workflow files.** The candidate changes none (the guard refuses them), and the original's
   history has never had a `.github/` path, so the push by `land` is not one GitHub refuses. If the original ever
   adds a workflow file, the guard stops it and the owner merges by hand, with his own credentials.

## 10. Build order

1. `.github/follow/`: `follow.sh` (`select`, `merge`, `stamp`, `guard`, `report`), `manifest.mjs`, `paths.txt`, with
   tests that run them on a throwaway repository (a clean release, a conflict, each guard refusal, a README change,
   a release that is waiting, a rerun giving the same commits).
2. `follow.yml` and `publish.yml`, first with `land` and `publish` behind a dry-run input.
3. `.forgejo/workflows/follow-github.yml`.
4. The runbook of 7, with the owner's steps of 4.4.
