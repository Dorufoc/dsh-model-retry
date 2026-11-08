// verify/session-log.mjs
//
// Read + parse a DeepSeek Harness session log exactly as the shipped
// `@deepseek-ai/dsh-session-persistence-jsonl` backend stores it, and derive the
// retry-chain facts the verification harness asserts on.
//
// Evidence for the on-disk format (read out of the product asar):
//   <asar>/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/README.md:55-77
//     - root/<--normalized-cwd-->/<encoded-session-id>/session.vN.jsonl.zstd
//     - "standard concatenation of independent Zstandard frames: one checksummed
//        frame containing only the header line, then one checksummed frame per
//        durable append batch"
//   .../dsh-session-persistence-jsonl/lib/index.js:1305-1368  scanZstdFrames()
//   .../dsh-session-persistence-jsonl/lib/index.js:1286-1402 zstd.js region
//   .../dsh-session/lib/index.js:56                            SESSION_FORMAT_VERSION = 4
//
// Node's zstd one-shot API stops at the first frame, so the file must be split
// into frames structurally and decompressed frame by frame (the public fallback
// the backend itself uses: PublicZstdFrameDecoder, lib/index.js:1252-1284).
//
// No npm dependencies. Use the bundled plain Node:
//   %DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

// Zstandard frame magic read as a little-endian uint32: bytes 28 B5 2F FD -> 0xFD2FB528.
const ZSTD_MAGIC = 0xfd2fb528

/** Root directory of the session-log store: %DSH_HOME%/sessions (DSH_HOME defaults to ~/.dsh). */
export function sessionsRoot() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'sessions')
}

/**
 * Structurally locate complete Zstandard frames in a concatenated-frame file.
 * Mirrors the backend scanner (dsh-session-persistence-jsonl/lib/index.js:1305).
 * @param {Buffer} buffer complete bytes of the artifact
 * @param {number} [maxFrames]
 * @returns {{frames: Array<{start:number,end:number}>, tornStart?: number}}
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt session log: invalid Zstandard frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`corrupt session log: reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`corrupt session log: reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/**
 * Decode one session artifact to UTF-8 JSONL text.
 * Handles the zstd concatenated-frame container and the plain `.jsonl`
 * (`compression: 'none'`) variant.
 * @param {string} file
 * @returns {{text: string, frames: number, tornStart?: number}}
 */
export function decodeSessionText(file) {
  const buffer = fs.readFileSync(file)
  if (!file.endsWith('.zstd')) return { text: buffer.toString('utf8'), frames: 0 }
  const { frames, tornStart } = scanZstdFrames(buffer)
  let text = ''
  for (const { start, end } of frames) {
    text += zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
  }
  return tornStart === undefined ? { text, frames: frames.length } : { text, frames: frames.length, tornStart }
}

/**
 * Parse one session artifact into its header row plus ordered events.
 * @param {string} file
 * @returns {{file: string, header: object|undefined, events: Array<{type:string,seq:number,time:number,data:any}>, frames: number, tornStart?: number}}
 */
export function parseSessionFile(file) {
  const { text, frames, tornStart } = decodeSessionText(file)
  const rows = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      rows.push(JSON.parse(trimmed))
    } catch (error) {
      throw new Error(`${file}: unparsable JSONL row: ${error.message}`)
    }
  }
  let header
  const events = []
  for (const row of rows) {
    if (row.type === 'session') header = row
    else events.push(row)
  }
  events.sort((a, b) => a.seq - b.seq)
  return { file, header, events, frames, tornStart }
}

/** Every plausible session artifact under a root, newest first (mtime). */
export function listSessionFiles(root = sessionsRoot()) {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && /^session(\.[^.]*)?\.jsonl(\.zstd)?$/.test(entry.name)) {
        const stat = fs.statSync(full)
        out.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs, name: entry.name })
      }
    }
  }
  walk(root)
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

/**
 * Pick the newest session artifact, optionally filtered.
 * @param {{root?: string, sinceMs?: number, excludeSessionIds?: string[]}} [options]
 */
export function latestSessionFile(options = {}) {
  const root = options.root ?? sessionsRoot()
  const exclude = new Set(options.excludeSessionIds ?? [])
  for (const candidate of listSessionFiles(root)) {
    if (options.sinceMs !== undefined && candidate.mtimeMs < options.sinceMs) continue
    const id = path.basename(path.dirname(candidate.path))
    if (exclude.has(id)) continue
    return candidate.path
  }
  return undefined
}

/** Decode the session identity out of a file path (`.../<cwd-dir>/<id>/session.vN.jsonl.zstd`). */
export function sessionIdOfFile(file) {
  return path.basename(path.dirname(file))
}

/** Latest `request/header` event at or before a seq, for route attribution. */
function headerBefore(events, seq) {
  let best
  for (const event of events) {
    if (event.seq > seq) break
    if (event.type === 'request/header') best = event
  }
  return best
}

/** Latest `request/context` event at or before a seq. */
function contextBefore(events, seq) {
  let best
  for (const event of events) {
    if (event.seq > seq) break
    if (event.type === 'request/context') best = event
  }
  return best
}

/** Which steps are open at a seq: map of `${turn}:${step}` -> {turn, step, startSeq, endSeq?}. */
export function stepIndex(events) {
  const steps = new Map()
  let turn
  for (const event of events) {
    switch (event.type) {
      case 'turn/start': turn = event.data.turn; break
      case 'turn/end': turn = undefined; break
      case 'step/start': {
        const key = `${event.data.turn}:${event.data.step}`
        steps.set(key, { turn: event.data.turn, step: event.data.step, startSeq: event.seq, endSeq: undefined })
        break
      }
      case 'step/end': {
        const key = `${event.data.turn}:${event.data.step}`
        const found = steps.get(key)
        if (found !== undefined) found.endSeq = event.seq
        break
      }
      default: break
    }
  }
  return steps
}

/** Open step at one seq, or undefined. */
export function openStepAt(steps, seq) {
  for (const step of steps.values()) {
    if (step.startSeq <= seq && (step.endSeq === undefined || step.endSeq > seq)) return step
  }
  return undefined
}

/**
 * Normalize the retry-chain facts out of a session event list.
 *
 * Each entry joins one `llm/retry` (scheduled attempt) with its
 * `llm/retry-started` (the attempt actually began) and the route the session
 * log had recorded at that point.
 * @param {Array<object>} events
 */
export function extractRetryChain(events) {
  const steps = stepIndex(events)
  const retries = []
  const startsByKey = new Map()
  for (const event of events) {
    if (event.type !== 'llm/retry-started') continue
    startsByKey.set(`${event.data.retryId}\u0000${event.data.retry}`, event)
  }
  for (const event of events) {
    if (event.type !== 'llm/retry') continue
    const data = event.data
    const start = startsByKey.get(`${data.retryId}\u0000${data.retry}`)
    const header = headerBefore(events, event.seq)
    const context = contextBefore(events, event.seq)
    const step = openStepAt(steps, event.seq)
    const provider = data.provider
    const headerProvider = header?.data?.header?.config?.provider
    const headerModel = header?.data?.header?.config?.model
    const model = context?.data?.provider === provider ? context.data.model : headerModel
    retries.push({
      seq: event.seq,
      timeMs: event.time,
      retryId: data.retryId,
      turn: data.turn,
      step: data.step,
      provider,
      mode: data.mode,
      policyKey: data.policyKey,
      retry: data.retry,
      maxRetries: data.maxRetries,
      delayMs: data.delayMs,
      failureCode: data.failure?.code,
      failureMessage: data.failure?.message,
      providerRetryAfterMs: data.failure?.providerRetryAfterMs,
      model,
      headerProvider,
      startSeq: start?.seq,
      startTimeMs: start?.time,
      started: start !== undefined,
      openStep: step !== undefined,
    })
  }
  retries.sort((a, b) => a.seq - b.seq)
  return { retries, steps }
}

/** turn/end outcomes keyed by turn. */
export function turnOutcomes(events) {
  const outcomes = new Map()
  for (const event of events) {
    if (event.type === 'turn/end') outcomes.set(event.data.turn, event)
  }
  return outcomes
}

/** Basic counters used by the table output. */
export function summarizeEvents(events) {
  const counts = {}
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1
  return counts
}

/**
 * Validate the retry invariants the session-format migrations enforce.
 * Authority: dsh-session-format-v3-to-v4/lib/index.js:676-699 and
 * dsh-session-format-v0-to-v1/lib/index.js:2407-2424,2504-2513.
 * @param {Array<object>} events
 * @returns {{ok: boolean, problems: Array<{severity:'error'|'warn', message:string, seq?:number}>}}
 */
export function validateRetryInvariants(events) {
  const problems = []
  const steps = stepIndex(events)
  const { retries } = extractRetryChain(events)

  // 1. Coordinates: the retry belongs to the open step.
  for (const retry of retries) {
    const step = openStepAt(steps, retry.seq)
    if (step === undefined) {
      problems.push({ severity: 'error', seq: retry.seq, message: `llm/retry turn ${retry.turn} step ${retry.step} is not inside an open step` })
      continue
    }
    if (step.turn !== retry.turn || step.step !== retry.step) {
      problems.push({ severity: 'error', seq: retry.seq, message: `llm/retry coordinates ${retry.turn}/${retry.step} differ from the open step ${step.turn}/${step.step}` })
    }
    // 2. Provider equals the open request/header provider.
    if (retry.headerProvider !== undefined && retry.provider !== retry.headerProvider) {
      problems.push({ severity: 'error', seq: retry.seq, message: `llm/retry provider "${retry.provider}" differs from open request/header provider "${retry.headerProvider}"` })
    }
    if (retry.headerProvider === undefined) {
      problems.push({ severity: 'error', seq: retry.seq, message: 'llm/retry has no preceding request/header' })
    }
    // 3. Released payload shape.
    if (retry.mode === 'normal' && !Number.isInteger(retry.maxRetries)) {
      problems.push({ severity: 'error', seq: retry.seq, message: 'normal-mode llm/retry is missing integer maxRetries' })
    }
    if (retry.mode === 'always' && retry.maxRetries !== undefined) {
      problems.push({ severity: 'error', seq: retry.seq, message: 'always-mode llm/retry must omit maxRetries' })
    }
    if (retry.mode !== 'normal' && retry.mode !== 'always') {
      problems.push({ severity: 'error', seq: retry.seq, message: `llm/retry has unknown mode "${String(retry.mode)}"` })
    }
    if (typeof retry.retryId !== 'string' || retry.retryId.length === 0) {
      problems.push({ severity: 'error', seq: retry.seq, message: 'llm/retry retryId must be a non-empty string' })
    }
    if (!Number.isInteger(retry.retry) || retry.retry < 1) {
      problems.push({ severity: 'error', seq: retry.seq, message: `llm/retry retry must be an integer >= 1 (got ${String(retry.retry)})` })
    }
    if (!Number.isFinite(retry.delayMs) || retry.delayMs < 0) {
      problems.push({ severity: 'error', seq: retry.seq, message: `llm/retry delayMs must be a non-negative finite number (got ${String(retry.delayMs)})` })
    }
    if (retry.providerRetryAfterMs !== undefined && (!Number.isFinite(retry.providerRetryAfterMs) || retry.providerRetryAfterMs <= 0)) {
      problems.push({ severity: 'error', seq: retry.seq, message: 'llm/retry failure.providerRetryAfterMs must be a positive finite number when present' })
    }
    // 4. Started pairs a scheduled attempt with the same coordinates.
    if (retry.started) {
      const startEvent = events.find((event) => event.seq === retry.startSeq)
      const startKey = startEvent !== undefined ? `${startEvent.data.retryId}\u0000${startEvent.data.retry}` : undefined
      if (startKey !== `${retry.retryId}\u0000${retry.retry}`) {
        problems.push({ severity: 'error', seq: retry.startSeq, message: 'llm/retry-started does not pair this scheduled attempt' })
      }
    }
  }

  // 5. Sequence + identity per policy chain.
  const chains = new Map()
  for (const retry of retries) {
    const key = JSON.stringify([retry.turn, retry.step, retry.provider, retry.policyKey])
    const list = chains.get(key) ?? []
    list.push(retry)
    chains.set(key, list)
  }
  const firstRetryIdByStep = new Map()
  for (const [key, list] of chains) {
    const [turn, step, provider, policyKey] = JSON.parse(key)
    list.sort((a, b) => a.retry - b.retry)
    let expected = 1
    for (const item of list) {
      if (item.retry !== expected) {
        problems.push({ severity: 'error', seq: item.seq, message: `chain turn ${turn} step ${step} provider ${provider} skips retry ${expected} (got ${item.retry})` })
      }
      expected = item.retry + 1
      if (item.retryId !== list[0].retryId) {
        problems.push({ severity: 'error', seq: item.seq, message: `chain turn ${turn} step ${step} changes retryId (${list[0].retryId} -> ${item.retryId})` })
      }
    }
    // 6. retryId changes between steps (a new chain per step must not reuse an id).
    const stepKey = `${turn}:${step}`
    const first = list[0]
    const registered = firstRetryIdByStep.get(stepKey)
    if (registered === undefined) firstRetryIdByStep.set(stepKey, new Set([first.retryId]))
    else registered.add(first.retryId)
    void policyKey
  }
  for (const [stepKey, ids] of firstRetryIdByStep) ids.size // keep lint quiet
  // A retryId must not be reused by a *later* step of the same session.
  const retryIdOwners = new Map()
  for (const retry of retries) {
    const stepKey = `${retry.turn}:${retry.step}`
    const owner = retryIdOwners.get(retry.retryId)
    if (owner === undefined) retryIdOwners.set(retry.retryId, stepKey)
    else if (owner !== stepKey) {
      problems.push({ severity: 'error', seq: retry.seq, message: `retryId ${retry.retryId} is reused across steps ${owner} and ${stepKey}` })
    }
  }

  return { ok: !problems.some((problem) => problem.severity === 'error'), problems }
}
