// verify/run.mjs
//
// Verification driver for the `dsh-model-retry` plugin.
//
// It does NOT run the agent loop itself (the Harness has no standalone CLI in
// this install): it starts the scriptable mock provider, prints the exact manual
// runbook for a scenario, and then parses the session log the live Harness wrote
// under %DSH_HOME%/sessions/ and asserts the retry semantics on the durable
// events.
//
// Commands
//   node verify/run.mjs list
//   node verify/run.mjs latest [--root <dir>] [--since-minutes N] [--exclude <sessionId>]
//   node verify/run.mjs parse <sessionFile|latest> [--json]
//   node verify/run.mjs mock [--port 8787] [--plan 500,500,ok] [--default-status 500]
//   node verify/run.mjs control <scenario|--json '{...}'> [--mock http://127.0.0.1:8787]
//   node verify/run.mjs runbook <scenario>
//   node verify/run.mjs scenarios
//   node verify/run.mjs assert <scenario> [--session <file|latest>] [--mock URL] [--retries N]
//                                          [--delay-seconds N] [--increment-seconds N] [--max-delay-seconds N]
//                                          [--route pi-ai|deepseek] [--json]
//   node verify/run.mjs watch [--scenario <id>] [--mock http://127.0.0.1:8787] [--since-minutes N]
//   node verify/run.mjs selftest
//
// No npm dependencies. Bundled Node:
//   %DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe

import process from 'node:process'
import path from 'node:path'
import { createMockProvider } from './mock-provider.mjs'
import {
  extractRetryChain,
  latestSessionFile,
  listSessionFiles,
  parseSessionFile,
  sessionIdOfFile,
  sessionsRoot,
  summarizeEvents,
  turnOutcomes,
  validateRetryInvariants,
} from './session-log.mjs'

const NOW = () => Date.now()

// ---------------------------------------------------------------------------
// Scenario catalog (design/model-retry-plugin.md §8.2, §6.4-6.6)
// ---------------------------------------------------------------------------

const SCENARIOS = [
  {
    id: 'stock',
    plan: ['500', '500', '500', '500', '500', '500'],
    delaySeconds: 2,
    title: 'Unconfigured model behaves like stock DSH (5 exponential retries)',
    pluginConfig: 'no `models["<provider>/<model>"]` entry (unconfigured: inherit)',
    prompt: 'Say hello in one short sentence.',
    expected: [
      'exactly 5 retries (6 attempts), each normal-mode (maxRetries 5)',
      'delayMs ≈ 500 / 1000 / 2000 / 4000 / 8000 ms with up to ±10% jitter (stock exponential backoff)',
      'turn/end reason kind = "error"',
    ],
    kind: 'stock',
  },
  {
    id: 'cap-n',
    plan: ['500', '500', '500', '500', '500'],
    retries: 3,
    delaySeconds: 2,
    title: 'retries: 3 => exactly 3 retries, then terminal',
    pluginConfig: 'models["<provider>/<model>"] = { retries: 3, delayMode: "fixed", delaySeconds: 2 }',
    prompt: 'Say hello in one short sentence.',
    expected: [
      'exactly 3 llm/retry events with retry = 1,2,3',
      'mode "normal" and maxRetries 3 on every llm/retry',
      'turn/end reason kind = "error" (no 4th retry)',
    ],
    kind: 'cap',
  },
  {
    id: 'unlimited-abort',
    plan: [],
    defaultStatus: 500,
    retries: 0,
    delaySeconds: 2,
    title: 'retries: 0 => unlimited retries, stops instantly on turn abort',
    pluginConfig: 'models["<provider>/<model>"] = { retries: 0, delayMode: "fixed", delaySeconds: 2 }',
    prompt: 'Say hello in one short sentence.',
    expected: [
      'two or more llm/retry events, every one mode "always" with no maxRetries',
      'turn/end reason kind = "aborted" after the Stop button',
      'the final scheduled retry has no llm/retry-started (aborted during cooldown) or no later request follows it',
    ],
    kind: 'unlimited',
  },
  {
    id: 'per-step',
    plan: ['500', '500', '500', 'ok'],
    retries: 3,
    delaySeconds: 1,
    title: 'Counting is per step: turn 1 retries 1..3 then success; turn 2 starts at 1 again',
    pluginConfig: 'models["<provider>/<model>"] = { retries: 3, delayMode: "fixed", delaySeconds: 1 }',
    prompt: 'First prompt: "Say hello". After it succeeds, send a second prompt: "Say goodbye".',
    expected: [
      'turn 1: chain retry = 1,2,3 then an assistant/message (success)',
      'turn 2: its first llm/retry has retry = 1 again',
      'retryId differs between the two steps; retryId is stable inside one step',
    ],
    kind: 'per-step',
  },
  {
    id: 'fixed',
    plan: ['500', '500', '500', '500'],
    retries: 5,
    delaySeconds: 2,
    title: 'Fixed cooldown: every scheduled delayMs equals delaySeconds * 1000',
    pluginConfig: 'models["<provider>/<model>"] = { retries: 5, delayMode: "fixed", delaySeconds: 2 }',
    prompt: 'Say hello in one short sentence.',
    expected: ['every llm/retry delayMs === 2000', 'no jitter: identical values'],
    kind: 'fixed',
  },
  {
    id: 'increment',
    plan: ['500', '500', '500', '500', '500', '500'],
    retries: 6,
    delaySeconds: 2,
    incrementSeconds: 2,
    maxDelaySeconds: 10,
    title: 'Increment cooldown: 2s, 4s, 6s, 8s, capped at 10s',
    pluginConfig: 'models["<provider>/<model>"] = { retries: 6, delayMode: "increment", delaySeconds: 2, incrementSeconds: 2, maxDelaySeconds: 10 }',
    prompt: 'Say hello in one short sentence.',
    expected: ['delayMs sequence = 2000, 4000, 6000, 8000, 10000, 10000 (cap)'],
    kind: 'increment',
  },
  {
    id: 'retry-after',
    plan: [{ status: 429, retryAfterSeconds: 7 }, 'ok'],
    retries: 3,
    delaySeconds: 2,
    title: 'Retry-After: 7 — adapter behaviour guard (see README "Scenario 8")',
    pluginConfig: 'models["<provider>/<model>"] = { retries: 3, delayMode: "fixed", delaySeconds: 2 }',
    prompt: 'Say hello in one short sentence.',
    expected: [
      'route pi-ai (openai-completions): failure.providerRetryAfterMs is ABSENT and the scheduled delayMs is the LOCAL 2000 ms (the pi-ai adapter drops the header)',
      'route deepseek (manual only): failure.providerRetryAfterMs = 7000 and delayMs = 7000',
    ],
    kind: 'retry-after',
  },
]

function scenarioById(id) {
  return SCENARIOS.find((scenario) => scenario.id === id)
}

// ---------------------------------------------------------------------------
// Small CLI / output helpers
// ---------------------------------------------------------------------------

function parseArgv(argv) {
  const options = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      options._.push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) options[key] = true
    else {
      options[key] = next
      index += 1
    }
  }
  return options
}

const PASS = 'PASS'
const FAIL = 'FAIL'
const INFO = 'INFO'

function line(width = 100) {
  return '-'.repeat(width)
}

function printChecks(checks) {
  let failed = 0
  for (const check of checks) {
    const status = check.ok ? PASS : FAIL
    if (!check.ok) failed += 1
    console.log(`[${status}] ${check.name}`)
    if (check.expected !== undefined) console.log(`        expected: ${check.expected}`)
    if (check.actual !== undefined) console.log(`        actual:   ${check.actual}`)
    if (check.detail !== undefined) console.log(`        detail:   ${check.detail}`)
  }
  console.log(line())
  console.log(failed === 0 ? `RESULT: ${PASS} (${checks.length} checks)` : `RESULT: ${FAIL} (${failed}/${checks.length} checks failed)`)
  return failed
}

function fmtMs(value) {
  return value === undefined ? '-' : `${Math.round(value)}ms`
}

function fmtDelay(value) {
  if (value === undefined) return '-'
  return Number.isInteger(value) ? `${value}ms` : `${Math.round(value)}ms`
}

function sessionHeaderLine(header) {
  if (header === undefined) return '(no session header row)'
  return `session ${header.id} version=${header.version} cwd=${header.cwd ?? '(none)'} origin=${header.origin ?? 'top'} preset=${header.agentPreset ?? '-'} createdAt=${new Date(header.createdAt).toISOString()}`
}

// ---------------------------------------------------------------------------
// Session selection
// ---------------------------------------------------------------------------

function resolveSessionArgument(value, options) {
  if (value === undefined || value === true || value === 'latest') {
    const sinceMs = options['since-minutes'] !== undefined ? NOW() - Number(options['since-minutes']) * 60_000 : undefined
    const exclude = options.exclude === undefined ? [] : String(options.exclude).split(',').map((part) => part.trim()).filter(Boolean)
    const latest = latestSessionFile({ root: options.root, sinceMs, excludeSessionIds: exclude })
    if (latest === undefined) throw new Error(`no session artifact found under ${options.root ?? sessionsRoot()}`)
    return latest
  }
  return path.resolve(String(value))
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

async function fetchMockLog(mockURL) {
  if (mockURL === undefined || mockURL === true) return undefined
  const base = String(mockURL).replace(/\/+$/, '')
  const response = await fetch(`${base}/__log`)
  if (!response.ok) throw new Error(`mock log request failed: HTTP ${response.status}`)
  return response.json()
}

function deriveAttempts(retries, mockLog) {
  const requests = mockLog?.requests ?? []
  const count = Math.max(requests.length, retries.length + (mockLog === undefined ? 0 : 0), retries.length + 1)
  const attempts = []
  for (let index = 0; index < count; index += 1) {
    const request = requests[index]
    const retry = retries[index]
    attempts.push({
      index: index + 1,
      at: request?.at,
      gapMs: request?.tSincePrevMs,
      status: request?.status,
      responseKind: request?.responseKind,
      model: request?.model ?? retry?.model,
      retryAfterSeconds: request?.retryAfterSeconds,
      scheduledRetry: retry,
    })
  }
  return attempts
}

function printAttemptTable(retries, mockLog) {
  const attempts = deriveAttempts(retries, mockLog)
  console.log(line())
  console.log('ATTEMPTS (attempt = one /v1/chat/completions request; the retry columns are the llm/retry event the failure scheduled)')
  console.log(['#', 'time', 'gap', 'http', 'retry#', 'delayMs', 'mode', 'step', 'model', 'retryId'].map((head) => head.padEnd(9)).join(' '))
  for (const attempt of attempts) {
    const retry = attempt.scheduledRetry
    const columns = [
      String(attempt.index).padEnd(9),
      (attempt.at === undefined ? '-' : new Date(attempt.at).toISOString().slice(11, 23)).padEnd(9),
      fmtMs(attempt.gapMs).padEnd(9),
      (attempt.status === undefined ? '-' : String(attempt.status)).padEnd(9),
      (retry === undefined ? '-' : String(retry.retry)).padEnd(9),
      fmtDelay(retry?.delayMs).padEnd(9),
      (retry?.mode ?? '-').padEnd(9),
      (retry === undefined ? '-' : `${retry.turn}/${retry.step}`).padEnd(9),
      String(retry?.model ?? attempt.model ?? '-').slice(0, 8).padEnd(9),
      (retry?.retryId ?? '-').slice(0, 8).padEnd(9),
    ]
    console.log(columns.join(' '))
  }
  void INFO
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function check(name, ok, expected, actual, detail) {
  return { name, ok, expected, actual, detail }
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0)
}

function delayValues(retries) {
  return retries.map((retry) => retry.delayMs)
}

function lastTurnEnd(events) {
  const outcomes = [...turnOutcomes(events).values()]
  return outcomes.at(-1)
}

function turnEndKind(event) {
  return event?.data?.reason?.kind
}

function chainsFor(retries) {
  const chains = new Map()
  for (const retry of retries) {
    const key = JSON.stringify([retry.turn, retry.step, retry.provider, retry.policyKey])
    const list = chains.get(key) ?? []
    list.push(retry)
    chains.set(key, list)
  }
  for (const list of chains.values()) list.sort((a, b) => a.retry - b.retry)
  return chains
}

// ---------------------------------------------------------------------------
// Scenario assertions
// ---------------------------------------------------------------------------

function assertStock(context) {
  const { retries, events } = context
  const checks = []
  checks.push(check(
    'retry count equals stock budget (5 retries / 6 attempts)',
    retries.length === 5,
    '5 llm/retry events',
    `${retries.length} llm/retry events`,
  ))
  checks.push(check(
    'every retry is normal-mode with maxRetries 5',
    retries.every((retry) => retry.mode === 'normal' && retry.maxRetries === 5),
    'mode "normal", maxRetries 5',
    JSON.stringify(retries.map((retry) => [retry.mode, retry.maxRetries])),
  ))
  const expectedBase = [500, 1000, 2000, 4000, 8000]
  const jitterOk = retries.every((retry, index) => {
    const base = expectedBase[index]
    return base !== undefined && retry.delayMs >= base * 0.85 && retry.delayMs <= base * 1.15
  })
  checks.push(check(
    'delayMs follows stock exponential backoff (±10% jitter)',
    jitterOk,
    JSON.stringify(expectedBase.map((base) => `${base}±10%`)),
    JSON.stringify(delayValues(retries)),
  ))
  const end = lastTurnEnd(events)
  checks.push(check('turn ended with an error', turnEndKind(end) === 'error', '"error"', JSON.stringify(turnEndKind(end))))
  return checks
}

function assertCap(context) {
  const { retries, events, options } = context
  const expectedCount = Number(options.retries ?? 3)
  const checks = []
  checks.push(check(
    `exactly ${expectedCount} retries`,
    retries.length === expectedCount,
    `${expectedCount} llm/retry events`,
    `${retries.length} llm/retry events`,
  ))
  checks.push(check(
    'retry sequence is 1..N inside the step',
    JSON.stringify(retries.map((retry) => retry.retry)) === JSON.stringify(Array.from({ length: expectedCount }, (_, index) => index + 1)),
    JSON.stringify(Array.from({ length: expectedCount }, (_, index) => index + 1)),
    JSON.stringify(retries.map((retry) => retry.retry)),
  ))
  checks.push(check(
    'every retry advertises maxRetries = N',
    retries.every((retry) => retry.mode === 'normal' && retry.maxRetries === expectedCount),
    `mode "normal", maxRetries ${expectedCount}`,
    JSON.stringify(retries.map((retry) => [retry.mode, retry.maxRetries])),
  ))
  const end = lastTurnEnd(events)
  checks.push(check('turn ended with an error after the cap', turnEndKind(end) === 'error', '"error"', JSON.stringify(turnEndKind(end))))
  return checks
}

function assertUnlimited(context) {
  const { retries, events } = context
  const checks = []
  checks.push(check(
    'more than one retry was scheduled (unlimited did not stop at a cap)',
    retries.length >= 2,
    '>= 2 llm/retry events',
    `${retries.length} llm/retry events`,
  ))
  checks.push(check(
    'every retry is mode "always" and omits maxRetries',
    retries.length > 0 && retries.every((retry) => retry.mode === 'always' && retry.maxRetries === undefined),
    'mode "always", no maxRetries',
    JSON.stringify(retries.map((retry) => [retry.mode, retry.maxRetries])),
  ))
  const end = lastTurnEnd(events)
  checks.push(check('turn ended aborted after Stop', turnEndKind(end) === 'aborted', '"aborted"', JSON.stringify(turnEndKind(end))))
  const last = retries.at(-1)
  const abortedDuringCooldown = last !== undefined && last.started === false
  checks.push(check(
    'the last scheduled retry never started (aborted during cooldown)',
    abortedDuringCooldown,
    'final llm/retry without a matching llm/retry-started',
    last === undefined ? 'no retries' : `retry ${last.retry} started=${String(last.started)}`,
    'If the Stop landed during the HTTP attempt instead, check that no request follows the abort.',
  ))
  return checks
}

function assertPerStep(context) {
  const { retries } = context
  const checks = []
  const chains = chainsFor(retries)
  const stepKeys = new Set(retries.map((retry) => `${retry.turn}:${retry.step}`))
  checks.push(check(
    'two distinct steps produced retry chains',
    stepKeys.size >= 2,
    '>= 2 steps',
    `${stepKeys.size} step(s): ${[...stepKeys].join(', ')}`,
    'Send the second prompt after the first turn completes.',
  ))
  let firstOk = true
  let sequenceOk = true
  const sequences = []
  for (const list of chains.values()) {
    const first = list[0]
    sequences.push(`${first.turn}/${first.step}: ${list.map((retry) => retry.retry).join(',')}`)
    if (first.retry !== 1) firstOk = false
    if (list.map((retry) => retry.retry).join(',') !== Array.from({ length: list.length }, (_, index) => index + 1).join(',')) sequenceOk = false
  }
  checks.push(check('every policy chain starts its retry count at 1', firstOk, 'first retry of each chain = 1', sequences.join(' | ')))
  checks.push(check('every policy chain is sequential (1..n)', sequenceOk, '1,2,3,…', sequences.join(' | ')))

  const idsByStep = new Map()
  for (const retry of retries) {
    const stepKey = `${retry.turn}:${retry.step}`
    const ids = idsByStep.get(stepKey) ?? new Set()
    ids.add(retry.retryId)
    idsByStep.set(stepKey, ids)
  }
  const flatIds = [...idsByStep.values()].flatMap((ids) => [...ids])
  const perStepDistinct = new Set(flatIds).size === flatIds.length
  checks.push(check(
    'retryId is not reused across steps',
    perStepDistinct,
    'one retryId owner per step',
    [...idsByStep.entries()].map(([stepKey, ids]) => `${stepKey}: ${[...ids].map((id) => id.slice(0, 8)).join(',')}`).join(' | '),
  ))
  return checks
}

function assertFixed(context) {
  const { retries, options } = context
  const base = Number(options['delay-seconds'] ?? 2) * 1000
  const delays = delayValues(retries)
  return [
    check('at least one retry was scheduled', retries.length >= 1, '>= 1', `${retries.length}`),
    check(
      'every delayMs equals delaySeconds * 1000',
      delays.length > 0 && delays.every((delay) => delay === base),
      `all === ${base}`,
      JSON.stringify(delays),
    ),
  ]
}

function assertIncrement(context) {
  const { retries, options } = context
  const base = Number(options['delay-seconds'] ?? 2) * 1000
  const increment = Number(options['increment-seconds'] ?? 2) * 1000
  const cap = Number(options['max-delay-seconds'] ?? 10) * 1000
  const delays = delayValues(retries)
  const expected = delays.map((_, index) => Math.min(base + index * increment, cap))
  return [
    check('at least one retry was scheduled', retries.length >= 1, '>= 1', `${retries.length}`),
    check(
      'delayMs = base, base+inc, base+2*inc, … capped at maxDelaySeconds',
      JSON.stringify(delays) === JSON.stringify(expected),
      JSON.stringify(expected),
      JSON.stringify(delays),
    ),
  ]
}

function assertRetryAfter(context) {
  const { retries, options } = context
  const route = String(options.route ?? 'pi-ai')
  const base = Number(options['delay-seconds'] ?? 2) * 1000
  const first = retries[0]
  const checks = [check('a retry was scheduled after the 429', first !== undefined, '>= 1', `${retries.length}`)]
  if (route === 'deepseek') {
    checks.push(check(
      'deepseek route surfaces Retry-After: 7 as providerRetryAfterMs = 7000',
      first?.providerRetryAfterMs === 7000,
      '7000',
      String(first?.providerRetryAfterMs),
      'Manual/optional: needs the official dsh-llm-deepseek route (a real DeepSeek endpoint or a crafted failure).',
    ))
    checks.push(check('scheduled delayMs equals the provider instruction', first?.delayMs === 7000, '7000', String(first?.delayMs)))
    return checks
  }
  checks.push(check(
    'pi-ai route drops the Retry-After header (regression guard: we must not invent it)',
    first?.providerRetryAfterMs === undefined,
    'undefined',
    String(first?.providerRetryAfterMs),
    'dsh-llm-pi-ai builds LlmFailure as { message, code } only (lib/index.js:1470-1524); no providerRetryAfterMs.',
  ))
  checks.push(check(
    'scheduled delayMs falls back to the LOCAL configured delay',
    first?.delayMs === base,
    `${base}`,
    String(first?.delayMs),
  ))
  return checks
}

function assertScenario(scenario, context) {
  switch (scenario.kind) {
    case 'stock': return assertStock(context)
    case 'cap': return assertCap(context)
    case 'unlimited': return assertUnlimited(context)
    case 'per-step': return assertPerStep(context)
    case 'fixed': return assertFixed(context)
    case 'increment': return assertIncrement(context)
    case 'retry-after': return assertRetryAfter(context)
    default: throw new Error(`no assertions for scenario kind ${scenario.kind}`)
  }
}

// ---------------------------------------------------------------------------
// Synthetic sessions (self-test of the assertion layer, no files written)
// ---------------------------------------------------------------------------

let syntheticSeq = 0
function syntheticEvent(type, data, at) {
  syntheticSeq += 1
  return { type, seq: syntheticSeq, time: at + syntheticSeq, data }
}

function syntheticSession({ provider = 'mock', model = 'mock-model', steps = [] }) {
  const at = NOW()
  const events = []
  for (const step of steps) {
    events.push(syntheticEvent('turn/start', { turn: step.turn }, at))
    if (step.step === 1) {
      events.push(syntheticEvent('request/header', { header: { config: { provider, model } }, reason: 'initial' }, at))
    }
    events.push(syntheticEvent('step/start', { turn: step.turn, step: step.step }, at))
    for (const [index, retry] of (step.retries ?? []).entries()) {
      const retryId = retry.retryId ?? `retry-${step.turn}-${step.step}`
      const failure = { message: `mock ${retry.code ?? 'SERVER'} failure`, code: retry.code ?? 'SERVER', ...retry.failure }
      events.push(syntheticEvent('llm/retry', {
        retryId,
        turn: step.turn,
        step: step.step,
        provider,
        mode: retry.mode ?? 'normal',
        policyKey: retry.policyKey ?? `policy-${step.turn}-${step.step}`,
        retry: retry.retry ?? index + 1,
        ...(retry.mode === 'always' ? {} : { maxRetries: retry.maxRetries ?? (step.retries?.length ?? 0) }),
        delayMs: retry.delayMs,
        failure,
      }, at))
      if (retry.started !== false) {
        events.push(syntheticEvent('llm/retry-started', { retryId, turn: step.turn, step: step.step, retry: retry.retry ?? index + 1 }, at))
      }
    }
    events.push(syntheticEvent('step/end', { turn: step.turn, step: step.step }, at))
    events.push(syntheticEvent('turn/end', { turn: step.turn, reason: step.end }, at))
  }
  return events
}

function assertionSelfTest() {
  const cases = []
  const push = (name, scenarioId, events, options) => {
    const scenario = scenarioById(scenarioId)
    const retries = extractRetryChain(events).retries
    const checks = assertScenario(scenario, { retries, events, options, scenario })
    cases.push({ name, scenarioId, ok: checks.every((check) => check.ok), checks })
  }
  push('fixed 2s x3', 'fixed', syntheticSession({
    steps: [{ turn: 1, step: 1, end: { kind: 'error' }, retries: [
      { retry: 1, delayMs: 2000 }, { retry: 2, delayMs: 2000 }, { retry: 3, delayMs: 2000 },
    ] }],
  }), { 'delay-seconds': 2 })
  push('cap 3 then terminal', 'cap-n', syntheticSession({
    steps: [{ turn: 1, step: 1, end: { kind: 'error' }, retries: [
      { retry: 1, delayMs: 2000, maxRetries: 3 }, { retry: 2, delayMs: 2000, maxRetries: 3 }, { retry: 3, delayMs: 2000, maxRetries: 3 },
    ] }],
  }), { retries: 3 })
  push('increment 2/4/6 capped by 10', 'increment', syntheticSession({
    steps: [{ turn: 1, step: 1, end: { kind: 'error' }, retries: [
      { retry: 1, delayMs: 2000 }, { retry: 2, delayMs: 4000 }, { retry: 3, delayMs: 6000 },
    ] }],
  }), { 'delay-seconds': 2, 'increment-seconds': 2, 'max-delay-seconds': 10 })
  push('stock 5 exponential retries', 'stock', syntheticSession({
    steps: [{ turn: 1, step: 1, end: { kind: 'error' }, retries: [
      { retry: 1, delayMs: 480, maxRetries: 5 }, { retry: 2, delayMs: 1020, maxRetries: 5 }, { retry: 3, delayMs: 1980, maxRetries: 5 },
      { retry: 4, delayMs: 4050, maxRetries: 5 }, { retry: 5, delayMs: 7900, maxRetries: 5 },
    ] }],
  }), {})
  push('unlimited aborted during cooldown', 'unlimited-abort', syntheticSession({
    steps: [{ turn: 1, step: 1, end: { kind: 'aborted', reason: { kind: 'user' } }, retries: [
      { retry: 1, delayMs: 2000, mode: 'always' }, { retry: 2, delayMs: 2000, mode: 'always' },
      { retry: 3, delayMs: 2000, mode: 'always', started: false },
    ] }],
  }), {})
  push('per-step reset across two turns', 'per-step', syntheticSession({
    steps: [
      { turn: 1, step: 1, end: { kind: 'completed' }, retries: [
        { retry: 1, delayMs: 1000 }, { retry: 2, delayMs: 1000 }, { retry: 3, delayMs: 1000 },
      ] },
      { turn: 2, step: 1, end: { kind: 'error' }, retries: [
        { retry: 1, delayMs: 1000 }, { retry: 2, delayMs: 1000 },
      ] },
    ],
  }), {})
  push('retry-after on pi-ai route falls back to local delay', 'retry-after', syntheticSession({
    steps: [{ turn: 1, step: 1, end: { kind: 'completed' }, retries: [
      { retry: 1, delayMs: 2000, code: 'RATE_LIMIT' },
    ] }],
  }), { route: 'pi-ai', 'delay-seconds': 2 })

  // Negative cases prove the assertions can fail.
  const negativeFixed = assertScenario(scenarioById('fixed'), {
    retries: extractRetryChain(syntheticSession({
      steps: [{ turn: 1, step: 1, end: { kind: 'error' }, retries: [
        { retry: 1, delayMs: 2000 }, { retry: 2, delayMs: 1500 },
      ] }],
    })).retries,
    events: [],
    options: { 'delay-seconds': 2 },
  })
  cases.push({ name: 'fixed with a wrong delay is rejected', scenarioId: 'fixed', ok: negativeFixed.some((check) => !check.ok), checks: negativeFixed })
  const skippedEvents = syntheticSession({
    steps: [{ turn: 1, step: 1, end: { kind: 'error' }, retries: [
      { retry: 1, delayMs: 1000 }, { retry: 3, delayMs: 1000 },
    ] }],
  })
  const invariants = validateRetryInvariants(skippedEvents)
  cases.push({
    name: 'skipped retry number is rejected by the format validator',
    scenarioId: 'invariants',
    ok: !invariants.ok,
    checks: [{ name: 'validator reports the skip', ok: !invariants.ok, expected: 'violations', actual: `${invariants.problems.length} problem(s)` }],
  })

  let failed = 0
  for (const testCase of cases) {
    const status = testCase.ok ? PASS : FAIL
    if (!testCase.ok) failed += 1
    console.log(`  [${status}] ${testCase.name} (${testCase.scenarioId})`)
    if (!testCase.ok) {
      for (const check of testCase.checks) if (!check.ok) console.log(`        ${check.name}: expected ${check.expected} actual ${check.actual}`)
    }
  }
  return failed
}


function cmdList(options) {
  const files = listSessionFiles(options.root ?? sessionsRoot())
  console.log(`session root: ${options.root ?? sessionsRoot()} (${files.length} artifact(s), newest first)`)
  for (const file of files.slice(0, 30)) {
    console.log(`${new Date(file.mtimeMs).toISOString()}  ${(file.size / 1024).toFixed(0).padStart(7)} KiB  ${file.path}`)
  }
  if (files.length > 30) console.log(`… ${files.length - 30} more`)
}

function cmdLatest(options) {
  const file = resolveSessionArgument('latest', options)
  const { header, events, frames } = parseSessionFile(file)
  console.log(file)
  console.log(`  frames=${frames} events=${events.length}`)
  console.log(`  ${sessionHeaderLine(header)}`)
  const retries = extractRetryChain(events).retries
  console.log(`  llm/retry=${retries.length} turn/end=${events.filter((event) => event.type === 'turn/end').length}`)
}

function printRetryTable(retries) {
  console.log(line())
  console.log('RETRY CHAIN (from durable llm/retry / llm/retry-started events)')
  console.log(['seq', 'turn/step', 'retry', 'delay', 'mode', 'max', 'code', 'retryId', 'started', 'model'].map((head) => head.padEnd(11)).join(' '))
  for (const retry of retries) {
    console.log([
      String(retry.seq).padEnd(11),
      `${retry.turn}/${retry.step}`.padEnd(11),
      String(retry.retry).padEnd(11),
      fmtDelay(retry.delayMs).padEnd(11),
      (retry.mode ?? '-').padEnd(11),
      String(retry.maxRetries ?? '-').padEnd(11),
      String(retry.failureCode ?? '-').padEnd(11),
      String(retry.retryId).slice(0, 8).padEnd(11),
      String(retry.started).padEnd(11),
      String(retry.model ?? '-').slice(0, 10).padEnd(11),
    ].join(' '))
  }
}

async function cmdParse(options) {
  const file = resolveSessionArgument(options._[1] ?? 'latest', options)
  const parsed = parseSessionFile(file)
  const { header, events, frames, tornStart } = parsed
  const counts = summarizeEvents(events)
  const { retries } = extractRetryChain(events)
  if (options.json === true) {
    console.log(JSON.stringify({
      file,
      header,
      frames,
      tornStart,
      counts,
      retries,
      turnEnds: [...turnOutcomes(events).values()].map((event) => ({ turn: event.data.turn, reason: event.data.reason, seq: event.seq })),
    }, null, 2))
    return
  }
  console.log(`file: ${file}`)
  console.log(`frames: ${frames}${tornStart === undefined ? '' : ` (torn tail at byte ${tornStart} ignored)`}`)
  console.log(`${sessionHeaderLine(header)}`)
  console.log(line())
  console.log('EVENT COUNTS')
  for (const [type, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(5)}  ${type}`)
  printRetryTable(retries)
  const outcomes = [...turnOutcomes(events).values()]
  if (outcomes.length > 0) {
    console.log(line())
    console.log('TURN OUTCOMES')
    for (const event of outcomes) console.log(`  turn ${event.data.turn}: ${JSON.stringify(event.data.reason)}`)
  }
  const invariants = validateRetryInvariants(events)
  console.log(line())
  console.log('FORMAT INVARIANTS (dsh-session-format-v3-to-v4 validator rules)')
  if (invariants.problems.length === 0) console.log(`  ${PASS}: every llm/retry is inside an open step, matches the open request/header provider, starts at retry 1 per chain, keeps a stable retryId`)
  else for (const problem of invariants.problems) console.log(`  [${problem.severity.toUpperCase()}] seq ${problem.seq ?? '?'}: ${problem.message}`)
}

async function cmdMock(options) {
  const mock = createMockProvider({
    port: options.port === undefined ? 8787 : Number(options.port),
    host: options.host === undefined ? '127.0.0.1' : String(options.host),
    plan: options.plan === undefined ? [] : String(options.plan).split(','),
    defaultStatus: options['default-status'] === undefined ? 500 : (/^\d{3}$/.test(String(options['default-status'])) ? Number(options['default-status']) : String(options['default-status'])),
    bodyDelayMs: options['body-delay-ms'] === undefined ? 0 : Number(options['body-delay-ms']),
    retryAfterSeconds: options['retry-after'] === undefined ? undefined : Number(options['retry-after']),
  })
  const info = await mock.listen()
  console.log(`[mock] listening ${info.origin}  (OpenAI baseURL ${info.baseURL})`)
  console.log('[mock] control: POST /__control {"plan":[500,500,"ok"],"defaultStatus":500}')
  console.log('[mock] observe: GET /__log  GET /__state   reset: POST /__reset')
  const shutdown = async () => {
    await mock.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function postControl(mockURL, body) {
  const base = String(mockURL).replace(/\/+$/, '')
  const response = await fetch(`${base}/__control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`control failed: HTTP ${response.status} ${await response.text()}`)
  return response.json()
}

async function cmdControl(options) {
  const mockURL = options.mock ?? 'http://127.0.0.1:8787'
  let body
  if (options.json !== undefined) body = JSON.parse(String(options.json))
  else {
    const scenario = scenarioById(options._[1])
    if (scenario === undefined) throw new Error('usage: control <scenario> | control --json \'{"plan":[...]}\'')
    body = scenarioControlBody(scenario)
  }
  const state = await postControl(mockURL, body)
  console.log(`[control] ${mockURL} -> ${JSON.stringify(state)}`)
}

function scenarioControlBody(scenario) {
  const body = {
    plan: scenario.plan ?? [],
    defaultStatus: scenario.defaultStatus ?? 500,
    retryAfterSeconds: scenario.retryAfterSeconds,
    resetLog: true,
    resetCursor: true,
  }
  if (body.retryAfterSeconds === undefined) delete body.retryAfterSeconds
  return body
}

function cmdRunbook(options) {
  const scenario = scenarioById(options._[1])
  if (scenario === undefined) throw new Error(`unknown scenario; try one of: ${SCENARIOS.map((item) => item.id).join(', ')}`)
  console.log(`SCENARIO ${scenario.id}: ${scenario.title}`)
  console.log(line())
  console.log('1) mock provider:')
  console.log(`   node verify/run.mjs mock --port 8787 --default-status ${scenario.defaultStatus ?? 500}`)
  console.log('2) apply this scenario plan (each run):')
  console.log(`   node verify/run.mjs control ${scenario.id}`)
  console.log('3) profile settings (Settings -> Models, or the model-retry settings section):')
  console.log(`   ${scenario.pluginConfig}`)
  console.log('4) in the Web GUI chat:')
  console.log(`   ${scenario.prompt}`)
  console.log('5) assert against the produced session log:')
  console.log(`   node verify/run.mjs assert ${scenario.id} --session latest --mock http://127.0.0.1:8787 --since-minutes 10`)
  console.log(line())
  console.log('expected:')
  for (const expected of scenario.expected) console.log(`  - ${expected}`)
}

function cmdScenarios() {
  for (const scenario of SCENARIOS) {
    console.log(`${scenario.id.padEnd(14)} ${scenario.title}`)
    for (const expected of scenario.expected) console.log(`  ${' '.repeat(15)}- ${expected}`)
  }
}

async function cmdAssert(options) {
  const scenario = scenarioById(options._[1])
  if (scenario === undefined) throw new Error(`unknown scenario; try one of: ${SCENARIOS.map((item) => item.id).join(', ')}`)
  const file = resolveSessionArgument(options.session, options)
  const parsed = parseSessionFile(file)
  const { header, events } = parsed
  const { retries } = extractRetryChain(events)
  const mockLog = await fetchMockLog(options.mock)

  console.log(`SCENARIO ${scenario.id}: ${scenario.title}`)
  console.log(`file: ${file}`)
  console.log(`session: ${header?.id ?? '(unknown)'}  events: ${events.length}  llm/retry: ${retries.length}`)
  const mockLine = mockLog === undefined
    ? 'mock log: not provided (--mock URL) — HTTP statuses/gaps unavailable, session events only'
    : `mock log: ${mockLog.requestCount} chat request(s) from ${options.mock}`
  console.log(mockLine)
  printlnIfAny(parsed)

  printAttemptTable(retries, mockLog)

  const invariants = validateRetryInvariants(events)
  const invariantChecks = [
    check(
      'session-format retry invariants (open step, provider match, sequence, retryId)',
      invariants.ok,
      'no violations',
      invariants.problems.length === 0 ? 'no violations' : `${invariants.problems.length} problem(s)`,
      invariants.problems.slice(0, 5).map((problem) => `seq ${problem.seq}: ${problem.message}`).join(' ; ') || undefined,
    ),
  ]

  const context = { retries, events, options, scenario, mockLog, header }
  const checks = [...invariantChecks, ...assertScenario(scenario, context)]

  if (options.json === true) {
    console.log(JSON.stringify({ scenario: scenario.id, file, checks }, null, 2))
  } else {
    console.log(line())
    const failed = printChecks(checks)
    process.exitCode = failed === 0 ? 0 : 1
  }
}

function printlnIfAny(parsed) {
  if (parsed.tornStart !== undefined) console.log(`WARNING: torn final frame at byte ${parsed.tornStart} (ignored; recoverable tail)`)
}

async function cmdWatch(options) {
  const mockURL = options.mock ?? 'http://127.0.0.1:8787'
  const scenario = options.scenario === undefined ? undefined : scenarioById(String(options.scenario))
  if (scenario !== undefined) {
    try {
      await postControl(mockURL, scenarioControlBody(scenario))
      console.log(`[watch] applied scenario plan "${scenario.id}" to ${mockURL}`)
    } catch (error) {
      console.log(`[watch] could not apply scenario plan to ${mockURL}: ${error.message}`)
    }
  }
  const sinceMinutes = Number(options['since-minutes'] ?? 15)
  const baseline = NOW() - sinceMinutes * 60_000
  console.log(`[watch] waiting for a session artifact modified after ${new Date(baseline).toISOString()} under ${options.root ?? sessionsRoot()}`)
  console.log('[watch] Ctrl+C to stop. Start the mock separately: node verify/run.mjs mock')
  let lastFile
  let lastSize = -1
  let stableSince = NOW()
  for (;;) {
    const file = latestSessionFile({ root: options.root, sinceMs: baseline })
    if (file !== undefined && file !== lastFile) {
      lastFile = file
      lastSize = -1
      stableSince = NOW()
      console.log(`[watch] new session artifact: ${file}`)
    }
    if (lastFile !== undefined) {
      const stat = await import('node:fs').then((fs) => fs.statSync(lastFile))
      if (stat.size !== lastSize) {
        lastSize = stat.size
        stableSince = NOW()
      } else if (NOW() - stableSince > 1500) {
        try {
          const parsed = parseSessionFile(lastFile)
          const { retries } = extractRetryChain(parsed.events)
          const outcomes = [...turnOutcomes(parsed.events).values()]
          const end = outcomes.at(-1)
          const done = end !== undefined && ['completed', 'error', 'aborted', 'blocked', 'max-tokens'].includes(turnEndKind(end))
          if (done) {
            console.log(line())
            console.log(`[watch] session settled: ${lastFile}`)
            console.log(`[watch] turn/end: ${JSON.stringify(end.data.reason)}  llm/retry: ${retries.length}`)
            if (options['assert'] === true && scenario !== undefined) {
              await cmdAssert({ ...options, _: ['assert', scenario.id], session: lastFile })
            } else {
              const mockLog = await fetchMockLog(options.mock)
              printAttemptTable(retries, mockLog)
            }
            return
          }
        } catch (error) {
          console.log(`[watch] parse failed (file may be mid-write): ${error.message}`)
        }
        stableSince = NOW()
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

async function cmdSelftest(options) {
  let failed = 0
  console.log('PARSER SELF-TEST (existing session artifacts under the real store)')
  const files = listSessionFiles(options.root ?? sessionsRoot())
  console.log(`found ${files.length} artifact(s); parsing the newest 25`)
  let parsedOk = 0
  let eventsTotal = 0
  let retriesTotal = 0
  let invariantFailures = 0
  for (const file of files.slice(0, 25)) {
    try {
      const parsed = parseSessionFile(file.path)
      parsedOk += 1
      eventsTotal += parsed.events.length
      const { retries } = extractRetryChain(parsed.events)
      retriesTotal += retries.length
      const invariants = validateRetryInvariants(parsed.events)
      if (!invariants.ok) {
        invariantFailures += 1
        console.log(`  [INFO] ${file.path}: ${invariants.problems.length} invariant note(s) (older logs may predate the plugin)`)
      }
    } catch (error) {
      failed += 1
      console.log(`  [${FAIL}] ${file.path}: ${error.message}`)
    }
  }
  console.log(`  parsed ${parsedOk}/${Math.min(25, files.length)} files, ${eventsTotal} events, ${retriesTotal} llm/retry events, ${invariantFailures} file(s) with retry-invariant notes`)
  if (parsedOk === 0) failed += 1

  console.log(line())
  console.log('ASSERTION SELF-TEST (synthetic event streams: every scenario assertion must pass, negative controls must fail)')
  failed += assertionSelfTest()

  console.log(line())
  console.log('MOCK SELF-TEST (OpenAI-compatible wire output + control API)')
  const mock = createMockProvider({ port: 0, quiet: true, plan: ['500', { status: 429, retryAfterSeconds: 7 }, 'ok'] })
  const info = await mock.listen()
  try {
    const first = await fetch(`${info.baseURL}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'mock-model', stream: true, messages: [] }) })
    console.log(`  error attempt: HTTP ${first.status} body=${(await first.text()).slice(0, 120)}`)
    failed += first.status === 500 ? 0 : 1
    const second = await fetch(`${info.baseURL}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'mock-model', stream: true, messages: [] }) })
    console.log(`  retry-after attempt: HTTP ${second.status} retry-after=${second.headers.get('retry-after')}`)
    failed += (second.status === 429 && second.headers.get('retry-after') === '7') ? 0 : 1
    const third = await fetch(`${info.baseURL}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'mock-model', stream: true, messages: [] }) })
    const thirdText = await third.text()
    const dataLines = thirdText.split('\n').filter((row) => row.startsWith('data: '))
    const parsedChunks = dataLines.filter((row) => row !== 'data: [DONE]').map((row) => JSON.parse(row.slice(6)))
    const hasText = parsedChunks.some((chunk) => chunk.choices?.[0]?.delta?.content === 'MOCK_OK')
    const hasDone = dataLines.includes('data: [DONE]')
    console.log(`  success attempt: HTTP ${third.status} chunks=${parsedChunks.length} text=${hasText} done=${hasDone}`)
    failed += third.status === 200 && hasText && hasDone ? 0 : 1
    const logResponse = await fetch(`${info.origin}/__log`)
    const log = await logResponse.json()
    console.log(`  control log: ${log.requestCount} request(s), gaps=${log.requests.map((record) => record.tSincePrevMs ?? '-').join(',')}`)
    failed += log.requestCount === 3 ? 0 : 1
  } finally {
    await mock.close()
  }
  console.log(line())
  console.log(failed === 0 ? `RESULT: ${PASS}` : `RESULT: ${FAIL} (${failed} failure(s))`)
  process.exitCode = failed === 0 ? 0 : 1
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2)
  const options = parseArgv(argv)
  const command = options._[0] ?? 'help'
  switch (command) {
    case 'list': cmdList(options); break
    case 'latest': cmdLatest(options); break
    case 'parse': await cmdParse(options); break
    case 'mock': await cmdMock(options); break
    case 'control': await cmdControl(options); break
    case 'runbook': cmdRunbook(options); break
    case 'scenarios': cmdScenarios(); break
    case 'assert': await cmdAssert(options); break
    case 'watch': await cmdWatch(options); break
    case 'selftest': await cmdSelftest(options); break
    case 'help':
    default:
      console.log('usage: node verify/run.mjs <command> [options]')
      console.log('  list | latest | parse <file|latest> | mock | control <scenario> | runbook <scenario> | scenarios | assert <scenario> | watch | selftest')
      console.log(`scenarios: ${SCENARIOS.map((scenario) => scenario.id).join(', ')}`)
      break
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`)
  if (process.env.DEBUG !== undefined) console.error(error.stack)
  process.exitCode = 2
})
