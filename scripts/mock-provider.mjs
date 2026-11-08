// verify/mock-provider.mjs
//
// A tiny, scriptable OpenAI-compatible provider for verifying the
// dsh-model-retry plugin without a real outage.
//
// It serves just enough of the OpenAI wire protocol for
// `@deepseek-ai/dsh-llm-pi-ai` with `api: openai-completions`:
//   GET  /v1/models                -> { object:"list", data:[{id,...}] }
//   POST /v1/chat/completions      -> SSE chat.completion.chunk stream, or an HTTP error
//
// Scenarios are driven through a control API (no restart needed):
//   POST /__control   { plan, defaultStatus, bodyDelayMs, retryAfterSeconds }
//   GET  /__state     current config + plan cursor
//   GET  /__log       every /v1/chat/completions request with timestamps
//   POST /__reset     clear log, reset plan cursor
//
// Plan entry forms (consumed one per /v1/chat/completions request):
//   500 | "500" | "503" | "429"   -> HTTP error with that status
//   "ok"                          -> successful SSE answer with text
//   "empty"                       -> successful SSE with NO content (driver maps to EMPTY_RESPONSE)
//   { mode:"tool", toolName, arguments } -> SSE with one tool_calls delta, finish_reason "tool_calls"
//   { status:429, retryAfterSeconds:7, body:{...}, delayMs:250 }
//   { mode:"ok", text:"...", delayMs:250, status:200 }
// When the plan is exhausted, `defaultStatus` decides (error status, "ok", "empty"; default 500).
//
// Usage:
//   $node verify/mock-provider.mjs --port 8787 --default-status 500
//   $node verify/mock-provider.mjs --port 8787 --plan 500,500,ok
//
// No npm dependencies.

import http from 'node:http'
import { pathToFileURL } from 'node:url'

const CHAT_PATH = '/v1/chat/completions'
const MODELS_PATH = '/v1/models'
const DONE = 'data: [DONE]\n\n'

function nowMs() {
  return Date.now()
}

function sseChunk(model, payload) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    ...payload,
  })}\n\n`
}

function parsePlanEntry(entry) {
  if (typeof entry === 'number') return { kind: 'error', status: entry }
  if (typeof entry === 'string') {
    const trimmed = entry.trim()
    if (/^\d{3}$/.test(trimmed)) return { kind: 'error', status: Number(trimmed) }
    if (trimmed === 'ok' || trimmed === 'text' || trimmed === 'success') return { kind: 'ok' }
    if (trimmed === 'empty') return { kind: 'empty' }
    throw new Error(`mock: unknown plan entry "${entry}" (expected a 3-digit status, "ok", "empty", or an object)`)
  }
  if (entry !== null && typeof entry === 'object') {
    const mode = entry.mode ?? (entry.status !== undefined && Number(entry.status) >= 400 ? 'error' : undefined)
    if (entry.toolName !== undefined || mode === 'tool') {
      return {
        kind: 'tool',
        toolName: entry.toolName ?? 'mock_tool',
        arguments: entry.arguments ?? '{}',
        delayMs: entry.delayMs ?? 0,
        text: entry.text,
      }
    }
    if (mode === 'empty') return { kind: 'empty', delayMs: entry.delayMs ?? 0 }
    if (mode === 'ok') return { kind: 'ok', text: entry.text, delayMs: entry.delayMs ?? 0 }
    if (entry.status !== undefined && Number(entry.status) >= 400) {
      return {
        kind: 'error',
        status: Number(entry.status),
        retryAfterSeconds: entry.retryAfterSeconds,
        body: entry.body,
        message: entry.message,
        delayMs: entry.delayMs ?? 0,
      }
    }
    return { kind: 'ok', text: entry.text, delayMs: entry.delayMs ?? 0, status: entry.status }
  }
  throw new Error(`mock: unsupported plan entry ${JSON.stringify(entry)}`)
}

function errorBody(entry) {
  if (entry.body !== undefined) return JSON.stringify(entry.body)
  const status = entry.status
  // The message carries the numeric status on purpose: dsh-llm-pi-ai derives the
  // harness failure code from the pi-ai error TEXT (classifyPiAiError,
  // dsh-llm-pi-ai/lib/index.js:1448-1459), so "500"/"429" must appear.
  const label = status === 429 ? 'RATE_LIMIT' : status >= 500 ? 'SERVER' : 'MOCK_ERROR'
  return JSON.stringify({
    error: {
      message: entry.message ?? `mock upstream ${status} ${label} failure`,
      type: 'mock_error',
      code: `mock_${status}`,
    },
  })
}

function errorResponse(res, entry, attempt) {
  const headers = { 'content-type': 'application/json' }
  const retryAfterSeconds = entry.retryAfterSeconds
  if (retryAfterSeconds !== undefined && retryAfterSeconds !== null && Number(retryAfterSeconds) > 0) {
    // HTTP standard form for both 429 and 503; seconds resolution.
    headers['retry-after'] = String(Math.ceil(Number(retryAfterSeconds)))
  }
  res.writeHead(entry.status, headers)
  res.end(errorBody(entry))
  return { status: entry.status, response: 'error', attempt }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

function writeSse(res, chunk) {
  res.write(chunk)
}

async function successResponse(res, entry, model, attempt) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-mock-attempt': String(attempt),
  })
  res.flushHeaders?.()
  const text = entry.text ?? 'MOCK_OK'
  // role delta
  writeSse(res, sseChunk(model, { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }))
  if (entry.kind !== 'empty') {
    const delta = entry.kind === 'tool'
      ? {
        tool_calls: [{
          index: 0,
          id: `call_mock_${attempt}`,
          type: 'function',
          function: { name: entry.toolName, arguments: entry.arguments },
        }],
      }
      : { content: text }
    writeSse(res, sseChunk(model, { choices: [{ index: 0, delta, finish_reason: null }] }))
  }
  // finish delta
  const finishReason = entry.kind === 'tool' ? 'tool_calls' : 'stop'
  writeSse(res, sseChunk(model, { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }))
  // usage chunk (choices empty) then [DONE]
  writeSse(res, sseChunk(model, {
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: entry.kind === 'empty' ? 0 : text.length, total_tokens: 12 + (entry.kind === 'empty' ? 0 : text.length) },
  }))
  res.write(DONE)
  res.end()
  return { status: 200, response: entry.kind, attempt }
}

/**
 * Create the mock server.
 * @param {{
 *   port?: number,
 *   host?: string,
 *   plan?: any[],
 *   defaultStatus?: number|'ok'|'empty',
 *   bodyDelayMs?: number,
 *   retryAfterSeconds?: number,
 *   successText?: string,
 *   quiet?: boolean,
 * }} [options]
 */
export function createMockProvider(options = {}) {
  const state = {
    plan: (options.plan ?? []).map(parsePlanEntry),
    defaultStatus: options.defaultStatus ?? 500,
    bodyDelayMs: options.bodyDelayMs ?? 0,
    retryAfterSeconds: options.retryAfterSeconds,
    successText: options.successText ?? 'MOCK_OK',
    cursor: 0,
    requests: [],
    startedAt: nowMs(),
  }

  const sockets = new Set()

  function logRequest(entry) {
    const previous = state.requests.at(-1)
    const record = {
      n: state.requests.length + 1,
      at: entry.at ?? nowMs(),
      atIso: new Date(entry.at ?? nowMs()).toISOString(),
      tSincePrevMs: previous === undefined ? undefined : (entry.at ?? nowMs()) - previous.at,
      method: entry.method,
      path: entry.path,
      model: entry.model,
      planIndex: entry.planIndex,
      planEntry: entry.planEntry,
      status: entry.status,
      retryAfterSeconds: entry.retryAfterSeconds,
      responseKind: entry.responseKind,
      durationMs: entry.durationMs,
    }
    state.requests.push(record)
    if (!options.quiet) {
      const parts = [`[mock] #${record.n}`, record.method, record.path]
      if (record.model !== undefined) parts.push(`model=${record.model}`)
      if (record.planEntry !== undefined) parts.push(`plan=${JSON.stringify(record.planEntry)}`)
      parts.push(`status=${record.status}`)
      if (record.retryAfterSeconds !== undefined) parts.push(`retry-after=${record.retryAfterSeconds}s`)
      if (record.tSincePrevMs !== undefined) parts.push(`gap=${record.tSincePrevMs}ms`)
      console.log(parts.join(' '))
    }
    return record
  }

  function nextEntry() {
    if (state.cursor < state.plan.length) {
      const entry = state.plan[state.cursor]
      state.cursor += 1
      return entry
    }
    const fallback = state.defaultStatus
    if (fallback === 'ok') return { kind: 'ok', text: state.successText }
    if (fallback === 'empty') return { kind: 'empty' }
    const status = typeof fallback === 'number' ? fallback : Number(fallback)
    if (!Number.isInteger(status)) throw new Error(`mock: invalid defaultStatus ${JSON.stringify(fallback)}`)
    return { kind: 'error', status, retryAfterSeconds: state.retryAfterSeconds }
  }

  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (text.length === 0) return resolve(undefined)
        try {
          resolve(JSON.parse(text))
        } catch {
          resolve(text)
        }
      })
    })
  }

  function json(res, status, value) {
    const text = JSON.stringify(value, null, 2)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(text)
  }

  async function handleControl(req, res, url) {
    if (url.pathname === '/__state') return json(res, 200, {
      plan: state.plan,
      defaultStatus: state.defaultStatus,
      bodyDelayMs: state.bodyDelayMs,
      retryAfterSeconds: state.retryAfterSeconds,
      successText: state.successText,
      cursor: state.cursor,
      requestCount: state.requests.length,
      startedAt: state.startedAt,
      startedAtIso: new Date(state.startedAt).toISOString(),
    })
    if (url.pathname === '/__log') return json(res, 200, {
      requestCount: state.requests.length,
      requests: state.requests,
    })
    if (url.pathname === '/__control' && req.method === 'POST') {
      const body = await readBody(req)
      if (body === undefined || typeof body !== 'object') return json(res, 400, { error: 'control body must be JSON' })
      if (body.plan !== undefined) {
        state.plan = body.plan.map(parsePlanEntry)
        state.cursor = 0
      }
      if (body.defaultStatus !== undefined) state.defaultStatus = body.defaultStatus
      if (body.bodyDelayMs !== undefined) state.bodyDelayMs = Number(body.bodyDelayMs)
      if (body.retryAfterSeconds !== undefined) state.retryAfterSeconds = Number(body.retryAfterSeconds)
      if (body.successText !== undefined) state.successText = String(body.successText)
      if (body.resetLog === true) state.requests = []
      if (body.resetCursor === true) state.cursor = 0
      return json(res, 200, {
        ok: true,
        plan: state.plan,
        defaultStatus: state.defaultStatus,
        bodyDelayMs: state.bodyDelayMs,
        retryAfterSeconds: state.retryAfterSeconds,
        cursor: state.cursor,
      })
    }
    if (url.pathname === '/__reset' && req.method === 'POST') {
      state.requests = []
      state.cursor = 0
      return json(res, 200, { ok: true, requestCount: 0, cursor: 0 })
    }
    return json(res, 404, { error: `unknown control endpoint ${url.pathname}` })
  }

  async function handleChat(req, res) {
    const startedAt = nowMs()
    const body = await readBody(req)
    const model = body?.model ?? 'mock-model'
    const entry = nextEntry()
    const delayMs = Math.max(0, Number(state.bodyDelayMs) || 0) + Math.max(0, Number(entry.delayMs) || 0)
    if (delayMs > 0) await sleep(delayMs)
    let result
    const attempt = state.requests.length + 1
    if (entry.kind === 'error') {
      result = errorResponse(res, entry, attempt)
    } else {
      result = await successResponse(res, entry, model, attempt)
    }
    logRequest({
      at: startedAt,
      method: req.method,
      path: CHAT_PATH,
      model,
      planIndex: state.cursor - 1,
      planEntry: entry.kind,
      status: result.status,
      retryAfterSeconds: entry.retryAfterSeconds ?? (entry.kind === 'error' ? state.retryAfterSeconds : undefined),
      responseKind: result.response,
      durationMs: nowMs() - startedAt,
    })
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname.startsWith('/__')) {
      handleControl(req, res, url).catch((error) => json(res, 500, { error: error.message }))
      return
    }
    if (url.pathname === MODELS_PATH) {
      json(res, 200, {
        object: 'list',
        data: [{ id: 'mock-model', object: 'model', owned_by: 'mock' }],
      })
      return
    }
    if (url.pathname === CHAT_PATH && req.method === 'POST') {
      handleChat(req, res).catch((error) => {
        try {
          json(res, 500, { error: `mock internal error: ${error.message}` })
        } catch {
          // response already started; nothing to do
        }
      })
      return
    }
    json(res, 404, { error: `mock: unsupported route ${req.method} ${url.pathname}` })
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  return {
    server,
    state,
    async listen() {
      const port = options.port ?? 8787
      const host = options.host ?? '127.0.0.1'
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      const address = server.address()
      return {
        port: address.port,
        host,
        baseURL: `http://${host}:${address.port}/v1`,
        origin: `http://${host}:${address.port}`,
      }
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    switch (token) {
      case '--port': options.port = Number(argv[++index]); break
      case '--host': options.host = argv[++index]; break
      case '--plan': {
        const raw = argv[++index] ?? ''
        options.plan = raw.length === 0 ? [] : raw.split(',').map((part) => {
          const trimmed = part.trim()
          if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
          if (trimmed.startsWith('{')) return JSON.parse(trimmed)
          return trimmed
        })
        break
      }
      case '--default-status': {
        const raw = argv[++index] ?? '500'
        options.defaultStatus = /^\d{3}$/.test(raw) ? Number(raw) : raw
        break
      }
      case '--body-delay-ms': options.bodyDelayMs = Number(argv[++index]); break
      case '--retry-after': options.retryAfterSeconds = Number(argv[++index]); break
      case '--success-text': options.successText = argv[++index]; break
      case '--quiet': options.quiet = true; break
      default: break
    }
  }
  return options
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const options = parseArgs(process.argv.slice(2))
  const mock = createMockProvider(options)
  const info = await mock.listen()
  console.log(`[mock] listening ${info.origin}  (OpenAI baseURL ${info.baseURL})`)
  console.log('[mock] control: POST /__control {"plan":[500,500,"ok"],"defaultStatus":500,"retryAfterSeconds":null,"bodyDelayMs":0}')
  console.log('[mock] observe: GET /__log  GET /__state   reset: POST /__reset')
  const shutdown = async () => {
    await mock.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
