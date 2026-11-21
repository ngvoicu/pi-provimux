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
  are told apart, and a service not known is named by its host or provider. It is sent when the answer's headers or
  first event arrive, while the request is out. An answer that names nobody (plain CLIProxyAPI, or a Provimux answer
  plugin code took part in) gets no report, which listeners read as a route not known. Only the kind, from an older
  Provimux: the guess from the credential list, as before.
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
