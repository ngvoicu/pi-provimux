# Changelog

## Unreleased

**Every command says what it does, and a pause shows in the footer.** Wording only, besides the footer: no command,
setting or default changed.

- **A pause shows in the footer.** While requests are paused, the footer of every Pi window with pi-provimux says
  `paused · /continue` in the warning colour (`paused` under 60 columns): at once where you typed `/pause`, in the
  others when they next read `provimux.json` (every 2 seconds), and from the start in a Pi started while paused. It
  goes on `/continue` from any window. The mark only displays: it never holds or lets go a request and changes nothing
  the elapsed time reads, and a `provimux.json` it can't read for a moment (missing, half-written) leaves it as it
  was. The orange `paused` beside a Provimux model's name stays.
- **Descriptions in Pi** say what each command does for you: `/pause` holds each new model request Pi sends, in every
  Pi window with pi-provimux, until `/continue`; `/fast` and `/ultrafast` turn their mode on or off, saved for later
  starts, asking the server for its priority or Ultra Fast service tier; `/provimux-refresh` reloads the model list,
  with the accounts behind each model where the server lists them.
- **Messages** say what happened and what to do next. `/fast` and `/ultrafast` now always say what they turned on or
  off and which tier they ask for (before, a model that offered the mode got only the footer label); a failed price
  reload says the mode is back to what it was and whether the saved setting was put back too. `/pause` says when
  requests were already paused; `/continue` says a held request goes out within about 0.2 seconds, or that requests
  were not paused. A command given an argument says it did not run and shows its right form. A failed
  `/provimux-refresh` says what to check. The `/login Provimux` prompts ask for the server URL and the client key in
  plain words.
- **README:** one "Commands" section after the install lines: every command, what it does, when you would use it,
  an example, what it changes and for how long, and what it does not do; and the difference between
  `/provimux-refresh` and pi-cache-keeper's `/cache-keeper-refresh`.

## 105.0.7

**Every name is `provimux` now, with no fallback to the old `cliproxyapi` ones**, and less code for what no longer
exists. Do the steps below before the first start of 105.0.7.

- **The settings file is `~/.pi/agent/provimux.json`** (was `cliproxyapi.json`, which is no longer read). Rename it:
  `mv ~/.pi/agent/cliproxyapi.json ~/.pi/agent/provimux.json`. `/login` writes the new file.
- **The models cache is `~/.pi/agent/provimux-models.json`** (was `cliproxyapi-models.json`, no longer read). It is
  built again at the first start; the old file can be deleted.
- **The environment variables are `PROVIMUX_*`**: `PROVIMUX_API_KEY`, `PROVIMUX_BASE_URL`, `PROVIMUX_PROVIDER_ID`,
  `PROVIMUX_PROVIDER_NAME`, `PROVIMUX_FAST`, `PROVIMUX_CLAUDE_MESSAGES`, `PROVIMUX_TRANSPORT`,
  `PROVIMUX_WS_IDLE_TTL_MS`. The `CLIPROXYAPI_*` ones are no longer read.
- **The Codex-format API id is `provimux-codex-responses`** (was `cliproxyapi-codex-responses`). A session saved
  before keeps the old id on its earlier answers; when it is resumed pi reads those as another API's, so their
  reasoning is not sent back and the first request rebuilds the prompt cache. New answers carry the new id.
- `provimux.example.json` replaces `cliproxyapi.example.json`, without `providerId`/`providerName`. Internal names
  (global keys, temporary files, a status key) are renamed the same way.
- **`answered:` in the footer needs Provimux 8.1.1-pmx.1 or newer**, which names the provider with the kind. An answer
  that gives only the kind now names nobody (`answered: unknown`, `upstreams: []`); the guess from the credential
  list for it is gone. Plain CLIProxyAPI works as before (the footer shows nothing).
- **Removed, as unused by pi 1.6.0:** support for Oh My Pi (its plugin paths and key-based settings API, a context's
  `sessionId`), the `~/.pi/runtime` and `~/.pi/bin/pi` layouts and a flat `dist/openai-codex-responses.js`, and the
  checks for pi APIs 1.6.0 always has (`getPackageDir`, `closeOpenAICodexWebSocketSessions`, `theme.getColorMode`,
  `getBuiltinModels`, pi's model resolvers, the registry's `getAvailable` and `hasConfiguredAuth`).
- The README no longer has "Migration from static models.json".

## 105.0.6

**Needs pi 1.6.0 or newer** (was 0.99.0), and reads no value of its own older versions.

- **pi 1.6.0 or newer.** `peerDependencies` say `>=1.6.0`, and every check runs on pi 1.6.0. The code for older pi is
  gone: the mid-conversation thinking level patch for pi 1.3 to 1.5 (pi 1.6.0 carries those changes itself; the
  provider still moves them to the place OpenAI documents), the classic-context path for pi before 0.86, and the move
  of the top-level `instructions` older pi built. On pi 1.6.0 requests are unchanged.
- **`"providerId": "cliproxyapi"` in `cliproxyapi.json` is no longer read as `provimux`**, nor
  `"providerName": "CLIProxyAPI"` as `Provimux`. A value in the file is used as written, as any other id or name
  always was. A setup whose `/login` ran before 105.0.5 holds those values: change them in `~/.pi/agent/cliproxyapi.json`
  to `"providerId": "provimux"` and `"providerName": "Provimux"` (or remove both lines) **before** updating, or its
  models move back to `cliproxyapi/<id>`.
- **A models cache whose `claudeMessages` is a boolean** (written by the first versions with the Claude Messages
  format) is read as `"off"`: one with `true` is fetched again once instead of read as `"on"`. `true` and `false`
  in `cliproxyapi.json` keep their meaning.
- The README no longer explains moving from pi-cliproxyapi-provider, from the provider id `cliproxyapi` or from a git
  install.

## 105.0.5

Two changes: Provimux's models now go by the provider id `provimux`, and the footer names the route that answered.

- **The provider id is `provimux`** (was `cliproxyapi`). pi's `/model` shows `[provimux]`, and the models are
  `provimux/<id>`. One provider is registered, under that id. The old id is not registered next to it, sessions are
  not moved, and its `auth.json` entry is not read.
- **A setup made by an earlier `/login` keeps working from `cliproxyapi.json`.** That `/login` wrote
  `"providerId": "cliproxyapi"` without anyone choosing it, so the value now reads as the default, `provimux`, as
  `"providerName": "CLIProxyAPI"` already does. The file's `apiKey` and `baseUrl` are used as before, with no new
  `/login`. Any other id in the file is kept. So is any value of `CLIPROXYAPI_PROVIDER_ID`, `cliproxyapi`
  included.
- **What an existing setup must do:**
  - pick the models again as `provimux/<id>`. In `settings.json`, `"defaultProvider": "cliproxyapi"` silently starts
    pi on another model: set `"defaultProvider": "provimux"` with `"defaultModel": "<id>"`, or highlight the model in
    `/model` and press Ctrl+S (Enter only switches the live model). An `enabledModels` entry `"cliproxyapi/<id>"`
    matches nothing: change it to `"provimux/<id>"` by hand. `--model cliproxyapi/<id>` must become
    `--model provimux/<id>` or `--provider provimux --model <id>`;
  - rename a `providers.cliproxyapi` block in `models.json` (headers, `modelOverrides` such as thinking levels,
    windows, prices) to `providers.provimux`; under the old name it applies to nothing. pi-cache-keeper moves its
    own values there by itself at its next start and leaves only fields you set by hand under the old id;
  - log in with the account login, not the API-key login (see below). A setup whose key is only in `auth.json`
    under `cliproxyapi` (no `apiKey` in `cliproxyapi.json`, no `CLIPROXYAPI_API_KEY`) needs one `/login provimux`;
  - an old session recorded on `cliproxyapi/<id>` does not get its model back when resumed. pi warns
    `Could not restore model cliproxyapi/<id>. Using …` and goes on with the model it would start with. Pick
    `provimux/<id>` with `/model`;
  - `CLIPROXYAPI_PROVIDER_ID=cliproxyapi` keeps the old id for anyone who wants it, with its stored login.
- **Logins work as in 105.0.4.** Use `/login provimux` with **Sign in with an account**, or `apiKey` and
  `baseUrl` in `cliproxyapi.json`. pi's **Sign in with an API key**, offered when the file or
  `CLIPROXYAPI_API_KEY` already holds a key, still does not survive a restart (`Provider is not configured`), as in
  105.0.4. A key in `cliproxyapi.json` (or `CLIPROXYAPI_API_KEY`) wins over a key saved by a later `/login` that
  does not rewrite the file; the account login rewrites it.
- **The footer says which route answered.** After each answer on a Provimux model, the footer shows `answered:
  Anthropic sub`, `answered: Devin sub`, `answered: Anthropic api`, `answered: OpenRouter api` …, in the words of the
  model names. It only ever shows the route that produced the answer you see: it is read from the answer's
  `X-CPA-AUTH-*` headers (on the Codex WebSocket, the `cpa_auth_*` fields of its `response.created`), from the attempt
  that answered when pi tried again (an attempt that names nobody is unnamed), and only a turn that completed with
  something in it changes it (a failed, aborted or empty one leaves it as it was). It needs no other extension; the
  credential list and its priorities play no part, so any install's routes, in any order, are named as they answer.
  Only the session's own turns count: pi's cache warmer and other extensions' requests never change it. An answer a
  proxy that lists its credentials would not name shows `answered: unknown`, from the first turn on (a failed lookup
  of that list changes nothing); plain CLIProxyAPI shows nothing, and so does a model of another provider. On by
  default; `"answered": false` in `cliproxyapi.json` turns it off.
- **Unchanged:** the files `cliproxyapi.json` and `cliproxyapi-models.json`, the `CLIPROXYAPI_*` environment
  variables, the internal API name `cliproxyapi-codex-responses`, and `/provimux-refresh`.

## 105.0.4

- **`/cliproxyapi-refresh` is gone.** Only `/provimux-refresh` reloads the model list; pi no longer shows two
  refresh commands. Everything else of 105.0.3 stays: the provider id `cliproxyapi`, the `CLIPROXYAPI_*`
  environment variables, `cliproxyapi.json` and `cliproxyapi-models.json`, `/login cliproxyapi` (and
  `/login CLIProxyAPI`, the same id), and a stored `"providerName": "CLIProxyAPI"` read as Provimux.

## 105.0.3

The command and the login now say Provimux. The old names keep working.

- **`/provimux-refresh`** reloads the model list. `/cliproxyapi-refresh`, its name in the original extension, stays
  as an alias, and its description says it is the old name of `/provimux-refresh`.
- **The login is shown as Provimux** in `/login`'s list, its prompts and the extension's messages (was
  CLIProxyAPI). `/login Provimux` and `/login cliproxyapi` work; so does `/login CLIProxyAPI`, which pi matches,
  ignoring case, to the provider id. A `cliproxyapi.json` written by an earlier `/login` holds
  `"providerName": "CLIProxyAPI"`: that value now reads as the default, Provimux. Another name in the file, or any
  name in `CLIPROXYAPI_PROVIDER_NAME`, is kept.
- **Unchanged:** the provider id `cliproxyapi` (`cliproxyapi/<model>` in settings and sessions), the
  `CLIPROXYAPI_*` environment variables, `cliproxyapi.json`, `cliproxyapi-models.json`, and the internal API name
  `cliproxyapi-codex-responses`.

## 105.0.2

The extension is the same as in 105.0.1; what changes is how pi-provimux is released.

- **Published from GitHub, with provenance.** npm versions are published by the repository's `publish.yml` through
  npm trusted publishing: no token, and each version on npm names the workflow run and the commit it was built
  from. A version is published when `main` names one that npm does not have; its tag `v<version>` and GitHub release
  are made by the same run.
- **Following the original.** A workflow takes each new release of
  [pi-cliproxyapi-provider](https://github.com/router-for-me/pi-cliproxyapi-provider) once it has been public for
  24 hours. When it merges cleanly, passes a guard and passes every check, it is merged into `main` and released as
  the next version (`105.1.1` for the original's 1.5.1). Anything else lands nothing and is reported in an issue.
  Until it is switched on, it runs as a dry run: everything is checked, and it only says what it would land.
  How it works, and what it accepts: [docs/FOLLOWING.md](docs/FOLLOWING.md).
- **Checked on pi 1.3.0 and pi 1.6.0** before anything lands and before anything is published, with the packed
  package loaded by pi's own loader on both. The archive published to npm is that tested archive, byte for byte.

## 105.0.1 - 2026-11-22

The extension is now **pi-provimux**, Provimux's pi extension, a fork of
[router-for-me/pi-cliproxyapi-provider](https://github.com/router-for-me/pi-cliproxyapi-provider). It works with
plain CLIProxyAPI too.

### The name

- The package is `pi-provimux` (was `@router-for-me/pi-cliproxyapi-provider`): `pi install npm:pi-provimux`, or
  from git, `pi install git:github.com/ngvoicu/pi-provimux`.
- Nothing your setup names changes: the provider id `cliproxyapi` (`cliproxyapi/<model>`), `/login CLIProxyAPI`, the
  commands, the `CLIPROXYAPI_*` environment variables, `cliproxyapi.json`, `cliproxyapi-models.json` and the
  `model-upstreams` events stay as they were. Remove the old package before installing this one, so that only one
  registers the provider.
- Log lines start with `[pi-provimux]`.
- The README describes the extension as Provimux's, with credits to router-for-me. The LICENSE keeps
  router-for-me's notice.

### Changed

- **What answered names the credential, not only its kind.** `model-upstreams:answered` reports the one credential
  Provimux names in `X-CPA-AUTH-PROVIDER` and `X-CPA-AUTH-HOST` (`cpa_auth_provider`, `cpa_auth_host` on the Codex
  WebSocket's `response.created`), read from the response alone: a Claude login and a Devin login serving one model
  are told apart, and a service not known is named by its host or provider. At most one report per answer, sent when
  its headers or first event arrive, while the request is out, for the model the request was sent to (a virtual
  model's routed one). Over HTTP and SSE only the headers count; over the WebSocket only `response.created`.
- **Each request is reported on its own.** Overlapping requests (pi's cache warmer next to the turn it warms, an
  extension's own request with the session's callbacks, two requests to one model, a WebSocket turn next to an SSE
  request) each report their own credential, once: a request's headers and its one report are kept by that request
  alone, never in a slot shared with other requests.
- **`upstreams: []` for an answer that names nobody.** When Provimux leaves an answer without a name (plugin code
  took part in it), the report says `upstreams: []`: answered, by something the proxy would not name, read as
  "route not known". It is sent only once the proxy is known to name answers: such an answer is not reported while
  the credential list is still loading (or could not be read) and nothing was named before in the session. Plain
  CLIProxyAPI, which names no answer, still gets no report. Only the kind, from an older Provimux: the guess from the
  credential list, as before, so such an answer is not reported until the list has loaded; it still shows that the
  proxy names answers, so the next answer that names nobody is reported as `[]`.
  [pi-cache-keeper](https://github.com/ngvoicu/pi-cache-keeper) reads `[]` as "route not known" from its next
  release, 0.7.0, on; older versions ignore it.
- **More credentials map to pi's providers:** the kimi.com login to `kimi-coding`, xAI to `xai`, Vertex to
  `google-vertex`, and API keys by host to `xai`, `meta`, `kimi-coding`, `moonshotai`, `moonshotai-cn`, `deepseek`,
  `mistral`, `groq`, `cerebras`, `fireworks`, `together`, `nvidia` and `xiaomi`. A host or provider such as
  `constructor` is named as given. The model id is the provider's own, as pi's catalog has it, in the routes and in
  what answered: a prefix (the proxy's, or a configured one) is left out unless what is left is not in the catalog
  and the id with it is (`openai/gpt-oss-120b` at Groq stays as it is; `openai/llama-3.3-70b-versatile` there is
  `llama-3.3-70b-versatile`).
- **Needs pi 0.99.0 or newer** (was 0.82.0). On older pi, `model-upstreams:answered` was never sent for Codex
  WebSocket turns, as pi only passes their events to extensions (`provider_stream_event`) from 0.99.0.
- **A hook's removal of the GPT system prompt is honoured, on pi before 1.6.0.** When an extension's
  `before_provider_request` hook deletes `instructions` (or sets them to `undefined`), the base prompt is no longer
  put back as the first developer message: the request goes as the hook left it, for example with only the hook's
  own replacement. A hook that changes `instructions` still has its text moved, and without a hook the caching fix
  from 1.5.0 is unchanged. On pi 1.6.0 there are no `instructions` to remove: pi puts the system prompt in the first
  input item itself, before the hook runs, so a hook that wants it gone has to remove that item.
- **Claude Messages models keep their standard price under `/fast` and `/ultrafast`.** They are sent to
  `/v1/messages` without a speed tier, so the Fast price from models.dev no longer applies to them.
- **A thinking level the model doesn't have is refused in `pi -p`, never changed silently.** `pi -p --thinking low`
  (or `--model cliproxyapi/<model>:low`, `--models cliproxyapi/<model>:low`, or `--mode json`) on a model whose
  levels don't include `low` now stops before sending anything, says which levels the model has, and exits with 1;
  pi used to move it to the nearest level without a word. The model flags are read as pi reads them: a `:high` that
  is part of a model's id (`--model cliproxyapi/local-assistant:high`) asks for no level, and a `--models` level counts
  only where pi takes it (a new session, no `--model`). Interactive and RPC sessions keep pi's own move, and a
  Codex-format request, an extension's own included, now names the level pi moves to, never one the model lacks, so
  the proxy never picks a variant itself. That holds for a resumed conversation too: the first turn's level, which
  the request keeps from the history, and later turns' levels are moved the same way when a catalog refresh took
  them away.
- **A route lookup still out when its session ends is dropped.** On quit, `/reload` or a session change, the
  `model-upstreams` lookup in flight is aborted and a late answer is ignored; nothing is emitted through a disposed
  extension, so `pi -p` no longer exits with 1 after its answer, nor `/reload` ends the new session.

### From pi-cliproxyapi-provider 1.5.0 (merged)

- **Ultra Fast mode**: `/ultrafast` sends `service_tier: "ultrafast"` on models that offer it. `/fast` and
  `/ultrafast` exclude each other, and `fast` in `cliproxyapi.json` may now also be `"ultrafast"`.
- **GPT Responses prompt caching kept**: for `gpt-` models the base prompt is sent as the first `developer` input
  message instead of top-level `instructions`, so the prompt cache keeps being read. This is for pi before 1.6.0;
  pi 1.6.0 does it itself, for every model, and its request is sent as pi built it.

### Already in this fork before 105.0.1

- Claude models in Claude's own Messages format, automatically where safe (`claudeMessages`).
- Where each model comes from, at the end of its name, from Provimux's model list.
- Where each model comes from and which kind of credential answered, for other extensions (`model-upstreams`,
  `model-upstreams:request`, `model-upstreams:answered`), including over the Codex WebSocket.
- The package listed once in pi.
