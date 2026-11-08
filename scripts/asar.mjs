#!/usr/bin/env node
// Minimal Electron asar reader: list entries, print one file, or grep inside the archive.
// The archive is a normal file on disk, so a plain Node process can parse it.
//
//   node scripts/asar.mjs list  <prefix>
//   node scripts/asar.mjs cat   <path>
//   node scripts/asar.mjs grep  <regex> [prefix] [--files-only]
//
// The archive defaults to the Windows Desktop install. Override it with
// DSH_ASAR=/absolute/path/to/app.asar (macOS and Linux installs differ).
import { existsSync } from 'node:fs'
import { readFileSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'

const ARCHIVE =
  process.env.DSH_ASAR ??
  join(
    process.env.LOCALAPPDATA ?? process.env.HOME ?? '.',
    'Programs',
    'DeepSeek Harness',
    'resources',
    'app.asar',
  )

if (!existsSync(ARCHIVE)) {
  console.error(`asar archive not found: ${ARCHIVE}`)
  console.error('Set DSH_ASAR to the app.asar of your DeepSeek Harness installation.')
  process.exit(2)
}

const fd = openSync(ARCHIVE, 'r')
const head = Buffer.alloc(16)
readSync(fd, head, 0, 16, 0)
// Chromium Pickle: [0]=4, [4]=total header pickle size, [8]=header payload size,
// [12]=JSON string length, [16..]=JSON text.
const headerSize = head.readUInt32LE(4)
const jsonLength = head.readUInt32LE(12)
const jsonBuf = Buffer.alloc(jsonLength)
readSync(fd, jsonBuf, 0, jsonLength, 16)
const baseOffset = 8 + headerSize
const tree = JSON.parse(jsonBuf.toString('utf8'))

function walk(node, prefix, out) {
  if (!node || typeof node !== 'object') return
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      const path = prefix ? `${prefix}/${name}` : name
      if (child && child.files) walk(child, path, out)
      else out.push({ path, size: child?.size ?? 0, offset: child?.offset })
    }
  }
}
const entries = []
walk(tree, '', entries)
entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
const byPath = new Map(entries.map((e) => [e.path, e]))

function readEntry(entry) {
  if (entry.offset === undefined) return Buffer.alloc(0)
  const buf = Buffer.alloc(entry.size)
  readSync(fd, buf, 0, entry.size, baseOffset + Number(entry.offset))
  return buf
}

const [, , cmd, ...rest] = process.argv

if (cmd === 'list') {
  const prefix = rest[0] ?? ''
  for (const e of entries) if (e.path.startsWith(prefix)) console.log(`${e.size}\t${e.path}`)
  console.log(`# ${entries.length} entries total`)
} else if (cmd === 'cat') {
  const target = rest[0]
  const entry = byPath.get(target) ?? byPath.get(target.replace(/^\//, ''))
  if (!entry) {
    console.error(`not found: ${target}`)
    process.exit(2)
  }
  process.stdout.write(readEntry(entry))
} else if (cmd === 'grep') {
  const pattern = new RegExp(rest[0], 'g')
  const prefix = rest.find((a, i) => i > 0 && !a.startsWith('--')) ?? ''
  const filesOnly = rest.includes('--files-only')
  for (const e of entries) {
    if (!e.path.startsWith(prefix)) continue
    if (e.size > 4_000_000) continue
    const text = readEntry(e).toString('utf8')
    if (!pattern.test(text)) continue
    pattern.lastIndex = 0
    if (filesOnly) {
      console.log(e.path)
      continue
    }
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      pattern.lastIndex = 0
      if (pattern.test(line)) console.log(`${e.path}:${i + 1}:${line}`)
    })
  }
} else {
  console.error('usage: asar.mjs list|cat|grep ...')
  process.exit(1)
}
closeSync(fd)
