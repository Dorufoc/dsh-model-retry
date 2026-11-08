// Offline test for the direct-call (`llm/stream`) retry wrapper.
let apply, Config, markAgentLoopRequest
try {
  ;({ apply, Config } = await import('../index.js'))
  ;({ markAgentLoopRequest } = await import('@deepseek-ai/dsh-llm'))
} catch (error) {
  console.log('SKIP: this checkout cannot resolve the DeepSeek Harness peer packages.')
  console.log(`  ${error.message}`)
  console.log('  Run these tests where @deepseek-ai/dsh-llm and @deepseek-ai/schemastery resolve,')
  console.log('  for example inside a DeepSeek Harness checkout or after installing the peers.')
  process.exit(0)
}

const realSetTimeout = globalThis.setTimeout
let INSTANT = true
globalThis.setTimeout = (fn, ms) => realSetTimeout(fn, INSTANT ? 0 : ms)
const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms))

const STOCK = {
  mode: 'normal',
  maxRetries: 5,
  retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
  initialDelayMs: 500,
  maxDelayMs: 10000,
  jitterRatio: 0,
}

function makeContext() {
  const listeners = new Map()
  const logs = []
  const ctx = {
    sessions: { get: () => undefined },
    llm: { providerRetryPolicy: () => STOCK },
    logger: {
      warn: (...args) => logs.push(args),
      info() {},
      debug() {},
      error() {},
    },
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
    effect() {},
  }
  return { ctx, listeners, logs }
}

function validateConfig(value) {
  const result = Config['~standard'].validate(value)
  if (result.issues) throw new Error('config rejected: ' + JSON.stringify(result.issues))
  return result.value
}

const errorFinish = (code, extra = {}) => ({
  type: 'finish',
  reason: { kind: 'error', failure: { message: `${code} failure`, code, ...extra } },
})
const okChunks = () => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'MOCK_OK' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'MOCK_OK' } },
  { type: 'finish', reason: { kind: 'stop' } },
]
const abortFinish = () => ({
  type: 'finish',
  reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } },
})

function scripted(plans) {
  const state = { calls: 0 }
  const next = () =>
    (async function* () {
      const plan = plans[Math.min(state.calls, plans.length - 1)]
      state.calls += 1
      for (const chunk of plan) yield chunk
    })()
  return { next, state }
}

async function runStream(listener, options, next) {
  const collected = []
  for await (const chunk of listener(options, next)) collected.push(chunk)
  return collected
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

/* 1 — 429 RATE_LIMIT is retried, consumer sees only the good stream */
{
  const { ctx, listeners } = makeContext()
  apply(ctx, validateConfig({ models: { 'p/m': { retries: 3, delayMode: 'fixed', delaySeconds: 0.01 } } }))
  const listener = listeners.get('llm/stream')[0]
  const { next, state } = scripted([[errorFinish('RATE_LIMIT')], okChunks()])
  const chunks = await runStream(listener, { provider: 'p', model: 'm' }, next)
  check('429: provider calls', state.calls, 2)
  check('429: consumer sees finish stop', chunks.at(-1).reason.kind, 'stop')
  check('429: no error chunk leaked', chunks.some((c) => c.reason?.kind === 'error'), false)
}

/* 2 — a 5xx SERVER failure is retried too */
{
  const { ctx, listeners } = makeContext()
  apply(ctx, validateConfig({ models: { 'p/m': { retries: 3, delayMode: 'fixed', delaySeconds: 0.01 } } }))
  const listener = listeners.get('llm/stream')[0]
  const { next, state } = scripted([[errorFinish('SERVER')], [errorFinish('SERVER')], okChunks()])
  const chunks = await runStream(listener, { provider: 'p', model: 'm' }, next)
  check('500: provider calls', state.calls, 3)
  check('500: consumer sees finish stop', chunks.at(-1).reason.kind, 'stop')
}

/* 3 — a non-transient code is NOT retried (still fails fast) */
{
  const { ctx, listeners } = makeContext()
  apply(ctx, validateConfig({ models: { 'p/m': { retries: 3, delayMode: 'fixed', delaySeconds: 0.01 } } }))
  const listener = listeners.get('llm/stream')[0]
  const { next, state } = scripted([[errorFinish('AUTH')], okChunks()])
  const chunks = await runStream(listener, { provider: 'p', model: 'm' }, next)
  check('auth: provider calls', state.calls, 1)
  check('auth: error chunk reaches consumer', chunks.at(-1).reason.kind, 'error')
}

/* 4 — a failure AFTER content was emitted is not restarted */
{
  const { ctx, listeners } = makeContext()
  apply(ctx, validateConfig({ models: { 'p/m': { retries: 3, delaySeconds: 0.01 } } }))
  const listener = listeners.get('llm/stream')[0]
  const partial = [{ type: 'text-delta', index: 0, text: 'par' }, errorFinish('SERVER')]
  const { next, state } = scripted([partial, okChunks()])
  const chunks = await runStream(listener, { provider: 'p', model: 'm' }, next)
  check('partial: provider calls', state.calls, 1)
  check('partial: error chunk reaches consumer', chunks.at(-1).reason.kind, 'error')
}

/* 5 — an agent-loop request is left alone (handled by agent/request-error) */
{
  const { ctx, listeners } = makeContext()
  apply(ctx, validateConfig({ models: { 'p/m': { retries: 3, delaySeconds: 0.01 } } }))
  const listener = listeners.get('llm/stream')[0]
  const options = markAgentLoopRequest({ provider: 'p', model: 'm' })
  const { next, state } = scripted([[errorFinish('RATE_LIMIT')], okChunks()])
  const chunks = await runStream(listener, options, next)
  check('loop: provider calls', state.calls, 1)
  check('loop: error chunk reaches agent loop', chunks.at(-1).reason.kind, 'error')
}

/* 6 — a genuine reviewer decision (`stop`) is never touched */
{
  const { ctx, listeners } = makeContext()
  apply(ctx, validateConfig({ models: { 'p/m': { retries: 3, delaySeconds: 0.01 } } }))
  const listener = listeners.get('llm/stream')[0]
  const decision = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '{"risk":"low","decision":"deny"}' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const { next, state } = scripted([decision])
  const chunks = await runStream(listener, { provider: 'p', model: 'm' }, next)
  check('denial: provider calls', state.calls, 1)
  check('denial: decision preserved', chunks.at(-2).block.text, '{"risk":"low","decision":"deny"}')
}

/* 7 — retries: 0 means unlimited for direct calls as well */
{
  const { ctx, listeners } = makeContext()
  apply(ctx, validateConfig({ models: { 'p/m': { retries: 0, delayMode: 'increment', delaySeconds: 0.01, incrementSeconds: 0.01 } } }))
  const listener = listeners.get('llm/stream')[0]
  const plans = [...Array(6).fill([errorFinish('RATE_LIMIT')]), okChunks()]
  const { next, state } = scripted(plans)
  const chunks = await runStream(listener, { provider: 'p', model: 'm' }, next)
  check('unlimited: provider calls', state.calls, 7)
  check('unlimited: eventually succeeds', chunks.at(-1).reason.kind, 'stop')
}

/* 8 — unconfigured model inherits the provider's stock policy */
{
  const { ctx, listeners, logs } = makeContext()
  apply(ctx, validateConfig({}))
  const listener = listeners.get('llm/stream')[0]
  const plans = [...Array(6).fill([errorFinish('SERVER')])]
  const { next, state } = scripted(plans)
  await runStream(listener, { provider: 'p', model: 'unlisted' }, next)
  check('stock: attempts before giving up', state.calls, 6) // 1 + 5 retries
  const retried = logs.filter((l) => String(l[0]).includes('direct model call'))
  check('stock: retry log count', retried.length, 5)
}

/* 9 — aborting during a cooldown ends the stream as aborted */
{
  INSTANT = false
  const { ctx, listeners } = makeContext()
  apply(ctx, validateConfig({ models: { 'p/m': { retries: 0, delaySeconds: 0.05 } } }))
  const listener = listeners.get('llm/stream')[0]
  const controller = new AbortController()
  const { next, state } = scripted([[errorFinish('SERVER')], okChunks()])
  const pending = runStream(listener, { provider: 'p', model: 'm', signal: controller.signal }, next)
  await sleep(10)
  controller.abort()
  const chunks = await pending
  check('abort: only one provider call', state.calls, 1)
  check('abort: terminal kind', chunks.at(-1).reason.kind, 'aborted')
  INSTANT = true
}

/* 10 — an already-aborted signal passes the stream straight through */
{
  const { ctx, listeners } = makeContext()
  apply(ctx, validateConfig({ models: { 'p/m': { retries: 0, delaySeconds: 0.01 } } }))
  const listener = listeners.get('llm/stream')[0]
  const controller = new AbortController()
  controller.abort()
  const { next, state } = scripted([[abortFinish()]])
  const chunks = await runStream(listener, { provider: 'p', model: 'm', signal: controller.signal }, next)
  check('pre-aborted: provider calls', state.calls, 1)
  check('pre-aborted: terminal kind', chunks.at(-1).reason.kind, 'aborted')
}

console.log(failures === 0 ? '\nALL STREAM CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
