# Host retry pipeline — where `retryPolicy` is resolved, and how a plugin can own per-model retry

Task-1 (host half), read-only research. Evidence = built ESM read directly out of the shipped bundles.
`<asar>` = `%USERPROFILE%\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh`; all paths below are relative to `<asar>/node_modules/@deepseek-ai/`.
Method: `read` tool with explicit asar paths; whole-asar byte-accurate grep (node script over `app.asar`, 18309 entries, line numbers by byte offset); `cordis_inspect_query` (host `Event`/`Service`/`Config`) for live contracts. Line numbers were cross-checked with the `read` tool.

**Verdict up front:** spec-update (fixed / linear+cap cooldown) makes **design A the only viable path**. The built-in policy cannot express it (`localDelay` is strictly exponential+jitter and `resolveRetryPolicy` rejects unknown keys), and the policy is provider-granular by construction. Design A is feasible with public extension points only. The failed call's **model is not in the `agent/request-error` payload**, but it is recoverable from the `agent/request` waterfall (public, per attempt) and from `Session.requestContext()`. Emitting the released `llm/retry` + `llm/retry-started` events preserves the existing chat retry UI.

---

## Findings

### Q1. Where `agent/request-error` is emitted, and which `retryPolicy` value it carries

`dsh-agent-loop/lib/index.js`:

- `step()` is a **retry loop**: `firstAttempt = true; while (true) { const {config, preparedCall} = await this.prepareRequest(turn, step, signal); … }` (1043–1052). Every attempt re-derives config and re-binds the adapter.
- Request dispatch: `buildRequest(...)` (1075, body 1214–1288) → `preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)` (1084) → `for await` (1088–1092).
- Failure path (1128–1146): after settling `assistant/attempt`, it dispatches
  ```js
  const action = await this.dispatch.waterfall("agent/request-error", {
    turn, step,
    provider: request.provider,          // 1139
    failure: finish.failure,             // 1140
    retryPolicy: preparedCall?.retryPolicy,  // 1141
    signal
  }, () => Promise.resolve(void 0));      // 1143 default = terminal
  signal.throwIfAborted();                 // 1144
  if (action?.kind !== "retry") throw new LlmError(finish.failure.message, finish.failure.code, finish.failure); // 1145
  continue;                                // 1146
  ```
  So the payload's `retryPolicy` is **`PreparedLlmCall.retryPolicy`** — not re-read from `llm.providerRetryPolicy(provider)`. It is **not memoized per step**: `prepareRequest`→`llm.prepareCall` runs again on every attempt (1052, 1175–1212), so a policy change (re-registered adapter) is visible from the next attempt onward.
- Default is terminal: `next()` resolves `undefined` (1143) → `action?.kind !== "retry"` → `throw LlmError` (1145) → `turn()` records `turn/end {kind:'error'}` (1019–1032).

### Q2. `dsh-llm`: how the adapter policy is captured, and what "normal" defaults to

`dsh-llm/lib/index.js`:

- `registerAdapter(providers, adapter)` → `prepareRoutes` captures **per provider at registration time**:
  ```js
  const retryPolicy = adapter.providerRetryPolicy(provider)
    ?? resolveRetryPolicy(void 0, `llm: provider "${provider}" retryPolicy`);  // 1876
  registrations.push({ adapter, provider: {...}, retryPolicy });              // 1877–1884
  ```
  `commitRoutes` stores one registration per route (1895–1902); `handle.replace(next)` re-runs `prepareRoutes` for the new route list (1856–1859) → **the policy is re-queried on every (re-)registration**.
- `providerRetryPolicy(provider) { return this.registration(provider).retryPolicy; }` (2041–2042) reads the **frozen** registration value.
- `prepareCall(...)` returns `retryPolicy: registration.retryPolicy` (2243) — the same frozen value; `LlmAdapter.providerRetryPolicy` base returns `undefined` (1687), so an adapter that declares nothing gets the default.
- Defaults/validation: `DEFAULT_MAX_RETRIES = 5`, `DEFAULT_INITIAL_DELAY_MS = 500`, `DEFAULT_MAX_DELAY_MS = 1e4`, `DEFAULT_JITTER_RATIO = .1`, `DEFAULT_RETRYABLE_CODES = [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]` (247–257); `resolveRetryPolicy` (316–347) freezes `{mode, maxRetries, retryableCodes, backoff}` and **throws on any unknown key** (`validateKeys`, 275–294; also inside `backoff`, 295–308).

**Answer:** captured at registration, not re-read per call; "normal" is defaulted by `resolveRetryPolicy(undefined)`; it changes live only through `AdapterRegistrationHandle.replace` (or re-register).

### Q3. Does `dsh-llm-pi-ai` re-register when its settings change (retryPolicy edit live, no restart)?

Yes. Full chain in `dsh-llm-pi-ai/lib/index.js`:

- `Config = z.object({ providers: z.dict(profile).default({}).volatile() })` (1082–1083); each profile resolves `retryPolicy: resolveRetryPolicy(retryPolicy, …)` (1176) from `RetryPolicySchema` (1080).
- The adapter answers `providerRetryPolicy(provider) { return this.current().profiles.get(provider)?.retryPolicy; }` (1885) — i.e. it reads the **current** profiles snapshot.
- `apply` memoizes `profiles()` by the raw config identity: `const raw = config.providers.get()` (2876–2883).
- `registrationFacts(profiles)` explicitly includes the policy: `{provider, displayName, retryPolicy: profile.retryPolicy}` sorted by provider (2823–2829; comment "The registry captures these per route; a change here must re-register").
- `ensureRegistrationFacts()`: if facts differ → first `ctx.llm.registerAdapter(routes, adapter)` else `registration.replace(routes)` (2941–2956); called on `loader/volatile-update` (2957–2965).
- Settings writes: `configEditor.edit` → loader entry update. `cordis-plugin-loader/src/config/entry.ts` detects a **volatile-only** config change (`equalExceptVolatile`, 141–149), and `_commitVolatile()` validates via `resolveConfig(...)` then `updateVolatile(ref, source)` + emits `loader/volatile-update` (164–197). `resolveConfig` = validate against `runtime.Config` and return the validated value (`cordis/src/fiber.ts:50–62`).

**Answer:** editing `providers.<route>.retryPolicy` is a volatile-only change → `llm-pi-ai` re-registers/replaces routes → new `retryPolicy` is captured → takes effect **without restart** (and `llm/adapters-updated` is emitted, 1902).

### Q4. Can a plugin know the failing call's **model** inside `agent/request-error`?

No, not from that payload — it is `{agent, turn, step, provider, failure, retryPolicy, signal}` (Event catalog `host/Event` for `agent/request-error`; emitted at agent-loop 1136–1143). `provider` only. Correlating public options:

1. **`agent/request` waterfall — primary.** Signature: `'agent/request'(this: Scoped<Agent>, payload: {agent, turn, step, signal}, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>`. It is dispatched **on every attempt** inside `prepareRequest` (agent-loop 1191–1195) and its result contains `{provider, model, reasoningEffort?, temperature?, maxTokens?, stop?}`. A listener may `const cfg = await next()` and record `key(agent.id, turn, step) → cfg` before returning it unchanged. Each retry re-dispatches with the same `turn/step`, so the cache always holds the **latest attempt's** model — exactly the failing call.
2. **Durable log.** `buildRequest` logs `request/header` (`EpochHeader.config`, 1217–1240) and `request/context` (`{provider, model, contextWindow?, systemPromptUpdate?}`, 1264–1271) **before** the stream starts; `Session.requestContext()` / `Session.requestHeader()` are public (see `sessions` service type catalog; Session declaration). Fallback: `ctx.sessions.get(agent.id)?.requestContext()`.
3. **`llm/stream` waterfall** receives `GenerateOptions {provider, model, sessionId, purpose?}` (Event catalog) — usable but broader than needed (also sees compaction/session-title direct calls).
4. **No projection records the model per step.** `request/context` is the durable record; `assistant/message.source {provider, model}` exists only for successful steps (agent-loop 1148–1154), failures only get `assistant/attempt {turn, step, stream}` (1113–1135) with no route.
5. **Compaction / session-title calls never enter this waterfall** (they use `ctx.llm.stream()` directly with `purpose`; `dsh-llm-retry/README.md:32` states direct stream consumers stay single-attempt). So there is no cross-talk to disambiguate — but our loop-level retry will not cover them (same limitation as built-in).

### Q5. Candidate designs

- **A — own the retry loop, disable built-in `llm-retry`.** **FEASIBLE, recommended.** Disable the loader row (Q8), listen `agent/request-error`, resolve model via `agent/request` cache (Q4), emit the released `llm/retry`/`llm/retry-started` events (Q9), append through `ctx.sessions.get(agent.id)` (Q10). Fixed/linear/capped delay is free-form because we own the timer. Only public extension points are needed.
- **B — keep `llm-retry`, rewrite llm-pi-ai `retryPolicy` settings.** Rejected for two independent reasons: (i) **per-provider only** — `resolveProfiles` resolves exactly one `retryPolicy` per provider profile (llm-pi-ai 1176) and the registry captures one policy per registered route (dsh-llm 1876–1884); there is no per-model slot in `LlmAdapter`/`ResolvedRetryPolicy`; (ii) **cannot express the cooldowns anyway** — backoff is `min(initialDelayMs * 2^(retry-1), maxDelayMs) * jitter` (`dsh-llm-retry/lib/index.js:44–49`) over `{initialDelayMs, maxDelayMs, jitterRatio}` only, and `resolveRetryPolicy` rejects extra keys (dsh-llm 275–294). It would also mean mutating another package's settings document.
- **C — synthetic provider per model.** **Reject.** A second adapter over the same routes trips `DUPLICATE_ADAPTER` (dsh-llm 1872); it would have to re-host all models with duplicated credentials/baseURL/catalog, the composer/session selection would see providers per model (aggravating `provider+model` identity, `model/selection` event), and every provider edit would churn adapter re-registration. No user-visible benefit over A.
- **D — better official hook.** None found: `prepareCall(config, signal, configure)` cannot touch `retryPolicy` (registration-bound, 2243) and `configure` only selects `LlmCallControls`; `llm/stream` wrapping cannot durably retry already-emitted chunks (llm-retry README: "a raw stream cannot separate already-emitted chunks durably"); `registerAdapter` handles are owner-private. The loop-level `agent/request-error` seam is the intended one; A is design D.

### Q6. How the loop chooses provider/model per step; what records it

- `prepareRequest` (agent-loop 1175–1212): route comes from `AgentOptions` (`provider: this.options.provider ?? ""`, `model: this.options.model ?? ""`, 1180–1181); the seed config comes from the persisted request header when one is logged (`requestProposal(persistedHeader)`), else from that route (1186–1190); the `agent/request` waterfall may replace it (1191–1195); `llm.prepareCall` materializes adapter defaults (1201–1202).
- Durable recording: `request/header` (`EpochHeader {config, adapterDefaults?, tools?}`, reason initial/resume/change/series) at 1217–1240; `request/context` (`RequestContext {provider, model, contextWindow?, systemPromptUpdate?}`) at 1264–1271 — appended whenever provider/model/context window changes, **before** dispatch.
- Public readers: `Session.requestHeader()` and `Session.requestContext()` (both declared on Session; `sessions` service `get(id)` returns the live Session).
- **Name exactly:** the per-step durable route record is the `request/context` session event (payload `RequestContext`); there is no session projection for it. For a **failing** attempt, `request/context` already reflects the attempt's route because it is logged in `buildRequest` before the stream.
- Consequence for A: primary correlation = `agent/request` cache keyed by `(agent.id, turn, step)` (refreshed for each attempt); fallback = `ctx.sessions.get(agent.id)?.requestContext()`. Both are reliable for loop calls and unaffected by compaction/session-title calls, which never trigger `agent/request-error`.

### Q7. schemastery and unknown properties on model entries

`schemastery/src/index.ts` (shipped source, so authoritative):

- `object` resolver builds declared keys, then `if (!strict) merge(result, data)` where `merge` copies **unknown keys from input** (805–823). `dict` similarly copies every present key (779–795). `Schema.resolve` defaults `strict = false` (515–554) and the standard-schema entry calls `Schema.resolve(value, this, {})` (~297); `resolveConfig` returns that validated value verbatim (`cordis/src/fiber.ts:50–62`).
- **Therefore schemastery PRESERVES unknown extra properties** (does not throw, does not strip) for ordinary object/dict config. `dsh-llm`'s `resolveRetryPolicy` is the exception that *does* reject unknown keys — by its own `validateKeys`, not schemastery.
- Corollaries: a custom field can be parked as a **sibling** of `retryPolicy` on an llm-pi-ai model entry / provider profile and it survives config validation (`llm-pi-ai` reads only known fields via `resolveRouteModels`/`resolveEntry`, 585–699, and never rejects extras). But it **must not** go inside `retryPolicy` (rejected at dsh-llm 275–294, 325).

### Q8. Disabling `llm-retry` via the Loader patch — consequences

- Row identity: `dsh-base/cordis.patch.yml:96–100` — `- id: llm-retry` / `name: '@deepseek-ai/dsh-llm-retry'` (no config). A higher patch layer can target it: `{ id: llm-retry, name: '@deepseek-ai/dsh-llm-retry', disabled: true }` (Loader dialect: an `id`-only patch replaces row fields; a truthy `name` asserts the existing plugin name). Disabling removes its `ctx.on("agent/request-error")` listener (`dsh-llm-retry/lib/index.js:175–178`), its `llmRetry` projection registration (82–107) and its effect-scoped lifetime (179–183).
- **With no listener:** the waterfall default `() => Promise.resolve(void 0)` (agent-loop 1143) → `action?.kind !== 'retry'` → `throw LlmError` (1145) → step error → `turn/end {kind:'error'}` (1019–1032). Terminal, no retry. Note the other two registered listeners are independent and still run for their own codes: `dsh-compaction-basic/lib/index.js:861–887` (`CONTEXT_WINDOW_EXCEEDED_CODE`, mutates then returns `{kind:'retry'}`) and `dsh-compaction-image-offload/lib/index.js:141` (`IMAGE_OFFLOAD_REQUIRED`). Our listener must delegate those codes (default retryable set already excludes them).
- **`llmRetry` projection:** registered host-only (no `wire`; `dsh-llm-retry/lib/index.js:88–107`) and **read only by llm-retry itself** (`stateOf(agent.session, "llmRetry")`, 162). Whole-asar grep: zero `llmRetry` hits in `dsh-client-*` or `dsh-api-session-controller`; no UI depends on that projection.
- **UI retry affordance is event-driven, not projection-driven:** `dsh-client-ui-chat/lib/client.js:10021–10107` builds the `model-retry` chat node from `llm/retry` (`scheduledNode`, 10022–10031; `retry===1` starts a chain, 10040–10048) and `llm/retry-started` (10049–10056, 10075–10083; `retryState` scheduled→started→cancelled). Both types are in `KNOWN_SESSION_EVENT_TYPES` (`dsh-api-session-controller/lib/client.js:137–199`, lines 162–163) and `dsh-session/lib/index.js:104–105`. Disabling `llm-retry` removes nothing visible **as long as our plugin emits those two event types with `retryId`/`retry`/`turn`/`step`/`delayMs`.**

### Q9. Minimal equivalent surface (what our listener must implement)

Released payload contract (`dsh-session-reference/lib/typert.host.js:412–413`, `LlmRetryEventData`; `llm/retry` and `llm/retry-started` are members of `SessionEventMap`, same file 565):

```ts
export type LlmRetryEventData =
  | { retryId: RetryId; turn: number; step: number; provider: string; mode: 'normal'; policyKey: string; retry: number; maxRetries: number; delayMs: number; failure: LlmFailure }
  | { retryId: RetryId; turn: number; step: number; provider: string; mode: 'always'; policyKey: string; retry: number; delayMs: number; failure: LlmFailure };
export interface LlmRetryStartedEventData { retryId: RetryId; turn: number; step: number; retry: number }
```

Reference implementation (`dsh-llm-retry/lib/index.js:116–150`): build data (`maxRetries` only for normal mode) → `agent.session.append("llm/retry", data)` **before** the wait (141) → cancellable delay (142) → `agent.session.append("llm/retry-started", {retryId, turn, step, retry})` (143–148) → `return {kind:"retry"}` (149). Abort ⇒ return without appending `-started` and without retry (142, 68–81).

Format invariants (validated by the shipped format migrations — `dsh-session-format-v3-to-v4/lib/index.js:676–699`, and `dsh-session-format-v0-to-v1/lib/index.js:2407–2424, 2504–2513`):
- `llm/retry` must match the **current open** turn/step (`data.step === this.step ?? nextStep-1`);
- `data.provider` must equal the **open request/header's provider** (use the payload's `provider` verbatim);
- `retry` must start at **1** per `(turn, step, provider, policyKey)` chain and increment by 1;
- `retryId` must stay stable within a chain and unique across chains;
- `llm/retry-started` must pair a prior scheduled attempt with the same `turn/step/retry`.

Runtime `Session.append` itself validates only JSON-serializability plus a few event-local rules ("This does not validate complete event payloads", `dsh-session/lib/index.js:235–277, 1517–1538`), so extra fields are not rejected *today* — but the released disposition (`v0-to-v1/lib/index.js:101–117`) enumerates exactly `[retryId, turn, step, provider, mode, policyKey, retry, delayMs, failure]` + optional `maxRetries`, so **keep the payload to the released shape**; put plugin-only data in our own projection/state, not in `llm/retry`.

Counting "per step, not per turn" is exactly what the loop gives us: `agent/request-error` fires inside `step()`'s `while(true)` (agent-loop 1043–1052, 1128–1146), and step boundaries are `step/start`/`step/end` (970–997). Mirror llm-retry's host-only projection pattern: `sessionProjections.register({key, stateSchema, init, apply, stateVersion})` with **no `wire`** (allowed: service contract distinguishes host-only registration), reset on `step/start`/`turn/end`, count on our retry event (reference: llm-retry 88–107, 94).

### Q10. Can a third-party plugin append session events?

Yes, through public API:

- `Session.append<T extends SessionEventType>(type, data, ...)` is declared public on the Session class (session/service type catalog; implementation `dsh-session/lib/index.js:1517–1538`). `llm/retry`/`llm/retry-started` are released `SessionEventType`s (`SessionEventMap`, `dsh-session-reference/lib/typert.host.js:565`), so this is a supported use, not a custom event. Non-surface events must not carry `surfaceOp`/`sourceEventSeqs` (`surfaceOpOf`, `dsh-session/lib/index.js:297–312`) — nothing for us to do.
- How to get the Session: **`ctx.sessions.get(id): Session | undefined`** (`sessions` Service catalog) — inject `["sessions"]` and use `agent.id`. Alternatives: the `session/created` event (`(scoped Session, session: Session)`) to build a map; or the runtime agent object in the payload, which does carry `.session` (`ReactLoopAgent` fields at agent-loop 747–757; `dsh-llm-retry` and `dsh-compaction-basic` rely on it) — but the public `Agent` type declares only `id`, so prefer `ctx.sessions.get`.
- `appendPluginRecord(session, type, data)` exists (dsh-session 1271–1297) but its contract says only production source under `packages/experimental/` may call it; **do not use it**. Reusing the released `llm/retry` types is both sanctioned and UI-visible.

### Q11. "Infinite retries" safely

- Cancellation inputs: `payload.signal` is the turn abort signal; `cancel(cause)` aborts `phase.abort` (`dsh-agent-loop/lib/index.js:815–820`), and agent disposal aborts with "agent lifecycle disposed" (1700–1706). The loop re-checks `signal.throwIfAborted()` immediately after the waterfall returns (1144), so a retry decided after abort cannot spin.
- Plugin dispose: register the listener via `ctx.on(...)` (disposer) and a fiber-lifetime `AbortController` via `ctx.effect`; fuse with `AbortSignal.any([payload.signal, lifetime.signal])`; make the wait resolve `false` on abort; drain in-flight waits on dispose. Reference exactly `dsh-llm-retry/lib/index.js:68–81, 109–115, 116–149, 175–183` (`track`/`active` set + `lifetime.abort` + `Promise.allSettled`).
- Unlimited mode: use the released `mode:'always'` variant (no `maxRetries`) to match the built-in semantics/format, but keep our **own** retryable-code filter (default transient codes) so "0 = unlimited" does not loop on permanent auth/quota/protocol errors forever (built-in always mode does retry those — README limitation; we can be stricter and document it). Cancellation and disposal still terminate it.

---

## Recommended design (A) — exact extension-point sequence

1. **Composition (host half).** Ship `cordis.patch.yml` in the plugin bundle:
   ```yaml
   - id: llm-retry
     name: '@deepseek-ai/dsh-llm-retry'
     disabled: true
   - insert:
       - id: llm-model-retry          # this id is also the settings namespace
         name: dsh-llm-model-retry
         config: {}
   ```
   (Loader dialect: id-targeted patch replaces fields; `insert` appends at this layer, i.e. after `dsh-base` rows, after compaction listeners → compaction/image-offload get first refusal on their codes. Verify the row is actually disabled with `plugin_manager list_plugins` / `fiberPhase`.)
2. **Settings surface.** `export const Config = z.object({ models: z.dict(modelRetry).default({}).volatile() })` and `export function apply(ctx, config)` — same shape as `dsh-llm-pi-ai/lib/index.js:1082–1083` + `2860–2866`. Requirements: the plugin must be a Loader entry (its `id` is the settings namespace) and `Config` must expose ≥1 volatile field, otherwise `settings.describe()` skips it (`dsh-settings/lib/index.js:118–131` `volatileForm`, 413–419; writes reject non-volatile paths, 153–157, 501–507). Key by `"<provider>/<modelId>"` (model ids repeat across routes). Reads: `config.models.get()` (volatile accessor — the llm-pi-ai pattern at 2877), **not** `ctx.settings.get(...)`: this build's `settings` Service contract has no `get`, there is no `settings/updated` event, and the installed `dsh-reasoning-effort@0.2.8` read path (`ctx.settings.get` + `settings/updated`) appears written for a different API generation — do not copy it (its writes are still valid).
3. **Model correlation.** `ctx.on("agent/request", async (payload, next) => { const cfg = await next(); cache.set(key(agent.id, turn, step), {provider: cfg.provider, model: cfg.model}); return cfg; })` — observe only, return unchanged. Fallback at failure time: `ctx.sessions.get(agent.id)?.requestContext()`.
4. **Retry decision + wait.** `ctx.on("agent/request-error", async ({agent, turn, step, provider, failure, signal}, next) => {…})`:
   - delegate (`return next()`) unless `failure.code` is one of our retryable codes **and** a policy exists for `<provider>/<model>` (or a plugin-wide default) **and** `attempts < retries` (or `retries === 0` ⇒ unlimited);
   - resolve `retry = previousAttempts + 1` from our own host-only projection (per `turn/step`, reset on `step/start`; mirrors llm-retry 88–107);
   - delay: `fixed → baseDelayMs`; `linear → min(baseDelayMs + (retry-1) * incrementMs, maxDelayMs)`; optionally honor `failure.providerRetryAfterMs` inside the configured cap;
   - `policyKey = JSON.stringify({model, strategy, baseDelayMs, incrementMs, maxDelayMs, codes})` (stable per step so the format chain rule holds);
   - append `llm/retry` via `ctx.sessions.get(agent.id)?.append(...)` **before** waiting, then wait on a cancellable timer fused with the lifetime signal, then append `llm/retry-started`, `return {kind:"retry"}`;
   - code filter defaults to `[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]` (never `CONTEXT_WINDOW_EXCEEDED`/`IMAGE_OFFLOAD_REQUIRED`; always `next()` for codes/layers we do not own, so compaction listeners win).
5. **Teardown.** `ctx.effect(() => async () => { disposeListener(); lifetime.abort(...); await Promise.allSettled([...active]); })`; also respect `signal.aborted` before each append and before returning `{kind:'retry'}`.
6. **UI (with task-2).** Keep the `llm/retry` payload released-shape so the stock `model-retry` card keeps rendering; the per-model settings UI should live in our own section (`settings.section`, own namespace), since the stock Models page has no model-level slot and would drop parked fields (see below).

### Per-model settings storage decision

- **Recommended: own namespace** (step 2). Upgrade-safe, validated by our own Config, writable by our own settings page through `settings.mutate` path ops, no dependency on another package's schema. Same conclusion as `docs/research/client-model-ui.md` §9.
- **Not recommended as source of truth: park fields in llm-pi-ai model entries.** It *is* accepted (schemastery preserves unknown keys, Q7; llm-pi-ai ignores them; volatile so no remount), **but** the Models page sends writes as path ops whose `after` draft comes from the **schema-projected** form (`projectForm` projects only declared fields, `dsh-settings/lib/index.js:141–147, 436`), and editing models replaces the whole `models` array (`dsh-client-ui-settings-models/lib/client.js:2039` + `pathOps` 1822–1841) — so unknown per-model fields are dropped on the next Models-page save. Couples us to another package's document. Avoid.

---

## Open risks

1. **UI node shape is load-bearing:** the chat retry card requires a non-empty string `retryId`, numeric `retry`/`turn`/`step`/`delayMs`, and starts the chain only at `retry === 1` (client-ui-chat 10040–10057). Any deviation breaks rendering; extra fields are spread but ignored.
2. **Format migration:** current `SESSION_FORMAT_VERSION = 4` (`dsh-session/lib/index.js:56`); the v3→v4 validator enforces the retry invariants above, and a future v4→v5 disposition will enumerate released members — keep `llm/retry` strictly released-shape (no extra fields); store extras in our own projection.
3. **Correlation staleness:** `agent/request` is dispatched per attempt so the cache refreshes, but its listener runs inside step admission — if another listener returns a different config after ours, our cache still sees the final value because we cache the `next()` result (we are downstream of earlier listeners only). Register our listener late (bundle-layer insert = after base) to see the final config.
4. **Compaction/session-title calls are not retried** by this seam (direct `llm.stream`; same limitation as built-in). Document as a non-goal.
5. **Unlimited retries cost/cancellation:** each retry is a billed provider request; keep code filtering, honor abort/dispose, and consider a max-wall-clock guard. Always-mode-by-default would be dangerous on permanent auth errors.
6. **Disabling `llm-retry` is global:** every provider loses the built-in exponential policy, including sessions whose model has no custom entry — our plugin must define a sensible default (e.g., inherit the old defaults: 5 retries, exponential not expressible ⇒ default fixed/linear values or "no retry" if the user set nothing; decide and document). Also check no other bundle re-enables the row/inserts a duplicate listener.
7. **Two responders must not both answer `agent/request-error`:** if `llm-retry` cannot be disabled (patch layer loses), our listener must be mounted **before** it or it will never see retryable failures (waterfall first-responder wins). Verify composition order.
8. **`ctx.settings.get`/`settings/updated` do not exist in this build** (whole-asar grep: no callers, no event in the Event catalog). The installed `dsh-reasoning-effort@0.2.8` read path is stale for this build; build reads on `config.<volatile>.get()`.
9. **`agent.session` is de facto but not typed:** public `Agent` is `{id}` only; use `ctx.sessions.get(agent.id)` for the Session (and `session/created` as a fallback cache).

## Evidence index (key files)

- `dsh-agent-loop/lib/index.js` — 747–789 runtime Agent, 815–820 cancel, 970–997 step boundaries, 1043–1172 `step()` incl. 1084 stream, 1136–1146 `agent/request-error`, 1175–1212 `prepareRequest`, 1214–1288 `buildRequest` (1217–1240 header, 1264–1271 context), 1700–1706 disposal abort.
- `dsh-llm/lib/index.js` — 232–347 retry schema/defaults/validation, 1842–1902 adapter registration & retry capture, 2041–2042 frozen policy lookup, 2220–2261 `prepareCall` (2243).
- `dsh-llm-pi-ai/lib/index.js` — 1035–1083 model/profile/Config, 1117–1186 resolve (1176 policy), 585–699 model resolution, 1885 adapter policy, 2801–2829 registration facts, 2860–2966 settings→registration path.
- `dsh-llm-retry/lib/index.js` — 21–30 plugin shape, 44–49 exponential delay, 50–67 policy/state keys, 82–107 projection, 116–183 event append/wait/recover/dispose; `README.md` for documented limitations.
- `dsh-session/lib/index.js` — 235–277 event-data validation scope, 104–105 known types, 1250–1297 plugin records (experimental-only), 1517–1538 append; `dsh-session-reference/lib/typert.host.js:412–413, 565` released retry payloads.
- `dsh-session-format-v3-to-v4/lib/index.js:676–699` (+ README 242) and `dsh-session-format-v0-to-v1/lib/index.js:101–117, 2407–2424, 2504–2513` retry format invariants.
- `dsh-client-ui-chat/lib/client.js:10021–10107` retry chat node; `dsh-api-session-controller/lib/client.js:137–199` known event types.
- `dsh-client-ui-settings-models/lib/client.js` — 1505–1535 (NS + create card), 1790–1839 `pathOps`, 1890–1941 apply/write, 2039 models array set.
- `dsh-base/cordis.patch.yml:96–100` llm-retry row, `351–353` compaction-basic, `434–436` image-offload.
- `dsh-compaction-basic/lib/index.js:861–887`; `dsh-compaction-image-offload/lib/index.js:141` — other `agent/request-error` listeners.
- `dsh-settings/lib/index.js` — 118–131 `volatileForm`, 141–147 `projectForm`, 153–157 `isVolatilePath`, 413–464 `describe`, 488–507 `mutate`/`write`.
- `schemastery/src/index.ts` — 480–509 volatile rules, 515–554 `resolve`, 779–823 object/dict merge (unknown-key preservation).
- `cordis/src/fiber.ts:50–62` `resolveConfig`; `cordis-plugin-loader/src/config/entry.ts:141–197` volatile-only commit + `loader/volatile-update`.
- Live: `host/Service` (`llm`, `sessions`, `sessionProjections`, `settings`, `agents`), `host/Event` (`agent/request`, `agent/request-error`, `llm/stream`, catalog), `host/Config` (`include:llm-pi-ai`).
- Profile: `%DSH_HOME%\profiles\desktop\cordis.patch.yml` — models are hand-declared under `providers.<route>.models[]`; that array is the "add a model" target (see `docs/research/client-model-ui.md`).
