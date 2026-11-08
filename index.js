/**
 * dsh-model-retry — per-model failure retry policy for DeepSeek Harness.
 *
 * The stock `@deepseek-ai/dsh-llm-retry` executor is disabled by this bundle's
 * patch (`cordis.patch.yml`) and re-implemented here, because the stock policy
 * can only express exponential backoff with jitter, per provider:
 *
 *   stock: delay = min(initialDelayMs * 2^(retry-1), maxDelayMs) * jitter
 *
 * This plugin adds, per model:
 *   - `retries`: 0 means UNLIMITED retries (stock would read 0 as "never retry"),
 *   - `delayMode`: 'fixed' (same wait every time) or 'increment' (each wait adds
 *     `incrementSeconds` to the previous one).
 *
 * Retry counting is per STEP: the counter is keyed by `(session, turn, step)`, so
 * a new step starts again at 1. That mirrors the stock projector, which resets on
 * `step/start` / `turn/end`.
 *
 * The emitted `llm/retry` / `llm/retry-started` payloads are byte-compatible with
 * the stock executor, so the chat retry card and the session log format are
 * unchanged.
 */
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'

/**
 * Whether one request was assembled by the agent loop.
 *
 * Agent-loop requests already recover through `agent/request-error`, so the
 * direct-call retry below must leave them alone. The authoritative marker is
 * a process-local WeakSet in `@deepseek-ai/dsh-llm`; the heuristic fallback
 * keeps the rest of the plugin working if that module ever fails to resolve.
 */
let isAgentLoopRequest = (request) =>
  request !== null &&
  typeof request === 'object' &&
  request.sessionId !== undefined &&
  request.purpose === undefined
try {
  const llm = await import('@deepseek-ai/dsh-llm')
  if (typeof llm.isAgentLoopRequest === 'function') isAgentLoopRequest = llm.isAgentLoopRequest
} catch {
  // Keep the heuristic: a missing marker must not disable per-step retry.
}

const DEFAULT_RETRYABLE_CODES = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
])

/** setTimeout accepts a 32-bit signed delay in Node. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1
const DEFAULT_MAX_DELAY_SECONDS = 120

/* ------------------------------------------------------------------ schema */

/**
 * One model's policy shape.
 *
 * A fresh instance is returned per use: `volatile()` may only sit at a fixed
 * object path, and schemastery rejects a volatile node in a dict's blocked
 * inner position (`validateVolatileSchema`), so `defaults` and the `models`
 * entries must not share one schema instance.
 */
function modelPolicySchema() {
  return z.object({
    retries: z
      .number()
      .step(1)
      .min(0)
      .default(5)
      .description('重试次数上限；0 表示无限重试（按步计数，每步重新开始）。'),
    delayMode: z
      .union([z.const('fixed'), z.const('increment')])
      .default('fixed')
      .description('fixed：每次间隔相同；increment：每次在上次间隔上再加 incrementSeconds。'),
    delaySeconds: z
      .number()
      .min(0)
      .default(2)
      .description('固定间隔秒数，或递增模式的首次间隔秒数。'),
    incrementSeconds: z
      .number()
      .min(0)
      .default(2)
      .description('递增模式下每次额外增加的秒数。'),
    maxDelaySeconds: z
      .number()
      .min(0)
      .default(DEFAULT_MAX_DELAY_SECONDS)
      .description('单次冷却上限秒数；0 表示不封顶。'),
    retryableCodes: z
      .array(z.string())
      .default([...DEFAULT_RETRYABLE_CODES])
      .description('允许重试的错误码；默认覆盖服务端错误、限流、超时与传输失败。'),
  })
}

export const Config = z.object({
  unconfigured: z
    .union([z.const('inherit'), z.const('off')])
    .default('inherit')
    .description(
      '未单独配置的模型如何处理：inherit 沿用该 provider 的 retryPolicy（DSH 原生行为）；off 表示不重试。',
    )
    .volatile(),
  defaults: modelPolicySchema()
    .description('新增模型时预填的模板值；已配置的模型以自身条目为准。')
    .volatile(),
  /** Volatile: editable from the settings surface without remounting the plugin. */
  models: z
    .dict(modelPolicySchema())
    .description(
      '按 `provider/model` 覆盖的策略，例如 `yundu/gpt-6-astra`。同时作用于 agent loop 的每步重试与自动审查等直接模型调用。',
    )
    .volatile(),
})

/* ----------------------------------------------------------------- helpers */

/** Unwrap a schemastery `volatile()` field, tolerating a plain value. */
function unwrap(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

function toNumber(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : fallback
}

function toSeconds(value, fallback) {
  return Math.max(0, toNumber(value, fallback))
}

function normalizePolicy(source, base) {
  const merged = {
    ...base,
    ...(source !== null && typeof source === 'object' ? source : {}),
  }
  const codes = merged.retryableCodes
  return {
    retries: Math.max(0, Math.trunc(toNumber(merged.retries, 0))),
    delayMode: merged.delayMode === 'increment' ? 'increment' : 'fixed',
    delaySeconds: toSeconds(merged.delaySeconds, 2),
    incrementSeconds: toSeconds(merged.incrementSeconds, 2),
    maxDelaySeconds: toSeconds(merged.maxDelaySeconds, DEFAULT_MAX_DELAY_SECONDS),
    retryableCodes:
      Array.isArray(codes) && codes.length > 0
        ? codes.filter((code) => typeof code === 'string' && code.length > 0)
        : [...DEFAULT_RETRYABLE_CODES],
  }
}

/** Stable identity of one model policy; a change resets the per-step counter. */
function modelPolicyKey(policy) {
  return JSON.stringify([
    policy.retries,
    policy.delayMode,
    policy.delaySeconds,
    policy.incrementSeconds,
    policy.maxDelaySeconds,
    [...policy.retryableCodes].sort(),
  ])
}

/** Stock `@deepseek-ai/dsh-llm-retry` policy identity (kept identical). */
function stockPolicyKey(policy) {
  return policy.mode === 'always'
    ? JSON.stringify([
        policy.mode,
        policy.initialDelayMs,
        policy.maxDelayMs,
        policy.jitterRatio,
      ])
    : JSON.stringify([
        policy.mode,
        policy.maxRetries,
        [...policy.retryableCodes].sort(),
        policy.initialDelayMs,
        policy.maxDelayMs,
        policy.jitterRatio,
      ])
}

/** Stock exponential + jitter backoff, reproduced verbatim. */
function stockLocalDelay(policy, retry) {
  const exponent = Math.min(retry - 1, 1024)
  const exponential = Math.min(policy.initialDelayMs * 2 ** exponent, policy.maxDelayMs)
  const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * Math.random()
  return Math.min(exponential * jitter, policy.maxDelayMs)
}

/** Cooldown for a direct (non agent-loop) call using the provider's stock policy. */
function stockStreamDelay(policy, retry, failure) {
  const after = failure === undefined ? undefined : failure.providerRetryAfterMs
  if (Number.isFinite(after) && after > 0 && after <= policy.maxDelayMs) return after
  return stockLocalDelay(policy, retry)
}

/**
 * Per-model cooldown.
 *
 * fixed:     delay = delaySeconds
 * increment: delay = delaySeconds + (retry - 1) * incrementSeconds
 *
 * A server-supplied `Retry-After` wins when it fits under the cap. `retry` is
 * 1-based, so the first retry waits exactly `delaySeconds`.
 */
function computeModelDelay(policy, retry, failure) {
  const capMs = policy.maxDelaySeconds > 0
    ? Math.min(policy.maxDelaySeconds * 1000, MAX_TIMER_DELAY_MS)
    : MAX_TIMER_DELAY_MS
  const after = failure === undefined ? undefined : failure.providerRetryAfterMs
  if (Number.isFinite(after) && after > 0 && after <= capMs) return after

  const base = policy.delaySeconds * 1000
  const increment = policy.incrementSeconds * 1000
  const raw = policy.delayMode === 'increment' ? base + (retry - 1) * increment : base
  return Math.max(0, Math.min(raw, capMs))
}

/** Resolve after `delayMs`, or early when the signal aborts. */
function cancellableDelay(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function settleDownstream(next) {
  try {
    return { type: 'decision', decision: await next() }
  } catch (error) {
    return { type: 'error', error }
  }
}

/* ------------------------------------------------------------------ plugin */

export const name = 'model-retry'
export const inject = ['sessions', 'llm']

export function apply(ctx, config = {}) {
  const settings = config ?? {}
  const lifetime = new AbortController()
  const active = new Set()

  /** `${sessionId}` -> `{ token, provider, model }` for the current step. */
  const modelByStep = new Map()
  /** `${sessionId}` -> `{ token, policyKey, retry, retryId }`. */
  const counters = new Map()

  /* ---------------------------------------------------------- config reads */

  function modelsTable() {
    const table = unwrap(settings.models)
    return table !== null && typeof table === 'object' ? table : {}
  }

  function unconfiguredMode() {
    // `unconfigured` is a volatile field, so the live value arrives wrapped.
    return unwrap(settings.unconfigured) === 'off' ? 'off' : 'inherit'
  }

  /**
   * Resolve the effective policy for one model.
   *
   * `defaults` is a template for new entries only. Every `models` entry is
   * already schema-resolved (schemastery applies the per-field defaults), so a
   * stored entry is authoritative and is never re-based onto `defaults`.
   *
   * @returns {{ kind: 'inherit' } | { kind: 'off' } | { kind: 'model', policy: object }}
   */
  function policyFor(provider, model) {
    if (typeof model === 'string' && model.length > 0) {
      const entry = modelsTable()[`${provider}/${model}`]
      if (entry !== undefined && entry !== null) {
        return { kind: 'model', policy: normalizePolicy(entry) }
      }
    }
    return unconfiguredMode() === 'off' ? { kind: 'off' } : { kind: 'inherit' }
  }

  /* ------------------------------------------------------- model resolution */

  function sessionOf(agent) {
    if (agent === undefined || agent === null) return undefined
    const session = ctx.sessions.get(agent.id)
    if (session !== undefined) return session
    // Runtime agents expose their session directly; the published type does not.
    return agent.session
  }

  function resolveModel(agent, turn, step, provider) {
    const cached = modelByStep.get(agent.id)
    if (
      cached !== undefined &&
      cached.token === `${turn}:${step}` &&
      cached.provider === provider
    ) {
      return cached.model
    }
    const context = sessionOf(agent)?.requestContext()
    if (context !== undefined && context.provider === provider) return context.model
    return undefined
  }

  function counterFor(sessionId, token, policyKey) {
    let counter = counters.get(sessionId)
    if (counter === undefined || counter.token !== token || counter.policyKey !== policyKey) {
      counter = { token, policyKey, retry: 0, retryId: undefined }
      counters.set(sessionId, counter)
    }
    return counter
  }

  /* --------------------------------------------------------------- backoff */

  async function backoff(step) {
    const fused = AbortSignal.any([step.signal, lifetime.signal])
    if (fused.aborted) return undefined

    const session = sessionOf(step.agent)
    const data =
      step.mode === 'normal'
        ? {
            retryId: step.retryId,
            turn: step.turn,
            step: step.step,
            provider: step.provider,
            mode: step.mode,
            policyKey: step.policyKey,
            retry: step.retry,
            maxRetries: step.maxRetries,
            delayMs: step.delayMs,
            failure: step.failure,
          }
        : {
            retryId: step.retryId,
            turn: step.turn,
            step: step.step,
            provider: step.provider,
            mode: step.mode,
            policyKey: step.policyKey,
            retry: step.retry,
            delayMs: step.delayMs,
            failure: step.failure,
          }
    if (session !== undefined) session.append('llm/retry', data)

    if (!(await cancellableDelay(step.delayMs, fused))) return undefined
    if (session !== undefined) {
      session.append('llm/retry-started', {
        retryId: step.retryId,
        turn: step.turn,
        step: step.step,
        retry: step.retry,
      })
    }
    return { kind: 'retry' }
  }

  /* ------------------------------------------------- stock (inherit) path */

  /**
   * Faithful re-implementation of `@deepseek-ai/dsh-llm-retry`'s decision, used
   * for models this plugin does not configure. Keeping it identical means
   * installing the plugin changes nothing until a model is configured.
   */
  async function stockRecover(payload, next) {
    const policy = payload.retryPolicy
    if (policy === undefined) return next()

    if (policy.mode === 'always') {
      if (payload.signal.aborted || lifetime.signal.aborted) return undefined
      const fused = AbortSignal.any([payload.signal, lifetime.signal])
      const downstream = await settleDownstream(next)
      if (fused.aborted) return undefined
      if (downstream.type === 'error') {
        ctx.logger.warn(
          'model-retry: provider "%s" always policy ignored a downstream recovery failure: %o',
          payload.provider,
          downstream.error,
        )
      }
      if (downstream.type === 'decision' && downstream.decision?.kind === 'retry') {
        return downstream.decision
      }
    } else if (!policy.retryableCodes.includes(payload.failure.code)) {
      return next()
    }

    const policyKey = stockPolicyKey(policy)
    const counter = counterFor(payload.agent.id, `${payload.turn}:${payload.step}`, policyKey)
    const unlimited = policy.mode === 'always'
    if (!unlimited && counter.retry >= policy.maxRetries) return next()

    counter.retry += 1
    if (counter.retryId === undefined) counter.retryId = randomUUID()
    const retry = counter.retry

    let delayMs
    const after = payload.failure.providerRetryAfterMs
    if (Number.isFinite(after) && after > 0) {
      if (after > policy.maxDelayMs) {
        if (policy.mode === 'normal') return next()
        delayMs = stockLocalDelay(policy, retry)
      } else {
        delayMs = after
      }
    } else {
      delayMs = stockLocalDelay(policy, retry)
    }

    return backoff({
      agent: payload.agent,
      turn: payload.turn,
      step: payload.step,
      provider: payload.provider,
      failure: payload.failure,
      mode: policy.mode === 'always' ? 'always' : 'normal',
      maxRetries: policy.maxRetries,
      policyKey,
      retry,
      retryId: counter.retryId,
      delayMs,
      signal: payload.signal,
    })
  }

  /* --------------------------------------------------- per-model decision */

  async function recover(payload, next) {
    const { agent, turn, step, provider, failure, signal } = payload
    if (signal.aborted || lifetime.signal.aborted) return next()

    const model = resolveModel(agent, turn, step, provider)
    const decision = policyFor(provider, model)

    if (decision.kind === 'inherit') return stockRecover(payload, next)
    if (decision.kind === 'off') return next()

    const policy = decision.policy
    if (!policy.retryableCodes.includes(failure.code)) return next()

    const policyKey = modelPolicyKey(policy)
    const counter = counterFor(agent.id, `${turn}:${step}`, policyKey)
    const unlimited = policy.retries === 0
    if (!unlimited && counter.retry >= policy.retries) return next()

    counter.retry += 1
    if (counter.retryId === undefined) counter.retryId = randomUUID()
    const retry = counter.retry
    const delayMs = computeModelDelay(policy, retry, failure)

    if (ctx.logger.debug !== undefined) {
      ctx.logger.debug(
        'model-retry: %s/%s retry %s%s in %dms (%s)',
        provider,
        model,
        retry,
        unlimited ? '/∞' : `/${policy.retries}`,
        delayMs,
        failure.code,
      )
    }

    return backoff({
      agent,
      turn,
      step,
      provider,
      failure,
      mode: unlimited ? 'always' : 'normal',
      maxRetries: policy.retries,
      policyKey,
      retry,
      retryId: counter.retryId,
      delayMs,
      signal,
    })
  }

  /* ---------------------------------------------------------- registration */

  // This plugin has its own purpose-built surfaces inside the Models settings
  // page, so keep its Config out of the auto-generated settings navigation.
  // `settings` is optional: the retry engine itself does not need it.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.effect(
        () => settingsCtx.settings.configure({ auto: false }),
        'model-retry: keep its Config out of the automatic settings pages',
      )
    })
  }

  function track(operation) {
    const tracked = operation.finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  }

  /* --------------------------------------------- direct-call stream retry */

  /**
   * Retry plan for one direct (non agent-loop) model call.
   *
   * Auto review, session titles and compaction call `ctx.llm.stream()` exactly
   * once, so a transient provider failure (429 rate limit, 5xx, timeout,
   * transport drop, empty response) fails the whole consumer — for auto review
   * that means the reviewed tool call is refused even though the reviewer never
   * made a decision. Agent-loop requests are excluded: they already recover
   * through `agent/request-error`.
   *
   * @returns {undefined | { unlimited: boolean, maxRetries: number, codes: Set<string> | null, delay: (retry: number, failure: object) => number }}
   */
  function streamPlan(provider, model) {
    let decision
    try {
      decision = policyFor(provider, model)
    } catch (error) {
      ctx.logger.warn('model-retry: could not resolve a stream policy: %o', error)
      return undefined
    }
    if (decision.kind === 'off') return undefined
    if (decision.kind === 'model') {
      const policy = decision.policy
      return {
        unlimited: policy.retries === 0,
        maxRetries: policy.retries,
        codes: new Set(policy.retryableCodes),
        delay: (retry, failure) => computeModelDelay(policy, retry, failure),
      }
    }
    let stock
    try {
      stock = ctx.llm.providerRetryPolicy(provider)
    } catch {
      return undefined
    }
    if (stock === undefined) return undefined
    const unlimited = stock.mode === 'always'
    return {
      unlimited,
      maxRetries: unlimited ? Number.POSITIVE_INFINITY : stock.maxRetries,
      codes:
        unlimited || stock.retryableCodes === undefined
          ? null
          : new Set(stock.retryableCodes),
      delay: (retry, failure) => stockStreamDelay(stock, retry, failure),
    }
  }

  /**
   * Wrap one stream so a transient failure is retried while nothing has been
   * produced yet. A genuine reviewer decision is a normal `stop` finish and is
   * never touched; a stream that already emitted chunks is never restarted.
   */
  async function* retryingStream(options, next) {
    const signal = options === undefined ? undefined : options.signal
    if (signal !== undefined && signal.aborted) {
      yield* await next()
      return
    }

    let plan
    try {
      plan = isAgentLoopRequest(options)
        ? undefined
        : streamPlan(options.provider, options.model)
    } catch {
      plan = undefined
    }
    if (plan === undefined) {
      yield* await next()
      return
    }

    let retry = 0
    for (;;) {
      const inner = await next()
      let emitted = false
      let failure
      for await (const chunk of inner) {
        const reason = chunk === undefined ? undefined : chunk.reason
        if (
          chunk?.type === 'finish' &&
          reason?.kind === 'error' &&
          !emitted &&
          (signal === undefined || !signal.aborted) &&
          (plan.unlimited || retry < plan.maxRetries)
        ) {
          const candidate = reason.failure ?? { message: 'unknown failure', code: 'UNKNOWN' }
          if (plan.codes === null || plan.codes.has(candidate.code)) {
            failure = candidate
            break
          }
        }
        emitted = true
        yield chunk
      }
      if (failure === undefined) return

      retry += 1
      const delayMs = plan.delay(retry, failure)
      ctx.logger.warn(
        'model-retry: direct model call %s/%s failed with %s (%s); retry %s%s in %dms',
        options.provider,
        options.model,
        failure.code,
        failure.message,
        retry,
        plan.unlimited ? '/∞' : `/${plan.maxRetries}`,
        delayMs,
      )
      const fused =
        signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal])
      if (!(await cancellableDelay(delayMs, fused))) {
        yield { type: 'finish', reason: { kind: 'aborted', failure } }
        return
      }
    }
  }

  const disposeStream = ctx.on('llm/stream', (options, next) => retryingStream(options, next))

  const disposeRequest = ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    try {
      if (resolved !== null && typeof resolved === 'object' && typeof resolved.model === 'string') {
        modelByStep.set(payload.agent.id, {
          token: `${payload.turn}:${payload.step}`,
          provider: resolved.provider,
          model: resolved.model,
        })
      }
    } catch (error) {
      ctx.logger.warn('model-retry: could not remember the requested model: %o', error)
    }
    return resolved
  })

  const disposeError = ctx.on('agent/request-error', (payload, next) => {
    if (lifetime.signal.aborted) return Promise.resolve(undefined)
    return track(recover(payload, next))
  })

  const disposeDisposed = ctx.on('agent/disposed', (payload) => {
    modelByStep.delete(payload.agent.id)
    counters.delete(payload.agent.id)
  })

  ctx.effect(
    () => async () => {
      disposeStream()
      disposeRequest()
      disposeError()
      disposeDisposed()
      lifetime.abort(new Error('model-retry plugin disposed'))
      await Promise.allSettled([...active])
      modelByStep.clear()
      counters.clear()
    },
    'model-retry: abort and drain active recovery',
  )
}
