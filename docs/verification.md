# `dsh-model-retry` verification harness

Objective, repeatable verification for the per-model retry plugin
(``) without waiting for a real provider outage.

The Harness in this install has no standalone CLI (there is no `dsh` executable
on this machine, and `dsh-headless` ships only as an asar package), so the harness
cannot start the agent loop itself. Its contract is:

1. **mock provider** — a scriptable, OpenAI-compatible HTTP endpoint that fails on
   command (status codes, `Retry-After`, delayed bodies) and logs every request;
2. **the manual run in the Web GUI** — one chat per scenario, driven by the
   scenario's mock plan;
3. **durable assertions** — parse the session log the live Harness wrote under
   `%DSH_HOME%\sessions\` and assert `llm/retry` / `llm/retry-started` /
   `request/header` / `turn/end` semantics, plus attempt gaps measured from the
   mock's request log.

Everything below runs on the bundled plain Node (no npm installs):

```powershell
$node='%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
```

Files:

| file | role |
|---|---|
| `scripts/session-log.mjs` | session-store reader: zstd concatenated-frame scanner, JSONL parser, retry-chain extraction, format-invariant validator |
| `scripts/mock-provider.mjs` | OpenAI-compatible mock (`/v1/models`, `/v1/chat/completions` SSE) + control API + request log |
| `scripts/run.mjs` | driver CLI: scenario catalog, mock runbook, mock control, session selection, attempt table, assertions, watcher, selftest |
| `scripts/README.md` | this file: path scheme, control API, per-scenario expected numbers, auto vs manual |

### Command map

```powershell
node scripts\run.mjs selftest                     # parser + assertion + mock self-test (no writes)
node scripts\run.mjs mock --port 8787 --default-status 500
node scripts\run.mjs scenarios                    # scenario catalog with expected numbers
node scripts\run.mjs runbook fixed                # step-by-step manual runbook for one scenario
node scripts\run.mjs control fixed --mock http://127.0.0.1:8787     # apply the scenario plan
node scripts\run.mjs control --json '{"plan":["500","ok"]}' --mock http://127.0.0.1:8787
node scripts\run.mjs list                         # session artifacts, newest first
node scripts\run.mjs latest --since-minutes 10
node scripts\run.mjs parse latest --json          # event counts + retry chain + invariants
node scripts\run.mjs assert fixed --session latest --mock http://127.0.0.1:8787 --since-minutes 10
node scripts\run.mjs watch --scenario fixed --mock http://127.0.0.1:8787 --since-minutes 5 --assert
```

`assert` exits 0 only when every check passes (1 = a check failed, 2 = usage/IO error),
so it can gate a CI-style loop of manual GUI runs.


---

## 1. Session-log store: path scheme and format (verified against real files)

```
%DSH_HOME%\sessions\                      # DSH_HOME defaults to C:\Users\<user>\.dsh
  --<normalized-cwd>--\                   # e.g. --<normalized-cwd>--
    <encoded-session-id>\                 # e.g. session-52329385-… or a bare uuid for subagents
      session.v4.jsonl.zstd               # current format (SESSION_FORMAT_VERSION = 4)
```

Evidence: `@deepseek-ai/dsh-session-persistence-jsonl/README.md:55-77`
(on-disk layout) and `.../lib/index.js:1305-1368` (frame scanner); version from
`@deepseek-ai/dsh-session/lib/index.js:56`.

- The `.zstd` artifact is **not** one zstd stream; it is a **concatenation of
  independent Zstandard frames** — one frame holding the header line, then one
  frame per durable append batch (README:111). Node's `zstdDecompressSync()`
  decodes only the first frame, so `scripts/session-log.mjs` scans frame
  boundaries structurally (exact port of the backend's `scanZstdFrames`) and
  decompresses each frame individually.
- A torn final frame (crash) is reported as `tornStart` and its complete records
  are still read — this matters if you assert while the turn is still writing.
- Decompressed content is one JSON row per line. The first row is the header:
  `{"type":"session","version":4,"id":…,"createdAt":…,"cwd":…,"origin":…,"agentPreset":…}`.
  Every following row is an event: `{"type":"llm/retry","seq":494,"time":1794123042…,"data":{…}}`.
- Plain `.jsonl` files (`compression: 'none'`) are accepted too.

The real store on this machine currently holds 37 artifacts; `selftest` parses the
newest 25 (32,895 events, 109 `llm/retry` events) without a single failure — one of
them is a genuine stock retry from an earlier agent run (turn 1 step 53, mode
`normal`, maxRetries 5, `delayMs 528.85`, failure `TRANSPORT`), which is exactly
the shape these assertions expect.

Retry invariants the parser also validates (authority:
`dsh-session-format-v3-to-v4/lib/index.js:676-699`,
`dsh-session-format-v0-to-v1/lib/index.js:2407-2424,2504-2513`):

- `llm/retry` sits inside the **open** `step/start`…`step/end` and its `turn/step`
  match that step;
- `provider` equals the open `request/header`'s `config.provider`;
- `retry` starts at **1** per `(turn, step, provider, policyKey)` chain and
  increments by one (no skips);
- `retryId` is stable within a chain, unique across steps;
- `mode:"normal"` carries integer `maxRetries`; `mode:"always"` omits it;
- `llm/retry-started` pairs a previously scheduled attempt with the same
  `turn/step/retry`.

---

## 2. Mock provider

### 2.1 Start it

```powershell
# persistent 500s by default (unlimited-retry scenario)
node scripts\run.mjs mock --port 8787 --default-status 500

# or start with a plan directly
node scripts\run.mjs mock --port 8787 --plan 500,500,ok
```

It prints `[mock] listening http://127.0.0.1:8787 (OpenAI baseURL http://127.0.0.1:8787/v1)`
and one line per request: `[mock] #2 POST /v1/chat/completions model=mock-model plan=error status=500 gap=2103ms`.

Routes:

| route | behaviour |
|---|---|
| `GET /v1/models` | `{"object":"list","data":[{"id":"mock-model",…}]}` |
| `POST /v1/chat/completions` | consumes the next plan entry; SSE `chat.completion.chunk` stream on success, HTTP error otherwise |
| `POST /__control` | replace plan/config (below) |
| `GET /__state` | current plan, cursor, defaults |
| `GET /__log` | every chat request (`n`, `at`, `atIso`, `tSincePrevMs`, `status`, `retryAfterSeconds`, `planEntry`, `durationMs`) |
| `POST /__reset` | clear log + reset plan cursor |

### 2.2 Control API

```jsonc
POST http://127.0.0.1:8787/__control
{
  "plan": [500, 500, "ok"],          // one entry per /v1/chat/completions request
  "defaultStatus": 500,              // after the plan runs out: number | "ok" | "empty"
  "retryAfterSeconds": 7,            // optional, applied to error responses
  "bodyDelayMs": 0,                  // optional, delay before every response
  "successText": "MOCK_OK",          // optional, text of a successful answer
  "resetLog": true,
  "resetCursor": true
}
```

Plan entry forms:

| entry | effect |
|---|---|
| `500`, `"503"`, `"429"` | HTTP error with that status; body message contains the numeric status |
| `"ok"` | SSE answer with `MOCK_OK` |
| `"empty"` | SSE with a `stop` finish and **no content** → harness maps to `EMPTY_RESPONSE` (retryable) |
| `{"status":429,"retryAfterSeconds":7}` | 429 with `Retry-After: 7` |
| `{"mode":"tool","toolName":"bash","arguments":"{\"command\":\"echo hi\"}"}` | SSE with one `tool_calls` delta, `finish_reason:"tool_calls"` (used only for the optional same-turn two-step variant) |
| `{"mode":"ok","text":"…","delayMs":250}` | successful answer after an extra delay |

Why the body carries the status number: `dsh-llm-pi-ai` classifies failures by
regex over the pi-ai error **text** (`classifyPiAiError`,
`dsh-llm-pi-ai/lib/index.js:1448-1459`; `\b5\d\d\b` → `SERVER`, `\b429\b` →
`RATE_LIMIT`). pi-ai formats HTTP errors as `"<status>: <body>"`
(`@earendil-works/pi-ai/dist/utils/error-body.js`, `formatProviderError`), so the
mock's numeric status reaches the failure code.

Two facts that make the mock's request log equivalent to the agent-loop attempt log:

- pi-ai's own retry wrapper is disabled: `openai-completions.js:195` passes
  `maxRetries: 0`, and `dsh-llm-pi-ai/lib/index.js:1764` passes `maxRetries: 0`
  in `profileOptions`. So **one mock request = one agent-loop attempt**.
- `--mock` assertions join the request log to session events by attempt index and
  print the actual gap next to the scheduled `delayMs`.

---

## 3. Profile setup

### 3.1 Install the plugin

```powershell
plugin_manager  action: install_bundle  target: <repo>\plugins\dsh-model-retry
```

then confirm the built-in executor is gone and ours is live
(`plugin_manager list_plugins`: row `llm-retry` should be disabled/absent, row
`model-retry` active; `fiberPhase` must not be `failed`). The bundle patch
(`cordis.patch.yml`) does `- id: llm-retry
  disabled: true` plus an `insert` of row `model-retry`; row id `model-retry` is
  also the settings namespace.

### 3.2 Add a mock provider

**GUI (recommended):** Settings → Models → *Add model provider* → **Custom model
API**, then:

| field | value |
|---|---|
| route id | `mock` (must match `/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/`) |
| display name | `Mock` |
| base URL | `http://127.0.0.1:8787/v1` |
| protocol | `openai-completions` |
| API key | any non-empty string (stored in the credential store; the mock ignores it) |
| models | one row, id `mock-model`, name `Mock`, input `text` |

Then pick **Mock / mock-model** in the composer before starting a scenario chat.

**Profile patch (alternative, no credential):** `dsh-llm-pi-ai` accepts
`providers.<route>.headers` (`z.dict(z.string())`), and pi-ai's
`getClientApiKey` returns `"unused"` when an `authorization` header is present
(`openai-completions.js:34-40`). So this route needs **no `apiKeyEnv` and no
stored credential**:

```yaml
# in %DSH_HOME%\profiles\desktop\cordis.patch.yml, inside the EXISTING
# `- id: llm-pi-ai` row's `config.providers` (an id patch replaces `config`
# wholesale — never add a second llm-pi-ai row or the other providers vanish):
providers:
  mock:
    displayName: Mock
    api: openai-completions
    baseURL: http://127.0.0.1:8787/v1
    headers:
      authorization: Bearer mock
    models:
      - id: mock-model
        name: Mock
        input: [text]
```

### 3.3 Configure the per-model policy

The plugin's settings namespace is `model-retry`:

```yaml
# Settings → 模型重试 (model-retry section), or directly through settings.mutate:
models:
  "mock/mock-model":
    retries: 3              # 0 = unlimited
    delayMode: fixed        # fixed | increment
    delaySeconds: 2
    incrementSeconds: 2
    maxDelaySeconds: 10     # 0 = no cap
    retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]
unconfigured: inherit       # inherit = stock exponential behaviour; off = no retry
```

`retries`/`delayMode`/`delaySeconds`/`incrementSeconds`/`maxDelaySeconds`/
`retryableCodes` are the fields the harness asserts against; `defaults` is only a
new-entry template and is not consulted for stored entries.

---

## 4. Scenario runbooks (exact expected numbers)

Each scenario: start the mock once, apply the scenario plan before the chat, run
the chat, then assert. The mock must stay running while you assert (its log holds
the HTTP statuses and measured gaps).

Common preamble:

```powershell
$node='%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$node scripts\run.mjs mock --port 8787 --default-status 500     # terminal 1
```

### 2. `stock` — unconfigured model keeps stock behaviour

- policy: delete/omit `models["mock/mock-model"]`; keep `unconfigured: inherit`;
  no `providers.mock.retryPolicy` (adapter default: 5 retries, exponential).
- plan: `500,500,500,500,500,500` (or `--default-status 500`).
- prompt: “Say hello in one short sentence.”
- expected: **5 retries / 6 attempts**; every event `mode:"normal"`,
  `maxRetries:5`; `delayMs` ≈ **500, 1000, 2000, 4000, 8000 ms ±10%**;
  `turn/end.reason.kind = "error"`.
- assert: `$node scripts\run.mjs assert stock --session latest --mock http://127.0.0.1:8787 --since-minutes 10`

### 3. `unlimited-abort` — `retries: 0` retries forever until Stop

- policy: `retries: 0, delayMode: fixed, delaySeconds: 2`.
- plan: none; `--default-status 500` (every request fails).
- prompt: “Say hello…”; wait for ≥ 3 retries (≈ 6 s), then click **Stop**.
- expected: ≥ 2 `llm/retry`, every one **`mode:"always"` with no `maxRetries`**;
  `turn/end.reason.kind = "aborted"`; the final scheduled retry has **no**
  `llm/retry-started` (abort during cooldown) and no request follows the abort.
- assert: `$node scripts\run.mjs assert unlimited-abort --session latest --mock http://127.0.0.1:8787`

### 4. `cap-n` — `retries: N` means exactly N retries

- policy: `retries: 3, delayMode: fixed, delaySeconds: 2`.
- plan: `500,500,500,500,500` (more failures than the cap).
- expected: exactly **3** `llm/retry` with `retry = 1,2,3`,
  `mode:"normal"`, `maxRetries:3`; `turn/end.reason.kind = "error"`;
  the 4th failure is terminal (no 4th event, no 5th request made at all —
  the loop stops after the 4th attempt).
- assert: `$node scripts\run.mjs assert cap-n --session latest --mock http://127.0.0.1:8787`

### 5. `per-step` — counting resets per step

- policy: `retries: 3, delayMode: fixed, delaySeconds: 1`.
- plan for turn 1: `500,500,500,ok` → 3 failures then success.
- after the first answer arrives, re-apply the plan for turn 2:
  `control per-step` again (or `control --json '{"plan":["500","500"],"defaultStatus":500}'`),
  then send a second prompt in the **same chat**: “Say goodbye.”
- expected: turn 1 chain `1,2,3` then `assistant/message`; turn 2's first
  `llm/retry` has `retry = 1` **again**; `retryId` differs between the two steps
  and is stable inside each step.
- (Same-turn variant, optional: plan entry
  `{"mode":"tool","toolName":"bash","arguments":"{\"command\":\"echo hi\"}"}`
  makes the mock drive a real second step in the same turn.)
- assert: `$node scripts\run.mjs assert per-step --session latest --mock http://127.0.0.1:8787`

### 6. `fixed` — fixed cooldown

- policy: `retries: 5, delayMode: fixed, delaySeconds: 2`.
- plan: `500,500,500,500` (the chat ends when the plan runs out at 500).
- expected: **every** `delayMs === 2000` exactly (no jitter). Mock gaps ≈ 2000 ms
  + HTTP latency; gaps are informational only — the session `delayMs` is the
  authoritative number.
- assert: `$node scripts\run.mjs assert fixed --session latest --mock http://127.0.0.1:8787`

### 7. `increment` — linear growth with cap

- policy: `retries: 6, delayMode: increment, delaySeconds: 2, incrementSeconds: 2, maxDelaySeconds: 10`.
- plan: `500,500,500,500,500,500`.
- expected: `delayMs = 2000, 4000, 6000, 8000, 10000, 10000` (the 5th and 6th
  are capped at `maxDelaySeconds`).
- assert: `$node scripts\run.mjs assert increment --session latest --mock http://127.0.0.1:8787 --increment-seconds 2 --max-delay-seconds 10`

### 8. `retry-after` — two expectations (adapter reality)

The pi-ai adapter does **not** surface `Retry-After`:

- `dsh-llm-pi-ai` builds `LlmFailure` as `{ message, code }` only
  (`lib/index.js:1470-1524`); no `providerRetryAfterMs`, no `status`.
- pi-ai parses `Retry-After` only for its own retry loop
  (`pi-ai/dist/utils/provider-retry.js:36-44`), which DSH disables
  (`maxRetries: 0`, `openai-completions.js:195`, `dsh-llm-pi-ai/lib/index.js:1764`).
- only `dsh-llm-deepseek` emits `providerRetryAfterMs`
  (`dsh-llm-deepseek/lib/index.js:1776`).

Therefore:

- **8a, pi-ai route (automatic, regression guard):**
  - policy: `retries: 3, delayMode: fixed, delaySeconds: 2`.
  - plan: `{"status":429,"retryAfterSeconds":7},"ok"`.
  - expected: the `llm/retry` has **no** `failure.providerRetryAfterMs` and
    `delayMs = 2000` (the local configured delay — the plugin must NOT invent 7000
    from an HTTP header it never received).
  - assert: `$node scripts\run.mjs assert retry-after --session latest --mock http://127.0.0.1:8787 --route pi-ai`
- **8b, deepseek route (manual/optional):**
  - needs a real `deepseek-account`/`dsh-llm-deepseek` call that returns
    `Retry-After: 7`, or a crafted `LlmFailure` with `providerRetryAfterMs: 7000`.
  - expected: `failure.providerRetryAfterMs = 7000` and `delayMs = 7000`.
  - assert: `$node scripts\run.mjs assert retry-after --session latest --route deepseek`

---

## 5. What the driver asserts automatically vs what stays manual

| check | automatic | how |
|---|---|---|
| events parse; torn tail handled | ✅ | `parse`, `selftest` |
| retry count / sequence / ids / per-step reset | ✅ | `assert cap-n / per-step / unlimited-abort` |
| `mode` and `maxRetries` shape (`normal`/`always`) | ✅ | all `assert` runs |
| `delayMs` exact values (fixed / increment / cap) | ✅ | `assert fixed / increment` |
| stock exponential shape for unconfigured models | ✅ | `assert stock` (count + ±10% windows) |
| session-format retry invariants | ✅ | every `assert` run runs `validateRetryInvariants` |
| turn outcome (`error` / `aborted`) | ✅ | `turn/end.reason` |
| HTTP status per attempt + measured gaps | ✅ when `--mock` is passed | joins `/__log` to session events |
| aborted-during-cooldown detection | ✅ | final retry without `llm/retry-started` |
| `Retry-After` on pi-ai route | ✅ | `assert retry-after --route pi-ai` (expects local delay) |
| `Retry-After` on deepseek route | ❌ manual | needs real/crafted `providerRetryAfterMs` |
| plugin installed & `llm-retry` disabled | ❌ manual | `plugin_manager list_plugins` |
| chat retry card renders / cancel semantics | ❌ manual | visual check in the GUI |
| provider card UI, per-model edit, draft state | ❌ manual | design §8.2 items 10-12 |
| uninstall restores stock behaviour | ❌ manual | design §8.2 item 13 |

The mock and the GUI runs can be done in any order; `assert` is read-only and can
re-run against the same session file repeatedly.

---

## 6. Watch mode (assert the run as it lands)

```powershell
# terminal 1
node scripts\run.mjs mock --port 8787 --default-status 500
# terminal 2 — applies the scenario plan, then waits for a new/updated session
node scripts\run.mjs watch --scenario fixed --mock http://127.0.0.1:8787 --since-minutes 5 --assert
```

`watch` waits until a session artifact modified in the window goes quiet for
1.5 s and ends with a `turn/end`, then prints the attempt table and (with
`--assert`) runs the scenario assertions.

Session selection on a machine with many chats:

```powershell
node scripts\run.mjs list                                   # newest first
node scripts\run.mjs latest --since-minutes 10
node scripts\run.mjs assert fixed --session <path>
node scripts\run.mjs assert fixed --session latest --since-minutes 10 --exclude <sessionId>
```

---

## 7. Selftest

```powershell
node scripts\run.mjs selftest
```

- parses the newest 25 real session artifacts from the live store (no writes),
  reports frame/event/retry counts and any format-invariant problems;
- boots the mock on an ephemeral port, checks `500` / `429 + Retry-After: 7` /
  `200` SSE (`MOCK_OK` + `[DONE]`) and the request log.

Expected output ends with `RESULT: PASS`.

---

## 8. Troubleshooting

- **`no session artifact found`** — the chat has not flushed yet, or the wrong
  window. Use `list`, then `--since-minutes N`; the log is created on first append.
- **`torn final frame`** — the turn is still writing. Re-run `assert` after
  `turn/end` (watch mode waits for this).
- **`mock log: not provided`** — `assert` without `--mock URL`; HTTP statuses and
  gaps are unavailable but every session-derived check still runs.
- **`llm/retry=0` and `turn/end.kind="error"` instantly** — the failure code was
  not retryable (`AUTH`, `INVALID_REQUEST`, `QUOTA_EXCEEDED`…) or
  `unconfigured: off` matched. Check the event's `failure.code` in `parse`.
- **`policyKey` differs between what you configured and what you see** — the key
  encodes the whole resolved policy; changing any field starts a new chain (and
  resets the per-step counter), which is expected.
- **Failures of type `TRANSPORT`** rather than `SERVER` — the mock process died
  mid-request; restart it and re-apply the scenario plan.
- **A 429 schedules the local delay, not 7000 ms** — expected on the pi-ai route;
  see scenario 8.
