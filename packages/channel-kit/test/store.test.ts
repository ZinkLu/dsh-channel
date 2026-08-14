import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonFileStore, createMemoryStore } from '../src/index.ts'

test('memory store seen ring trims to limit', () => {
  const store = createMemoryStore({ seenLimit: 10, seenTrimTo: 5 })
  for (let i = 0; i < 20; i++) store.markInbound(`m${i}`)
  assert.equal(store.seenInbound('m0'), false)
  assert.equal(store.seenInbound('m15'), true)
})

test('memory store bindings and merge buffers', () => {
  const store = createMemoryStore()
  store.setBinding('chat1', 's1')
  assert.deepEqual(store.bindings(), { chat1: 's1' })
  store.setBinding('chat1', undefined)
  assert.deepEqual(store.bindings(), {})

  store.setMergeBuffer('chat1', ['a', 'b'])
  assert.deepEqual(store.mergeBuffers(), { chat1: ['a', 'b'] })
  store.setMergeBuffer('chat1', [])
  assert.deepEqual(store.mergeBuffers(), {})
})

test('memory store delivery ledger state machine and sweep', () => {
  const store = createMemoryStore({ maxAttempts: 2 })
  store.recordDelivery('k1', { chatKey: 'c1', textHash: 'h1' })
  store.markAttempting('k1')
  store.markFailed('k1', 'boom')
  let recoverable = store.sweepRecoverable()
  assert.equal(recoverable.length, 1)
  assert.equal(recoverable[0]!.state, 'failed')

  store.markAttempting('k1')
  recoverable = store.sweepRecoverable()
  // attempts now 2, sweep should turn it abandoned
  assert.equal(recoverable.length, 0)
})

test('memory store markDelivered keeps platform ids', async () => {
  const store = createMemoryStore()
  store.recordDelivery('k1', { chatKey: 'c1', textHash: 'h1' })
  store.markDelivered('k1', ['m1', 'm2'])
  assert.equal(store.sweepRecoverable().length, 0)
})

test('json file store persists and reloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-channel-kit-'))
  const path = join(dir, 'state.json')
  try {
    const store = createJsonFileStore(path)
    store.markInbound('m1')
    store.setBinding('chat1', 's1')
    store.setMergeBuffer('chat1', ['a'])
    store.recordDelivery('k1', { chatKey: 'c1', textHash: 'h1' })
    store.markAttempting('k1')
    await store.flush()

    const store2 = createJsonFileStore(path)
    assert.equal(store2.seenInbound('m1'), true)
    assert.deepEqual(store2.bindings(), { chat1: 's1' })
    assert.deepEqual(store2.mergeBuffers(), { chat1: ['a'] })
    const recoverable = store2.sweepRecoverable()
    assert.equal(recoverable.length, 1)
    assert.equal(recoverable[0]!.state, 'attempting')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
