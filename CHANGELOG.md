# Changelog

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
