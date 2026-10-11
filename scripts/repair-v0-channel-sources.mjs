#!/usr/bin/env node
/**
 * Repair pre-0.2.1 session logs that carry this repo's `channel` message
 * sources, so dsh 0.2.1's v0→v4 log migration can run.
 *
 * Background: dsh-session-persistence-jsonl@0.2.1 hardcodes a SOURCE_KINDS
 * whitelist for the v0 migration chain; our contract's `kind:'channel'`
 * (dsh-channel-design §3.2) is not on it, so resuming any rc.2-era channel
 * session fails with `cannot safely transform unclassified message source`.
 * The CURRENT v4 format admits producer-owned kinds fine — only the old
 * artifact's sources need re-shaping. v0 admits `kind:'plugin'`, and the
 * official v3→v4 step lifts `{kind:'plugin', plugin:'dsh-channel', …}` to
 * `{kind:'plugin:dsh-channel', …}` preserving every other field — so we
 * rewrite channel sources into that plugin shape and let the stock
 * migrator do the rest. No dsh code is touched.
 *
 * Usage:
 *   node scripts/repair-v0-channel-sources.mjs <session.jsonl.zstd> [--write]
 *   node scripts/repair-v0-channel-sources.mjs --root <sessions-dir> [--write]
 *
 * Default is a dry run (report only). --write backs the original up as
 * session.jsonl.zstd.bak-<timestamp> before rewriting. The file must decode
 * as a single zstd frame; anything else is left untouched.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { copyFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const args = process.argv.slice(2)
const write = args.includes('--write')
const rootIndex = args.indexOf('--root')
const targets = []

if (rootIndex !== -1) {
  const root = args[rootIndex + 1]
  if (root === undefined) {
    console.error('--root requires a directory')
    process.exit(1)
  }
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === 'session.jsonl.zstd') targets.push(path)
    }
  }
  walk(root)
} else {
  const path = args.find((arg) => !arg.startsWith('--'))
  if (path === undefined) {
    console.error('usage: repair-v0-channel-sources.mjs <session.jsonl.zstd | --root <dir>> [--write]')
    process.exit(1)
  }
  targets.push(path)
}

/** Rewrite every `{kind:'channel', …}` source into the v0-admitted plugin shape.
 *
 * v0→v1's `pluginSourceValue` admits ONLY `{kind, plugin}` (+fixed optional
 * members), so the channel metadata (chatKey/senderId/messageIds) cannot
 * survive the repair — it is dropped from the MIGRATED HISTORY only. Runtime
 * impact is bounded: the bridge's idempotency fold keys on `kind:'channel'`
 * messages, which post-migration history no longer is, and the store's TTL
 * dedupe still covers the recent window. New v4 logs written by 0.2.1 keep
 * full `kind:'channel'` sources (v4 admission is producer-kind friendly).
 */
function rewriteChannelSources(value, stats) {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteChannelSources(item, stats))
  }
  if (value === null || typeof value !== 'object') return value
  const source = value
  if (source.kind === 'channel' && typeof source.channel === 'string') {
    stats.rewritten += 1
    return { kind: 'plugin', plugin: 'dsh-channel' }
  }
  const out = {}
  for (const [key, item] of Object.entries(source)) out[key] = rewriteChannelSources(item, stats)
  return out
}

let anyFailed = false
let anyRepaired = false

for (const path of targets) {
  const label = basename(dirname(path))
  let text
  try {
    text = zstdDecompressSync(readFileSync(path)).toString('utf8')
  } catch (error) {
    console.log(`⏭️  ${label}: not a single-frame zstd artifact, left untouched (${error instanceof Error ? error.message.split('\n')[0] : 'decode failed'})`)
    anyFailed = true
    continue
  }

  const lines = text.split('\n')
  const trailingNewline = lines[lines.length - 1] === ''
  const body = trailingNewline ? lines.slice(0, -1) : lines
  if (body.length === 0) {
    console.log(`⏭️  ${label}: empty artifact, left untouched`)
    continue
  }

  let header
  try {
    header = JSON.parse(body[0])
  } catch {
    console.log(`⏭️  ${label}: unreadable header, left untouched`)
    anyFailed = true
    continue
  }
  const version = header?.version ?? header?.formatVersion
  if (version !== 0) {
    console.log(`⏭️  ${label}: format v${String(version)} (not v0) — nothing to repair`)
    continue
  }

  const stats = { rewritten: 0 }
  const repaired = []
  let parseFailure = false
  for (const line of body) {
    try {
      repaired.push(JSON.stringify(rewriteChannelSources(JSON.parse(line), stats)))
    } catch {
      parseFailure = true
      break
    }
  }
  if (parseFailure) {
    console.log(`❌ ${label}: a line is not valid JSON, left untouched (inspect manually)`)
    anyFailed = true
    continue
  }
  if (stats.rewritten === 0) {
    console.log(`✅ ${label}: v0 but no channel sources — migrates fine as-is`)
    continue
  }

  if (!write) {
    console.log(`📝 ${label}: would rewrite ${stats.rewritten} channel source(s) → plugin shape (dry run; add --write)`)
    anyRepaired = true
    continue
  }

  const backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(path, backup)
  // Artifact layout: the FIRST zstd frame is independently decodable and must
  // contain exactly the header line; event batches follow in their own frames.
  // (assertIndependentHeaderFrame in dsh-session-persistence-jsonl.)
  const headerFrame = zstdCompressSync(Buffer.from(repaired[0] + '\n', 'utf8'), { checksum: true })
  const bodyFrame = zstdCompressSync(Buffer.from(repaired.slice(1).join('\n') + (trailingNewline ? '\n' : ''), 'utf8'), { checksum: true })
  writeFileSync(path, Buffer.concat([headerFrame, bodyFrame]))
  console.log(`🔧 ${label}: rewrote ${stats.rewritten} channel source(s); backup at ${basename(backup)}`)
  anyRepaired = true
}

if (targets.length === 0) console.log('no session.jsonl.zstd artifacts found under --root')
if (anyRepaired && !write) console.log('\ndry run only — rerun with --write to apply')
process.exit(anyFailed ? 2 : 0)

function dirname(path) {
  const index = path.lastIndexOf('/')
  return index === -1 ? '.' : path.slice(0, index)
}
