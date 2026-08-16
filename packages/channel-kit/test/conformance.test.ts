import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDeliveryTracer, createTraceClock, installChannelContractSuite, TRACE_CLOCK_EPOCH, type ChannelContractHarness } from '../src/index.ts'

const fakeHarness: ChannelContractHarness = {
  name: 'fake',
  chunking: 'split',
  maxMessageChars: 200,
  supportsChoices: false,
  supportsEdit: false,
  supportsMedia: false,
  proofs: {},
  async send(req) {
    return { status: 'sent', platformMessageIds: [`fake:${req.chatKey}:${req.markdown.length}`] }
  },
}

// The suite registers tests as a side effect; call it at module top-level.
installChannelContractSuite(fakeHarness)

test('trace clock starts at a fixed non-zero epoch', () => {
  const clock = createTraceClock()
  assert.equal(clock.now(), TRACE_CLOCK_EPOCH)
  assert.ok(clock.now() > 0)
})

test('delivery tracer records JSONL with fake-clock timestamps', () => {
  const clock = createTraceClock(1_700_000_000_000)
  const tracer = createDeliveryTracer(clock)
  tracer.record('attempt', { key: 'k1' })
  clock.advance(1000)
  tracer.record('sent', { key: 'k1', platformMessageId: 'm1' })

  const lines = tracer.toJsonl().trim().split('\n')
  assert.equal(lines.length, 2)
  assert.deepEqual(JSON.parse(lines[0]!), { at: 1_700_000_000_000, kind: 'attempt', key: 'k1' })
  assert.deepEqual(JSON.parse(lines[1]!), { at: 1_700_000_001_000, kind: 'sent', key: 'k1', platformMessageId: 'm1' })
})
