// Offline simulation of the dsh-model-retry host engine: drives the registered
// agent/request + agent/request-error listeners with a fake Cordis context.
let apply, Config, updateVolatile
try {
  ;({ apply, Config } = await import('../index.js'))
  ;({ updateVolatile } = await import('@deepseek-ai/cosmokit'))
} catch (error) {
  console.log('SKIP: this checkout cannot resolve the DeepSeek Harness peer packages.')
  console.log(`  ${error.message}`)
  console.log('  Run these tests where @deepseek-ai/schemastery and @deepseek-ai/cosmokit resolve,')
  console.log('  for example inside a DeepSeek Harness checkout or after installing the peers.')
  process.exit(0)
}

const realSetTimeout = globalThis.setTimeout
let INSTANT = true // collapse computed cooldowns so scenarios run in milliseconds
globalThis.setTimeout = (fn, ms) => realSetTimeout(fn, INSTANT ? 0 : ms)
const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms))

function makeContext() {
  const listeners = new Map()
  const effects = []
  const appended = []
  const session = {
    appended,
    append(type, data) {
      appended.push({ type, data })
    },
    requestContext() {
      return undefined
    },
  }
  const ctx = {
    sessions: { get: (id) => (id === 'agent-1' ? session : undefined) },
    logger: { warn() {}, info() {}, debug() {}, error() {} },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(handler)
        if (index >= 0) current.splice(index, 1)
      }
    },
    effect(fn) {
      effects.push(fn)
    },
  }
  return { ctx, listeners, session, effects }
}

function validateConfig(value) {
  const result = Config['~standard'].validate(value)
  if (result.issues) throw new Error('config rejected: ' + JSON.stringify(result.issues))
  return result.value
}

const agent = { id: 'agent-1' }
const failure = (code = 'SERVER', extra = {}) => ({ message: 'boom', code, ...extra })
const STOCK_POLICY = {
  mode: 'normal',
  maxRetries: 5,
  retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
  initialDelayMs: 500,
  maxDelayMs: 10000,
  jitterRatio: 0,
}

async function runStep(listeners, { turn, step, provider, model, wants, maxAttempts = 40 }) {
  const request = listeners.get('agent/request')[0]
  await request({ agent, turn, step, signal: new AbortController().signal }, async () => ({
    provider,
    model,
  }))

  const handler = listeners.get('agent/request-error')[0]
  const decisions = []
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const wanted = wants[Math.min(attempt, wants.length - 1)]
    const action = await handler(
      {
        agent,
        turn,
        step,
        provider,
        failure: wanted,
        retryPolicy: STOCK_POLICY,
        signal: new AbortController().signal,
      },
      async () => undefined,
    )
    decisions.push(action === undefined ? '<terminal>' : 'retry')
    if (action === undefined) return decisions
  }
  return decisions
}

let failures = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    failures += 1
    console.log(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`)
  } else {
    console.log(`ok   ${label} = ${a}`)
  }
}
const scheduledOf = (session) =>
  session.appended.filter((e) => e.type === 'llm/retry').map((e) => e.data)

/* 1 — capped retries, fixed cooldown */
{
  const { ctx, listeners, session } = makeContext()
  apply(ctx, validateConfig({
    models: { 'prov/m': { retries: 3, delayMode: 'fixed', delaySeconds: 2, maxDelaySeconds: 60 } },
  }))
  const decisions = await runStep(listeners, { turn: 1, step: 1, provider: 'prov', model: 'm', wants: [failure()] })
  check('capped: retry decisions', decisions.filter((d) => d === 'retry').length, 3)
  check('capped: terminal', decisions.at(-1), '<terminal>')
  const scheduled = scheduledOf(session)
  check('capped: delayMs sequence', scheduled.map((d) => d.delayMs), [2000, 2000, 2000])
  check('capped: retry ordinals', scheduled.map((d) => d.retry), [1, 2, 3])
  check('capped: mode', scheduled.map((d) => d.mode), ['normal', 'normal', 'normal'])
  check('capped: maxRetries', scheduled.map((d) => d.maxRetries), [3, 3, 3])
  check('capped: stable retryId', new Set(scheduled.map((d) => d.retryId)).size, 1)
  check('capped: started events', session.appended
    .filter((e) => e.type === 'llm/retry-started').map((e) => e.data.retry), [1, 2, 3])
  check('capped: provider on events', scheduled.map((d) => d.provider), ['prov', 'prov', 'prov'])
  check('capped: turn/step on events', [scheduled[0].turn, scheduled[0].step], [1, 1])
}

/* 2 — unlimited retries, incremental cooldown */
{
  const { ctx, listeners, session } = makeContext()
  apply(ctx, validateConfig({
    models: { 'prov/m': { retries: 0, delayMode: 'increment', delaySeconds: 0.01, incrementSeconds: 0.02, maxDelaySeconds: 60 } },
  }))
  const decisions = await runStep(listeners, {
    turn: 1, step: 1, provider: 'prov', model: 'm', wants: [failure()], maxAttempts: 8,
  })
  check('unlimited: every attempt retried', decisions.filter((d) => d === 'retry').length, 8)
  check('unlimited: never terminal', decisions.includes('<terminal>'), false)
  const scheduled = scheduledOf(session)
  check('unlimited: mode value', scheduled[0]?.mode, 'always')
  check('unlimited: no maxRetries', scheduled.every((d) => !('maxRetries' in d)), true)
  check('unlimited: increment delays', scheduled.map((d) => d.delayMs), [10, 30, 50, 70, 90, 110, 130, 150])
}

/* 3 — the cap bounds the incremental cooldown */
{
  const { ctx, listeners, session } = makeContext()
  apply(ctx, validateConfig({
    models: { 'prov/m': { retries: 5, delayMode: 'increment', delaySeconds: 1, incrementSeconds: 2, maxDelaySeconds: 5 } },
  }))
  await runStep(listeners, { turn: 1, step: 1, provider: 'prov', model: 'm', wants: [failure()] })
  check('cap: delayMs sequence', scheduledOf(session).map((d) => d.delayMs), [1000, 3000, 5000, 5000, 5000])
}

/* 4 — per-step counting */
{
  const { ctx, listeners, session } = makeContext()
  apply(ctx, validateConfig({ models: { 'prov/m': { retries: 2, delayMode: 'fixed', delaySeconds: 0.01 } } }))
  const first = await runStep(listeners, { turn: 1, step: 1, provider: 'prov', model: 'm', wants: [failure()] })
  check('per-step: step 1 retries', first.filter((d) => d === 'retry').length, 2)
  const second = await runStep(listeners, { turn: 1, step: 2, provider: 'prov', model: 'm', wants: [failure()] })
  check('per-step: step 2 retries', second.filter((d) => d === 'retry').length, 2)
  const scheduled = scheduledOf(session)
  check('per-step: ordinals restart', scheduled.map((d) => d.retry), [1, 2, 1, 2])
  check('per-step: new retryId per step', new Set(scheduled.map((d) => d.retryId)).size, 2)
}

/* 5 — Retry-After wins under the cap */
{
  const { ctx, listeners, session } = makeContext()
  apply(ctx, validateConfig({ models: { 'prov/m': { retries: 2, delayMode: 'fixed', delaySeconds: 1, maxDelaySeconds: 60 } } }))
  await runStep(listeners, {
    turn: 1, step: 1, provider: 'prov', model: 'm',
    wants: [failure('RATE_LIMIT', { providerRetryAfterMs: 7000 })],
  })
  check('retry-after: delayMs', scheduledOf(session).map((d) => d.delayMs), [7000, 7000])
}

/* 6 — non-retryable code is terminal even when unlimited */
{
  const { ctx, listeners } = makeContext()
  apply(ctx, validateConfig({ models: { 'prov/m': { retries: 0, delaySeconds: 0.01 } } }))
  const decisions = await runStep(listeners, { turn: 1, step: 1, provider: 'prov', model: 'm', wants: [failure('AUTH')] })
  check('non-retryable: terminal immediately', decisions, ['<terminal>'])
}

/* 7 — unconfigured model reproduces the stock exponential policy */
{
  const { ctx, listeners, session } = makeContext()
  apply(ctx, validateConfig({}))
  await runStep(listeners, { turn: 1, step: 1, provider: 'prov', model: 'unlisted', wants: [failure()] })
  const scheduled = scheduledOf(session)
  check('stock: five retries', scheduled.map((d) => d.retry), [1, 2, 3, 4, 5])
  check('stock: exponential delays', scheduled.map((d) => d.delayMs), [500, 1000, 2000, 4000, 8000])
  check('stock: maxRetries carried', scheduled.map((d) => d.maxRetries), [5, 5, 5, 5, 5])
}

/* 8 — unconfigured: off */
{
  const { ctx, listeners } = makeContext()
  apply(ctx, validateConfig({ unconfigured: 'off' }))
  const decisions = await runStep(listeners, { turn: 1, step: 1, provider: 'prov', model: 'unlisted', wants: [failure()] })
  check('off: terminal immediately', decisions, ['<terminal>'])
}

/* 9 — abort during the cooldown schedules nothing */
{
  INSTANT = false
  const { ctx, listeners } = makeContext()
  apply(ctx, validateConfig({ models: { 'prov/m': { retries: 0, delaySeconds: 0.05 } } }))
  const request = listeners.get('agent/request')[0]
  await request({ agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({
    provider: 'prov', model: 'm',
  }))
  const controller = new AbortController()
  const pending = listeners.get('agent/request-error')[0](
    { agent, turn: 1, step: 1, provider: 'prov', failure: failure(), retryPolicy: undefined, signal: controller.signal },
    async () => undefined,
  )
  await sleep(10)
  controller.abort()
  check('abort: no retry', (await pending) === undefined, true)
  INSTANT = true
}

/* 10 — a volatile config edit is observed without a remount */
{
  const { ctx, listeners } = makeContext()
  const config = validateConfig({ models: { 'prov/m': { retries: 1, delaySeconds: 0.01 } } })
  apply(ctx, config)
  const before = await runStep(listeners, { turn: 1, step: 1, provider: 'prov', model: 'm', wants: [failure()] })
  check('live: 1 retry before edit', before.filter((d) => d === 'retry').length, 1)

  updateVolatile(config.models, validateConfig({
    models: { 'prov/m': { retries: 2, delayMode: 'fixed', delaySeconds: 0.01 } },
  }).models)
  check('live: wrapper reflects update', config.models.get()['prov/m'].retries, 2)

  const after = await runStep(listeners, { turn: 1, step: 2, provider: 'prov', model: 'm', wants: [failure()] })
  check('live: 2 retries after edit', after.filter((d) => d === 'retry').length, 2)
}

console.log(failures === 0 ? '\nALL SIMULATION CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
