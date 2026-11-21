# pi-provimux

**Provimux's extension for [pi](https://pi.dev).** It adds [Provimux](https://github.com/ngvoicu/provimux) as a
provider in pi, and works the same with plain [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).

Every model your Provimux or CLIProxyAPI serves appears in pi's `/model`, under the provider `cliproxyapi`. With
Provimux, each model's name also says which accounts serve it (a subscription login or an API key, and whose), and
other pi extensions learn which one answered. With CLIProxyAPI, those parts stay quiet and everything else works.

```bash
pi install npm:pi-provimux
```

Then, in pi:

```text
/login CLIProxyAPI
```

and enter the server's address (for example `http://127.0.0.1:8317`) and your client key.

pi-provimux is a fork of [router-for-me/pi-cliproxyapi-provider](https://github.com/router-for-me/pi-cliproxyapi-provider),
see [Credits](#credits).

## What it does

From the original extension:

- **Your models in pi.** It reads the model list from `{root}/v1/models?client_version=pi` and registers each model
  with its context window, reasoning levels and, when [models.dev](https://models.dev) knows it, its price.
- **Setup by `/login`.** `/login CLIProxyAPI` asks for the address and the key, checks them, and saves them.
- **A model cache**, so pi starts at once when the server is slow; `/cliproxyapi-refresh` reloads the list.
- **`/fast` and `/ultrafast`**: faster service tiers on the models that offer them.
- **`/pause` and `/continue`**: hold every request to the provider until you continue.
- **GPT prompt caching kept**: the base prompt of `gpt-` models is sent so the prompt cache keeps being read.
- **Thinking level changes that keep the cache**, for models that support them.
- **Elapsed time and tokens per second** in pi's footer.
- **A fresh Codex WebSocket after compaction**, so the server's context matches the compacted one.

Added in pi-provimux:

- **[Claude Messages format](#claude-messages-format).** Claude models go to `/v1/messages` in Claude's own format,
  automatically where safe. With pi's long cache retention, that brings Anthropic's 1-hour prompt cache.
- **[Where each model comes from, in its name](#where-each-model-comes-from-in-its-name).** With Provimux, a model's
  name ends with what serves it: `Claude Opus 5.5 · Anthropic sub, fallback api`.
- **[Where each model comes from, for other extensions](#where-each-model-comes-from-for-other-extensions).** Over
  pi's event bus, which accounts may serve each model and, with Provimux, which one answered each response, also over
  the Codex WebSocket. [pi-cache-keeper](https://github.com/ngvoicu/pi-cache-keeper) uses it.
- **One package in pi's list.** The footer helper loads from the provider, so `pi list` shows a single extension.

## Install

```bash
# from npm
pi install npm:pi-provimux

# or from GitHub
pi install git:github.com/ngvoicu/pi-provimux

# from a local checkout
pi install /absolute/path/to/pi-provimux

# or temporarily for one run
pi -e /absolute/path/to/pi-provimux
```

It needs pi 0.99.0 or newer: the Codex WebSocket reports which kind of account answered through pi's
`provider_stream_event`, which older pi does not have.

### Coming from pi-cliproxyapi-provider

pi-provimux keeps everything your setup names: the provider id `cliproxyapi` (so `cliproxyapi/<model>` in your
settings still works), `/login CLIProxyAPI`, the commands, the `CLIPROXYAPI_*` environment variables, and the files
`cliproxyapi.json` and `cliproxyapi-models.json`. Remove the old package first, so that only one of them registers
the provider:

```bash
pi remove npm:@router-for-me/pi-cliproxyapi-provider   # or the source you installed it from
pi install npm:pi-provimux
```

## Login-style setup (recommended)

This plugin needs both **baseUrl** and **apiKey**. pi's built-in `/login` only supports multi-field prompts on the account/OAuth path, so CLIProxyAPI appears under **Sign in with an account** (not API key).

### Preferred: /login shortcuts

```text
/login CLIProxyAPI
```

or:

```text
/login cliproxyapi
```

These shortcuts jump straight into CLIProxyAPI's multi-field baseUrl + API key prompts. The provider is registered as OAuth-only, so pi does not ask you to choose between API key and account first.

### Menu path

```text
/login
```

Then choose:

1. **Sign in with an account**
   (required for multi-field baseUrl + API key prompts)
2. **CLIProxyAPI**
3. Enter:
   - base URL — preferred form is host:port, e.g. `http://127.0.0.1:8317`
   - API key

Final login validation calls `{root}/v1/models?client_version=pi` (this always bypasses the model cache and forces a fresh remote query):

- **HTTP 200** → login succeeds (empty model list is still OK) and the model cache is rewritten
- **non-200 / network error** → login fails and you are prompted to re-enter base URL + API key

On success:

- models are registered immediately in the current session (0 models is allowed)
- `baseUrl` / `apiKey` are written to `~/.pi/agent/cliproxyapi.json`
- pi also stores the returned credential in `~/.pi/agent/auth.json`

Re-run `/login CLIProxyAPI` or `/login cliproxyapi` anytime to reconfigure. The built-in `/logout` command only removes credentials saved in `auth.json`; it does not erase `cliproxyapi.json`. Remove or update that file if you also need to clear the provider configuration.

## Non-interactive configuration

You can still configure without `/login`.

### Config file

`~/.pi/agent/cliproxyapi.json`:

```json
{
  "baseUrl": "http://127.0.0.1:8317",
  "apiKey": "12345",
  "fast": false,
  "pause": false
}
```

Optional fields:

| Field | Default | Description |
| ------- | --------- | ------------- |
| `baseUrl` | `http://127.0.0.1:8317` | CLIProxyAPI address |
| `apiKey` | _(required unless set via /login or env)_ | Bearer token / CPA API key |
| `providerId` | `cliproxyapi` | Provider id shown in `/model` |
| `providerName` | `CLIProxyAPI` | Display name in `/login` and UI |
| `fast` | `false` | Persisted speed preference: `false` (off), `true` (Fast), or `"ultrafast"` (Ultra Fast) |
| `pause` | `false` | Persisted request-pause preference; provider requests wait until it is cleared |
| `tps` | `true` | Show the elapsed time footer and TPS summary in the TUI; see [Elapsed time and TPS](#elapsed-time-and-tps-tui) |
| `claudeMessages` | `"auto"` | When Claude models use Claude's own format: `"auto"`, `true` (always) or `false` (never); see [Claude Messages format](#claude-messages-format) |

### Environment overrides

| Variable | Overrides |
| ---------- | ----------- |
| `CLIPROXYAPI_BASE_URL` | `baseUrl` |
| `CLIPROXYAPI_API_KEY` | `apiKey` |
| `CLIPROXYAPI_PROVIDER_ID` | `providerId` |
| `CLIPROXYAPI_PROVIDER_NAME` | `providerName` |
| `CLIPROXYAPI_FAST` | `fast` (`true` / `false`, also accepts `1`, `0`, `yes`, `no`, `on`, `off`) |
| `CLIPROXYAPI_CLAUDE_MESSAGES` | `claudeMessages` (`auto`, or the same values as `CLIPROXYAPI_FAST`) |

Resolution order for connection settings:

1. Environment variables
2. `cliproxyapi.json`
3. `/login` credentials in `auth.json`
4. Default baseUrl `http://127.0.0.1:8317`

At startup, `CLIPROXYAPI_FAST` overrides the persisted speed preference: a true value selects Fast, and a false value turns both modes off. The variable does not accept `ultrafast`. If unset, the provider uses `fast` from `cliproxyapi.json`, or defaults to off.

### baseUrl normalization

Preferred form is **host:port only**:

| Input | Inference baseUrl | Models URL |
| ------- | ------------------- | ------------ |
| `http://127.0.0.1:8317` | `http://127.0.0.1:8317/backend-api/` | `http://127.0.0.1:8317/v1/models?client_version=pi` |
| `http://127.0.0.1:8317/backend-api` | `http://127.0.0.1:8317/backend-api/` | same models URL |
| `http://127.0.0.1:8317/v1` | `http://127.0.0.1:8317/backend-api/` | same models URL |
| `127.0.0.1:8317` | `http://127.0.0.1:8317/backend-api/` | same models URL |

pi then sends inference traffic to `{inference}/codex/responses`.

## Fast and Ultra Fast modes

Both modes are **off by default**. They request faster processing for supported models and may use more credits or incur higher costs.

| Command | Model status label | Request field |
| ------- | ------------------ | ------------- |
| `/fast` | `fast` | `service_tier: "priority"` |
| `/ultrafast` | `Ultra Fast` | `service_tier: "ultrafast"` |

The modes are mutually exclusive. Run the active command again to turn it off, or run the other command to switch directly. Each change saves the global preference in `~/.pi/agent/cliproxyapi.json` and refreshes the provider's model pricing. The saved preference is restored at the next startup unless `CLIPROXYAPI_FAST` overrides it.

Both modes apply only to models whose CLIProxyAPI catalog entry has a non-empty `service_tiers` array. The provider ignores `additional_speed_tiers`. When a mode is effective, pi appends its yellow label to the bottom-right model status without a separate notification. On unsupported models, the commands still update the global preference and warn when enabling a mode, but the request and model status remain unchanged.

Both modes are independent of pi's reasoning level and use `experimental.modes.fast.cost` from `models.dev` when available. Otherwise, the registered model uses the standard price; the plugin does not guess prices from `-pro` or `-fast` model IDs.

## Pausing provider requests

Pause provider requests with:

```text
/pause
```

Use `/continue` to clear the pause:

```text
/continue
```

Both commands persist the `pause` boolean in `~/.pi/agent/cliproxyapi.json`. Before every provider request, the extension rereads this setting. When it is `true`, the request waits asynchronously and checks again every 200 ms until `/continue` sets it to `false`. A pause issued during an active run lets that run finish before Elapsed stops; a run that starts while paused excludes its waiting time from Elapsed and TPS.

## Model cache

The provider keeps a separate cache file so startup stays fast when CLIProxyAPI is slow or briefly unreachable:

`~/.pi/agent/cliproxyapi-models.json`

The cache stores only model metadata and derived endpoint URLs — the model list, Fast-capable IDs, `inferenceBaseUrl`, `modelsUrl`, and a `fetchedAt` timestamp. It **never** stores your API key or other credentials.

| Property | Value |
|----------|-------|
| Cache file | `~/.pi/agent/cliproxyapi-models.json` |
| Remote query timeout | 60 seconds |
| Scope | tied to the current `baseUrl` (a different base URL ignores the existing cache) |

### Startup / resume behavior

When the provider loads (including session resume):

1. If a cache exists for the configured `baseUrl`, its models are registered immediately. A remote query to `{root}/v1/models?client_version=pi` then runs in the background; on success, the cache is rewritten and the registered model list is refreshed. If the query fails, the existing cache remains active.
2. If no matching cache exists, the remote query runs synchronously. On success, the cache is written and the fetched models are registered. If it fails, startup logs a warning and no models are registered until the proxy responds.

Use `/cliproxyapi-refresh` to force an immediate remote refresh of the model catalog.

### Refresh commands

- `/cliproxyapi-refresh` — force an immediate remote refresh of the model catalog, rewrite the cache, and update registered models. Use this after adding or removing models on the proxy without restarting pi.
- `/login CLIProxyAPI` / `/login cliproxyapi` — re-entering credentials always forces a fresh models query and rewrites the cache.

Delete `~/.pi/agent/cliproxyapi-models.json` to clear the cache manually.

## Model mapping

From CPA catalog entry → pi model:

| CPA field | Pi field |
| ----------- | ---------- |
| `slug` | `id` |
| `display_name` | `name`, followed by [where the model comes from](#where-each-model-comes-from-in-its-name) when CLIProxyAPI says |
| `context_window` | `contextWindow` |
| `input_modalities` | `input` (`text` / `image`) |
| `supported_reasoning_levels[].effort` | `thinkingLevelMap` + `reasoning` |
| `supports_reasoning_effort_updates` | `compat.supportsMidConvoEffort` |
| `visibility: "hide"` | skipped |

Unsupported pi thinking levels are set to `null` so they are hidden in the UI. When available, prices are matched against canonical model entries in `models.dev`; `cost.tiers[].tier.size` becomes pi's `inputTokensAbove`, including thresholds such as `272000`. The legacy `context_over_200k` field is used only when no explicit tiers are present. Ambiguous reseller prices are not selected arbitrarily and fall back to zero. These are catalog/list prices, not a guarantee of CPA's own markup or billing.

## GPT Responses prompt caching

For `gpt-` model IDs (ignoring case and surrounding whitespace), the provider sends the base prompt as the first `developer` input message instead of top-level `instructions`. Nonblank text is kept verbatim; blank text defaults to `You are a helpful assistant.` Existing input items stay in order, tools and `prompt_cache_key` are unchanged, and other models keep their existing request shape. This applies to HTTP and WebSocket requests, including Pi background streams that use this provider. A changed developer prefix or model sends the full input instead of a WebSocket continuation delta. An extension's `before_provider_request` hook comes first: if it changes `instructions`, its text is the one moved; if it removes them (deleted or set to `undefined`), no base prompt is put back, and the request goes as the hook left it.

## Cache-preserving thinking level changes

Models whose catalog entry sets `supports_reasoning_effort_updates` (GPT-6 on CLIProxyAPI) get pi's cache-preserving mid-session thinking level changes, matching the behavior pi >=1.3.0 ships for the OpenAI provider, with placement following the OpenAI documentation: the effort of the first turn becomes the fixed request-level `reasoning.effort`, and each later change is carried by a `configuration_update` input item placed immediately before the user message it applies to, so switching levels mid-session keeps the prompt prefix — and the upstream prompt cache — intact instead of rewriting it. WebSocket `previous_response_id` continuation also survives level changes. Histories lacking initial recorded levels (for example, sessions started before this support landed) may still need one full-context request while the baseline is being established. The behavior requires a pi >=1.3.0 host (its shared Responses converter); on older hosts the plugin detects the missing support and falls back to the classic request-level effort.

The raw `models.dev` response is cached for 24 hours at `~/.pi/agent/tmp/models-dev-cache.json`. A fresh cache avoids the network request; an expired cache is refreshed with a three-second timeout, and stale data is retained if refresh fails. If neither the network nor a previous cache is available, pricing safely falls back to zero. A small explicit alias table covers known CLIProxyAPI variants such as `gemini-pro-agent` → `gemini-3.1-pro-preview`; unknown variants are not guessed.

## Claude Messages format

Claude models can be sent in Claude's own format to CLIProxyAPI's `/v1/messages`, using pi's built-in Anthropic client,
instead of the Codex Responses format every other model uses. This happens automatically; nothing needs configuring.

- **Which models:** those CLIProxyAPI lists with `owned_by: "anthropic"` (from its plain `/v1/models`) that pi's
  built-in catalog also knows, **and** for which CLIProxyAPI reports an output limit (`max_tokens`). Their compat
  flags and thinking levels come from that catalog. Every other model, Claude models pi doesn't know, and Claude
  models without a reported output limit stay on the Codex format.
- **Setting:** `claudeMessages` in `cliproxyapi.json` (or `CLIPROXYAPI_CLAUDE_MESSAGES`) is `"auto"` by default.
  `false` keeps every model on the Codex format; `true` also switches Claude models CLIProxyAPI reports no output
  limit for (they then get pi's 16,384 default, see below).
- **Why:** Claude's format can carry Anthropic features the Codex format can't. The main one is the **1-hour cache**:
  with `PI_CACHE_RETENTION=long`, pi marks the prompt with `cache_control` `ttl: "1h"`, CLIProxyAPI passes it through,
  and Anthropic writes the 1-hour tier, on API keys too. One-hour cache writes cost 2× the input price instead of
  1.25×. The thinking levels offered are also the model's own, not a generic list.
- **Limits come from CLIProxyAPI:** the context window and output limit are what CLIProxyAPI reports, as for every
  other model. Unlike the Codex format, Claude's format sends the output limit (`max_tokens`) on every request. In
  `"auto"`, a Claude model CLIProxyAPI reports no output limit for stays on the Codex format, which sends no output
  limit; with `true` pi would fall back to 16,384 output tokens.
- **Not available for these models:** Fast mode (a Codex service tier; they keep their standard price under `/fast`
  and `/ultrafast`) and the Codex WebSocket transport. Thinking, tools, images and auto-compaction work as before.
- Changing the setting refreshes the model list (the cache records it). The first request of an ongoing session after
  a model switches formats is a cache miss.

## Where each model comes from, in its name

Through CLIProxyAPI pi sees one provider, so its model list does not say whether a model is served by a subscription
login or by a paid API key, nor by whom. [Provimux](https://github.com/ngvoicu/provimux), or a CLIProxyAPI that lists its credentials
([router-for-me/CLIProxyAPI#7634](https://github.com/router-for-me/CLIProxyAPI/pull/7634)), is asked for them with the
plain model list (`GET /v1/models?include=accounts`, one request per model list refresh), and each model's name then
ends with where it comes from:

```
Claude Opus 5.5 · Anthropic sub, fallback api
Claude Sonnet 4.6 · Anthropic sub, fallback Antigravity sub
anthropic/claude-opus-5.5 · OpenRouter api
```

- **`sub`** is a subscription login, **`api`** an API key.
- **First** comes what CLIProxyAPI may answer with: the credentials at the highest priority, joined by `or` when they
  differ (`Anthropic sub or api`). **After `fallback`** come the others, highest priority first: what may answer when
  the first fail or cool down. A service is named again only when it changes.
- **The service** is the one behind CLIProxyAPI's provider (`claude` is Anthropic, `codex` is OpenAI …). An API key
  goes by the host CLIProxyAPI names for it (`openrouter.ai` is OpenRouter whatever the entry is called; a host that
  is not known is shown as it is). A provider that is not known keeps CLIProxyAPI's name for it.
- Everything is read from CLIProxyAPI's list; nothing is guessed from a model's id or owner. A CLIProxyAPI that does
  not list its credentials, or a list that can't be read, leaves every name as it was.
- It says what the list said when it was fetched: after changing credentials or priorities in CLIProxyAPI, run
  `/cliproxyapi-refresh` (the startup refresh also updates it). What answered a given request is a separate matter:
  see the next section.

pi shows a model's name in `/model` beside its id and searches it, and its model patterns (`--model`, scoped models)
also match names: `openrouter` now matches every model that comes from OpenRouter, not only ids that contain the
word.

## Where each model comes from (for other extensions)

Through CLIProxyAPI pi sees one provider, but each model is served by a subscription login or an API key of some lab,
and the two can differ in window, prompt-cache lifetime and price (a Claude login keeps a cache for an hour, a Claude
API key for 5 minutes by default). This package tells other pi extensions where each model comes from, over pi's event
bus (`pi.events`), so that they need to know nothing about CLIProxyAPI.
[pi-cache-keeper](https://github.com/ngvoicu/pi-cache-keeper) uses it to fill windows, cache lifetimes and prices
from providers.dev.

- **`model-upstreams:request`**: an extension that wants the routes sends this (any payload). This package then asks
  CLIProxyAPI `GET /v1/models?include=accounts` again and answers. Without such an extension this adds no request;
  the model list itself is always loaded with `?include=accounts`, for the names and the Claude Messages format.
- **`model-upstreams`**: `{ provider, models: { [modelId]: { upstreams, fallbacks? } } }`, the answer, and again after
  `/cliproxyapi-refresh`. `upstreams` are what may serve the model (several: it is not known which), `fallbacks` what
  may answer when those fail or cool down.
- **`model-upstreams:answered`** (Provimux): `{ provider, model, upstreams }`, what answered a request, at most once
  per answer. `model` is the model the request was sent to (a virtual model's routed model, not the selection).
  Over HTTP and SSE only the response headers count: the kind in `X-CPA-AUTH-KIND`, the credential's provider in
  `X-CPA-AUTH-PROVIDER` and an API key's host in `X-CPA-AUTH-HOST`; fields in the body are not Provimux's (an inner
  gateway's) and are ignored. Over the Codex WebSocket, which has no response headers per turn, only the
  `cpa_auth_kind`, `cpa_auth_provider` and `cpa_auth_host` fields Provimux puts on the turn's `response.created`.
  - **With the provider**, `upstreams` is that one credential, whatever its priority, read from the response alone:
    its provider (whatever its letter case), its kind, and its host, where no host means the credential has none. The
    credential list is not consulted (it may be older than the proxy's state) nor waited for. A Claude login and a
    Devin login serving the same model are told apart. A credential that leads to a service not known is still
    named, so a change of route is seen: by its host for an API key that has one (`api.example.test`), else by its
    provider as the response gives it.
  - **With only the kind** (an older Provimux that does not name the provider), a guess: the listed credentials of
    that kind at their highest priority, possibly several; `[]` when none of them is known. The guess needs the
    credential list: until it has loaded, such an answer is not reported at all, even after earlier answers were
    named.
  - **`upstreams: []`**: answered, by something the proxy would not name. Provimux leaves an answer without the
    three when plugin code took part in its bytes; from a proxy that names answers (it lists its credentials, or
    named an answer before in this session) such an answer is reported as `[]`, so that a listener does not keep the
    last named credential's values. Read it as "route not known". Whether the proxy names answers is known only once
    its credential list has loaded or it has named one: an answer that names nobody while the list is still loading
    and before anything was named in this session is not reported. A list that could not be read counts as still
    loading.
  - **Nothing** from plain CLIProxyAPI, which names no answer, nor before an extension asked for the routes.
  - **When**: as soon as the answer's headers (or its `response.created` event) arrive and its stream's first event
    says which model it is for, so before the answer ends, while the request is still out.
  - **Each request on its own.** Requests overlap: pi's cache warmer refreshes the cache while the turn it warms is
    still streaming, and an extension can send its own request with the session's callbacks. Each request keeps its
    own response headers and its one report, so an answer is never reported with another request's credential or
    model.

  [pi-cache-keeper](https://github.com/ngvoicu/pi-cache-keeper) reads `upstreams: []` as "route not known" from its
  next release, 0.7.0, on; older versions ignore an empty `upstreams` and keep what they had.

An upstream is `{ provider, model?, subscription? }`: the pi provider the model would come from if used directly
(`anthropic`, `openai-codex`, `openai`, `meta`, `openrouter`, `google`) or a providers.dev provider pi has none for
(`devin`, `antigravity`); the model's id there when it differs; `true` for a subscription login, `false` for an API
key, absent when not known.

How the routes are made:

- **Provimux, or a CLIProxyAPI that lists its credentials** ([router-for-me/CLIProxyAPI#7634](https://github.com/router-for-me/CLIProxyAPI/pull/7634)):
  CLIProxyAPI uses the highest priority that is free in every routing mode and picks among the credentials sharing it
  (round-robin by default; with no priority set, all share 0). So the `upstreams` are the credentials at the highest
  priority, the `fallbacks` the others. An API key whose host CLIProxyAPI names goes by the host (`openrouter.ai`,
  `api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`, `api.x.ai`, `api.meta.ai`,
  `api.kimi.com`, `api.moonshot.ai`, `api.moonshot.cn`, `api.deepseek.com`, `api.mistral.ai`, `api.groq.com`,
  `api.cerebras.ai`, `api.fireworks.ai`, `api.together.ai`, `integrate.api.nvidia.com`, `api.xiaomimimo.com`;
  another host is not known), whatever its entry is called; without a host, an OpenAI-compatible entry counts as
  OpenRouter only when named `openrouter`. The model id is the provider's own, as pi's catalog has it: a prefix
  CLIProxyAPI puts before a credential's models is left out, and nothing else (`openai/gpt-oss-120b` at Groq,
  `Qwen/Qwen3.6-Plus` at Together, `google/gemma-3-12b-it` at NVIDIA, `accounts/fireworks/models/…` at Fireworks,
  `lab/model` at OpenRouter). A credential at the top that leads somewhere not known makes the route not known
  (`upstreams: []`).
- **A CLIProxyAPI that doesn't**: the lab its model list names as the owner (`owned_by`), by login or key
  (`subscription` absent; for OpenAI the Codex login or an OpenAI key); `devin/…` (CLIProxyAPI's own prefix) is Devin;
  any other name with a slash is not known.

## Migration from static models.json

If you previously maintained a static provider such as `cpa-responses` in `~/.pi/agent/models.json`:

1. Install this package and run `/login CLIProxyAPI` or `/login cliproxyapi` (or set `cliproxyapi.json`).
2. Point `defaultProvider` / `enabledModels` at `cliproxyapi/<model-id>` (or set `providerId` to `cpa-responses` for a drop-in id).
3. Remove the hand-maintained models array once the dynamic list looks correct.

## Elapsed time and TPS (TUI)

The provider extension also loads `extensions/tps.ts` (so pi lists the package as a single extension), which only activates for the primary interactive TUI session (`ctx.hasUI && ctx.mode === "tui"`):

- While the agent is running, the footer shows `Elapsed …` (updates every second).
- When the agent settles, the footer keeps the final elapsed time and a notification reports approximate TPS plus token usage (`out` / `in` / cache r/w / total).
- Subagent and print-mode sessions do not own the timer, clear the parent footer, or emit TPS toasts.

Set `"tps": false` in `~/.pi/agent/cliproxyapi.json` to turn off just this helper (takes effect on the next start or `/reload`).

## Failure behavior

- CLIProxyAPI `closed network connection` responses are normalized as transient network errors so pi's agent-level retry policy reconnects and restarts the interrupted assistant turn. Completed conversation and tool results remain available; token streaming does not resume from the exact interruption point.
- Before setup / without credentials: provider still appears in `/login`; no models are listed yet.
- After successful `/login`: models are registered; credentials are stored in `auth.json` and mirrored to `cliproxyapi.json`.
- The built-in `/logout` command removes only the matching `auth.json` credential; environment variables and `cliproxyapi.json` are unchanged.
- If a models request returns **HTTP 401** or CPA is unreachable during startup, an existing matching cache remains in use while the background refresh fails. Only when no cache is available is a warning logged; reconfigure via `/login CLIProxyAPI` or fix config/env.
- Login final step validates credentials by requesting models:
  - HTTP 200 (including empty catalog) → credentials are persisted
  - non-200 / network / invalid baseUrl → nothing is persisted; re-enter baseUrl + API key
- If CPA returns HTTP 200 with zero usable models: login still succeeds; re-run `/login CLIProxyAPI` later after models become available.
- If the selected model does not provide a non-empty `service_tiers` array: the request is left unchanged; `/fast` and `/ultrafast` still update the global preference and warn when enabling a mode.
- After `/compact`, threshold compaction, or overflow recovery, the provider closes the reused Codex WebSocket for the current session. CLIProxyAPI binds server-side context to the connection, so a reused socket would keep reporting a near-full `cacheRead` and retrigger proactive compaction even though the client context is now small. SSE is unaffected because it bills from the request body.

## Credits

pi-provimux is a fork of [pi-cliproxyapi-provider](https://github.com/router-for-me/pi-cliproxyapi-provider) by
[Router-For.ME](https://github.com/router-for-me), released under the MIT license. Nearly everything it does is their
work: the provider, the login, the model mapping, the cache, the Fast modes and the Codex stream. pi-provimux adds the
Provimux parts above and merges the original's changes. Thank you to router-for-me for the extension and for
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).

## License

MIT. See [LICENSE](LICENSE).
