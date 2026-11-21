# Changelog

## 2.0.0

The extension is now **pi-provimux**, Provimux's pi extension, a fork of
[router-for-me/pi-cliproxyapi-provider](https://github.com/router-for-me/pi-cliproxyapi-provider). It works with
plain CLIProxyAPI too.

### The name

- The package is `pi-provimux` (was `@router-for-me/pi-cliproxyapi-provider`), installed from git:
  `pi install git:github.com/ngvoicu/pi-provimux`. It is not published on npm.
- Nothing your setup names changes: the provider id `cliproxyapi` (`cliproxyapi/<model>`), `/login CLIProxyAPI`, the
  commands, the `CLIPROXYAPI_*` environment variables, `cliproxyapi.json`, `cliproxyapi-models.json` and the
  `model-upstreams` events stay as they were. Remove the old package before installing this one, so that only one
  registers the provider.
- Log lines start with `[pi-provimux]`.
- The README describes the extension as Provimux's, with credits to router-for-me. The LICENSE keeps
  router-for-me's notice.

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
