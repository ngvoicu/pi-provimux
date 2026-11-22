# Changelog

## 2.0.0

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
- **A hook's removal of the GPT system prompt is honoured.** When an extension's `before_provider_request` hook
  deletes `instructions` (or sets them to `undefined`), the base prompt is no longer put back as the first developer
  message: the request goes as the hook left it, for example with only the hook's own replacement. A hook that
  changes `instructions` still has its text moved, and without a hook the caching fix from 1.5.0 is unchanged.
- **Claude Messages models keep their standard price under `/fast` and `/ultrafast`.** They are sent to
  `/v1/messages` without a speed tier, so the Fast price from models.dev no longer applies to them.

### From pi-cliproxyapi-provider 1.5.0 (merged)

- **Ultra Fast mode**: `/ultrafast` sends `service_tier: "ultrafast"` on models that offer it. `/fast` and
  `/ultrafast` exclude each other, and `fast` in `cliproxyapi.json` may now also be `"ultrafast"`.
- **GPT Responses prompt caching kept**: for `gpt-` models the base prompt is sent as the first `developer` input
  message instead of top-level `instructions`, so the prompt cache keeps being read.

### Already in this fork before 2.0.0

- Claude models in Claude's own Messages format, automatically where safe (`claudeMessages`).
- Where each model comes from, at the end of its name, from Provimux's model list.
- Where each model comes from and which kind of credential answered, for other extensions (`model-upstreams`,
  `model-upstreams:request`, `model-upstreams:answered`), including over the Codex WebSocket.
- The package listed once in pi.
