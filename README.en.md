# dsh-model-retry

**Per-model retry policy for DeepSeek Harness: retry counts, cooldown modes, and automatic retries for transient errors in direct model calls such as auto review.**

[简体中文](README.md) · [Changelog](CHANGELOG.md) · [Report an issue](https://github.com/your-github-name/dsh-model-retry/issues) · [Security](SECURITY.md)

[![Plugin](https://img.shields.io/badge/plugin-0.2.0-6f83ff?style=flat-square)](CHANGELOG.md)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2-8b5cf6?style=flat-square)](#version-support-policy)
[![License](https://img.shields.io/badge/license-MIT-536990?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-3c873a?style=flat-square)](#development-and-testing)

DSH's built-in retry only goes down to the provider level, and its backoff is fixed to "exponential + jitter". This plugin adds what DSH cannot do today:

- set retry counts **per model**, where `0` means **retry forever**;
- choose a cooldown of **fixed interval** or **incrementing interval** (each wait adds N seconds to the previous one);
- counts are independent **per step**: every model call in a new step starts again from 1;
- and fixes an issue that can stall the toolchain: when the reviewer model used by auto review returns 429/5xx, the failed review is treated as "tool execution denied". The plugin retries these **transient errors**, while a **real review rejection is never retried**.

## Why you need it

DSH's retry policy is implemented by `@deepseek-ai/dsh-llm-retry`, which has three limits:

| Limit | Behavior | What this plugin does |
| --- | --- | --- |
| Granularity is the provider | All models under one provider share a single policy | Configured per `provider/model` |
| Backoff is exponential only | `initialDelayMs × 2^(n-1)` plus jitter, no fixed or linear mode | Two cooldowns, `fixed` and `increment` |
| `maxRetries: 0` means "do not retry" | The opposite of "retry forever" | `retries: 0` explicitly means unlimited |

The plugin therefore **takes over** this path: it disables the built-in `llm-retry`, implements an executor of the same shape, and emits the same `llm/retry` / `llm/retry-started` session events as the original, so the retry cards in chat and the session log format are unchanged.

> ⚠️ **After installation the `llm-retry` row is disabled**, and retries are handled entirely by this plugin. With no models configured, behavior is identical to the original (it still uses the provider's `retryPolicy`).

## Features

- **Per-model counts and cooldown**: `retries`, `delayMode`, `delaySeconds`, `incrementSeconds`, `maxDelaySeconds`, plus a whitelist of retryable error codes.
- **Per-step counting**: several failures in the same step share one count; entering the next step resets it to zero.
- **Auto review is no longer denied by rate limiting**: 429, 5xx, timeouts, transport interruptions and empty responses are retried; auth and parameter errors still fail immediately.
- **Two editing entry points**: Settings → Models → "Failure retry" in the provider card, and a standalone "Model retry" settings page.
- **Safe defaults**: `unconfigured: inherit`, so nothing changes unless you configure it.
- **No build step**: plain JavaScript; the repository is the installable bundle.

## Version support policy

| Item | Current status |
| --- | --- |
| Plugin version | `0.2.0` |
| Verified against | DSH Desktop `0.2.1-rc.2`, `desktop` profile |
| Expected compatibility | The same RC series; DSH is still at the release-candidate stage, so breaking changes are possible across RCs |
| Node | `>=20` (uses `AbortSignal.any`) |

DSH is in developer preview, and the upstream extension points this plugin depends on (`agent/request-error`, `llm/stream`, the session event format) may change. If you hit an incompatibility, open an issue with your DSH version.

## Installation

### Install from GitHub (recommended)

```powershell
dsh plugin --profile web add github:your-github-name/dsh-model-retry
dsh --profile web --dump-config
```

Once `name: dsh-model-retry` appears in the output, **restart the Web Host and refresh the page**.

The desktop build uses a separate `desktop` profile and must be installed separately (quit the app completely first, then use the desktop build's bundled commands):

```powershell
dsh plugin --profile desktop add github:your-github-name/dsh-model-retry
dsh plugin --profile desktop list
```

### Install from a local directory

```powershell
dsh plugin --profile desktop add D:\path\to\dsh-model-retry
```

Or install a local directory from the plugin manager inside the app.

### When it takes effect

The plugin module is loaded when the Host starts. Module hot reload in DSH is opt-in and off by default (`root: []` on the hmr row in `dsh-base`), so **after modifying the plugin, or installing it for the first time, you must restart the corresponding Host or desktop app**; refreshing the page does not reload Host modules.

### Uninstall

```powershell
dsh plugin --profile web remove dsh-model-retry
```

After uninstalling, the built-in `llm-retry` is re-enabled and retry behavior returns to the original. Changes take effect after a restart.

## Usage

### Configure in the settings UI

- **Settings → Models → any provider card**: expand "Failure retry" and set the count and cooldown per model. Since "Add model" adds a row to the model table on the same card, this covers both configuring at add time and editing afterwards.
- **Settings → Model retry**: a full view grouped by provider, with the global default template and the policy for unconfigured models.

### Configure with a config file

Write this into the target profile's `cordis.patch.yml`:

```yaml
- id: model-retry
  name: dsh-model-retry
  config:
    # inherit = 沿用该 provider 的 retryPolicy（DSH 原生行为，默认）
    # off     = 未单独配置的模型不重试
    unconfigured: inherit

    # 新增模型时预填的模板；已配置的模型以自身条目为准
    defaults:
      retries: 5
      delayMode: fixed
      delaySeconds: 2
      incrementSeconds: 2
      maxDelaySeconds: 120

    models:
      yundu/gpt-6-astra:          # 键是 `<provider>/<model>`
        retries: 0                # 0 = 无限重试
        delayMode: increment
        delaySeconds: 1
        incrementSeconds: 2
        maxDelaySeconds: 60
      sensenova/kimi-k3:
        retries: 5
        delayMode: fixed
        delaySeconds: 3
        maxDelaySeconds: 30
```

### Fields

| Field | Purpose |
| --- | --- |
| `unconfigured` | `inherit` (default): unconfigured models use the provider policy; `off` means no retry. |
| `defaults` | The **template** prefilled when adding a model; it never overrides an existing model's entry at runtime. |
| `models.<provider>/<model>` | That model's own policy; omitted fields fall back to the policy defaults. |
| `retries` | Upper bound on retries. **`0` means retry forever**; it is counted per step, and a new step starts again from 1. Default `5`. |
| `delayMode` | `fixed`: the same interval every time; `increment`: each wait adds `incrementSeconds` to the previous interval. |
| `delaySeconds` | The fixed interval in seconds, or the first interval in increment mode. |
| `incrementSeconds` | Extra seconds added on each retry in increment mode. |
| `maxDelaySeconds` | Cap on a single cooldown; `0` means no cap. Default `120`. |
| `retryableCodes` | Error codes allowed to retry; default `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`. |

Cooldown sequences:

| Configuration | Wait before retry 1 / 2 / 3 |
| --- | --- |
| `delayMode: fixed, delaySeconds: 2` | 2s / 2s / 2s |
| `delayMode: increment, delaySeconds: 1, incrementSeconds: 2` | 1s / 3s / 5s |

A server-provided `Retry-After` (`providerRetryAfterMs`) takes precedence as long as it does not exceed `maxDelaySeconds`. Note that only the official DeepSeek adapter currently exposes this field; routes such as `openai-completions` do not.

## Why auto review gets wrongly rejected

Tool auto review makes a **single** direct call with the current model (`ctx.llm.stream()`) to judge risk. If that call ends because of rate limiting or a server error, the review path treats it as a "review failure" and then **denies execution of the tool under review**:

```
Auto review of tool "read" failed; its body was not executed:
auto-review: reviewer ended with error RATE_LIMIT: 429 ... TPM exhausted
```

The plugin adds a retry layer on the same `llm/stream` waterfall:

- only retryable error codes are retried (429 / 5xx / timeouts / transport interruptions / empty responses); auth and parameter errors still fail fast;
- only failures that have **not produced any content yet** are retried; a call that has already emitted content is not restarted, to avoid duplicate output;
- **a real review decision (a normal `stop` plus JSON) is never retried**;
- agent loop requests are covered by per-step retry and are explicitly skipped here via `isAgentLoopRequest`, so they are not retried twice;
- the budget uses the same per-model policy; when unconfigured, the provider's `retryPolicy` applies.

If the quota window is longer than the default backoff (about 15 seconds), give the model used by review a longer cooldown, for example:

```yaml
models:
  deepseek-account/deepseek-flash:
    retries: 5
    delayMode: increment
    delaySeconds: 30
    incrementSeconds: 30     # 30/60/90/120/150 秒
    maxDelaySeconds: 300
```

## How it works (short version)

```
Every failed model call
  └─ agent/request-error
       ├─ model not configured ──▶ replicate the built-in algorithm (exponential + jitter + Retry-After)
       ├─ unconfigured: off ──▶ no retry
       └─ configured ──▶ fixed / increment cooldown, counted per step
            ├─ a cooldown can be interrupted immediately by "Stop"
            ├─ append llm/retry → wait → append llm/retry-started
            └─ return retry, so the agent loop resends this attempt

Direct model calls (auto review / session title / compaction)
  └─ llm/stream waterfall
       └─ transient error and no content produced yet ──▶ wait per the same policy, then retry
```

The full design, upstream evidence chain and acceptance record are in [docs/design.md](docs/design.md); the reproducible verification method is in [docs/verification.md](docs/verification.md).

## Repository layout

```
.
├── index.js                  # Host half: retry executor and config contract
├── client.js                 # Browser half: settings UI controls (prebuilt classic-script bundle)
├── cordis.patch.yml          # bundle patch: disable llm-retry, insert model-retry
├── icon.svg                  # plugin icon
├── locale/{en,zh}.json       # title/description shown in the plugin manager
├── docs/
│   ├── design.md             # design doc and implementation notes
│   ├── verification.md       # verification methods, scenarios and expected numbers
│   └── research/             # upstream mechanism research notes (with file and line evidence)
├── scripts/
│   ├── mock-provider.mjs     # scriptable OpenAI-compatible mock server
│   ├── session-log.mjs       # session log parsing and invariant checks
│   ├── run.mjs               # verification CLI (selftest / mock / control / assert)
│   └── asar.mjs              # maintainer tool: reads DSH's app.asar
└── test/
    ├── engine.test.mjs       # offline assertions for the per-step retry executor
    └── stream-retry.test.mjs # offline assertions for direct-call retry
```

## Development and testing

Node `>=20` is required. Verification has two layers:

```powershell
# 1) mock service selftest (does not depend on the DSH runtime)
node scripts/run.mjs selftest

# 2) offline unit assertions (requires the DSH peer packages to resolve)
npm test
```

Both files run by `npm test` import this plugin, so `@deepseek-ai/schemastery`, `@deepseek-ai/cosmokit` and `@deepseek-ai/dsh-llm` must resolve; the simplest way is to run them in a DSH source checkout or in an installed, running Harness environment. When they cannot be resolved, the tests print `SKIP` and exit 0 instead of pretending to pass.

End-to-end verification against real retries (mock provider + real agent loop + session log assertions) is described in [docs/verification.md](docs/verification.md).

## Frequently asked questions

**Nothing changed after installation?**
The plugin defaults to `unconfigured: inherit`, so with no models configured it behaves like the original. Configure models under Settings → Models, or write `models` in the YAML as shown above.

**Configured it, but it seems to have no effect?**
Host modules are only loaded at startup, so **restart** the corresponding Host or desktop app after changing the config. `dsh --profile <name> --dump-config` confirms that both the `model-retry` row and your config layer are present.

**Will it conflict with the built-in retry?**
No. The plugin disables `llm-retry` through the patch and takes over the same extension point itself; the two are never active at the same time.

**Can unlimited retries hang?**
No. Clicking Stop, cancelling the turn, or destroying the agent immediately interrupts a retry that is waiting.

**Does the plugin access the network?**
No. It makes no network requests and collects no telemetry; it only reads its own config and DSH's public extension points.

**Can it coexist with other retry plugins?**
If another plugin also takes over `agent/request-error` or `llm/stream`, the two compete in registration order. Keep only one retry executor.

## License

[MIT](LICENSE) © 2026 dsh-model-retry contributors

DSH, DeepSeek Harness and related names belong to their respective owners. This plugin is an independent community project and is not affiliated with DeepSeek.
