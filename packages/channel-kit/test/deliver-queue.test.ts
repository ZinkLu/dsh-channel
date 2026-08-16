import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  deliverQueueReduce,
  emptyDeliverQueueState,
  type DeliverQueueEffect,
  type DeliverQueueOptions,
  type DeliverQueueState,
  type QueuedDelivery,
} from '../src/policy/deliver-queue.ts'

interface P { chatKey: string; markdown: string }

function item(key: string, chatKey = '42', markdown = key): QueuedDelivery<P> {
  return { key, value: { chatKey, markdown } }
}

function run<T>(
  state: DeliverQueueState<T>,
  inputs: Array<Parameters<typeof deliverQueueReduce<T>>[1]>,
  opts: DeliverQueueOptions = {},
): { state: DeliverQueueState<T>; effects: DeliverQueueEffect<T>[] } {
  let current = state
  let effects: DeliverQueueEffect<T>[] = []
  for (const input of inputs) {
    const result = deliverQueueReduce(current, input, opts)
    current = result.state
    effects = [...effects, ...result.effects]
  }
  return { state: current, effects }
}

test('enqueue starts the first item immediately', () => {
  const { state, effects } = deliverQueueReduce(emptyDeliverQueueState<P>(), { kind: 'enqueue', item: item('k1'), now: 0 })
  assert.deepEqual(state.inFlight, item('k1'))
  assert.equal(state.attempts, 1)
  assert.equal(state.waiting.length, 0)
  assert.deepEqual(effects, [{ kind: 'attempt', item: item('k1') }])
})

test('enqueue while busy appends to waiting without attempting', () => {
  let state = emptyDeliverQueueState<P>()
  state = deliverQueueReduce(state, { kind: 'enqueue', item: item('k1'), now: 0 }).state
  const result = deliverQueueReduce(state, { kind: 'enqueue', item: item('k2'), now: 0 })
  assert.equal(result.state.waiting.length, 1)
  assert.deepEqual(result.state.waiting[0], item('k2'))
  assert.deepEqual(result.effects, [])
})

test('success advances to the next item after spacing', () => {
  let state = emptyDeliverQueueState<P>()
  state = deliverQueueReduce(state, { kind: 'enqueue', item: item('k1'), now: 0 }).state
  state = deliverQueueReduce(state, { kind: 'enqueue', item: item('k2'), now: 0 }).state
  const result = deliverQueueReduce(state, { kind: 'attempt-result', key: 'k1', outcome: 'sent', now: 10 })
  assert.deepEqual(result.state.inFlight, item('k2'))
  assert.equal(result.state.attempts, 0)
  assert.equal(result.state.retryAt, 1010) // now(10) + spacingMs(1000)
  assert.deepEqual(result.effects, [{ kind: 'retry-after', at: 1010, item: item('k2') }])
})

test('success with zero spacing advances immediately', () => {
  let state = emptyDeliverQueueState<P>()
  state = deliverQueueReduce(state, { kind: 'enqueue', item: item('k1'), now: 0 }, { spacingMs: 0 }).state
  state = deliverQueueReduce(state, { kind: 'enqueue', item: item('k2'), now: 0 }, { spacingMs: 0 }).state
  const result = deliverQueueReduce(state, { kind: 'attempt-result', key: 'k1', outcome: 'sent', now: 10 }, { spacingMs: 0 })
  assert.deepEqual(result.state.inFlight, item('k2'))
  assert.equal(result.state.attempts, 1)
  assert.deepEqual(result.effects, [{ kind: 'attempt', item: item('k2') }])
})

test('failure schedules a retry with exponential backoff', () => {
  const state = deliverQueueReduce(emptyDeliverQueueState<P>(), { kind: 'enqueue', item: item('k1'), now: 100 }).state
  const result = deliverQueueReduce(state, { kind: 'attempt-result', key: 'k1', outcome: 'failed', error: 'boom', now: 100 })
  assert.deepEqual(result.state.inFlight, item('k1'))
  assert.equal(result.state.attempts, 2)
  assert.equal(result.state.retryAt, 1100) // baseDelay 1000 * 2^(1-1)
  assert.deepEqual(result.effects, [{ kind: 'retry-after', at: 1100, item: item('k1') }])
})

test('tick fires the scheduled attempt and re-arms when early', () => {
  let state = deliverQueueReduce(emptyDeliverQueueState<P>(), { kind: 'enqueue', item: item('k1'), now: 100 }).state
  state = deliverQueueReduce(state, { kind: 'attempt-result', key: 'k1', outcome: 'failed', now: 100 }).state

  const early = deliverQueueReduce(state, { kind: 'tick', now: 500 })
  assert.deepEqual(early.effects, [{ kind: 'retry-after', at: 1100, item: item('k1') }])
  assert.equal(early.state.attempts, 2)

  const fired = deliverQueueReduce(state, { kind: 'tick', now: 1100 })
  assert.deepEqual(fired.effects, [{ kind: 'attempt', item: item('k1') }])
  assert.equal(fired.state.attempts, 2)
  assert.equal(fired.state.retryAt, undefined)
})

test('gives up after maxRetries and advances to the next item', () => {
  let state = emptyDeliverQueueState<P>()
  state = deliverQueueReduce(state, { kind: 'enqueue', item: item('k1'), now: 0 }).state
  state = deliverQueueReduce(state, { kind: 'enqueue', item: item('k2'), now: 0 }).state

  // Exhaust 3 retries (4 total attempts) for k1.
  let effects: DeliverQueueEffect<P>[] = []
  for (let attempt = 1; attempt <= 4; attempt++) {
    const result = deliverQueueReduce(state, { kind: 'attempt-result', key: 'k1', outcome: 'failed', error: 'boom', now: attempt * 10 })
    state = result.state
    effects = [...effects, ...result.effects]
    // After the final attempt, the reducer already advanced to k2.
    if (attempt < 4) {
      state = deliverQueueReduce(state, { kind: 'tick', now: attempt * 10 + 100_000 }).state
    }
  }

  assert.deepEqual(state.inFlight, item('k2'))
  assert.ok(effects.some((e) => e.kind === 'give-up' && e.item.key === 'k1' && e.error === 'boom'))
})

test('rejects new items with backpressure when the queue is full', () => {
  let state = emptyDeliverQueueState<P>()
  state = deliverQueueReduce(state, { kind: 'enqueue', item: item('k1'), now: 0 }, { maxQueue: 1 }).state
  state = deliverQueueReduce(state, { kind: 'enqueue', item: item('k2'), now: 0 }, { maxQueue: 1 }).state // fills the single slot
  const result = deliverQueueReduce(state, { kind: 'enqueue', item: item('k3'), now: 0 }, { maxQueue: 1 })
  assert.deepEqual(result.effects, [{ kind: 'reject-backpressure', item: item('k3') }])
  assert.equal(result.state.waiting.length, 1)
})

test('ignores a stale attempt-result for a key that is not in flight', () => {
  const state = deliverQueueReduce(emptyDeliverQueueState<P>(), { kind: 'enqueue', item: item('k1'), now: 0 }).state
  const result = deliverQueueReduce(state, { kind: 'attempt-result', key: 'other', outcome: 'sent', now: 10 })
  assert.deepEqual(result.state, state)
  assert.deepEqual(result.effects, [])
})

test('suppressed counts as a terminal success and does not retry', () => {
  const state = deliverQueueReduce(emptyDeliverQueueState<P>(), { kind: 'enqueue', item: item('k1'), now: 0 }).state
  const result = deliverQueueReduce(state, { kind: 'attempt-result', key: 'k1', outcome: 'suppressed', now: 10 })
  assert.equal(result.state.inFlight, null)
  assert.deepEqual(result.effects, [])
})
