import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyMergeState, mergeReduce } from '../src/policy/merge.ts'

test('normal messages merge and flush on tick after deadline', () => {
  let state = emptyMergeState
  let result = mergeReduce(state, { kind: 'message', text: 'a', hasMedia: false, isCommand: false, now: 0 })
  assert.equal(result.state.buffer.length, 1)
  assert.deepEqual(result.state.buffer, [['a']])
  assert.equal(result.state.firstAt, 0)
  assert.deepEqual(result.effects, [{ kind: 'armTimer', at: 5000 }])
  state = result.state

  result = mergeReduce(state, { kind: 'message', text: 'b', hasMedia: false, isCommand: false, now: 1000 })
  assert.equal(result.state.buffer.length, 2)
  state = result.state

  result = mergeReduce(state, { kind: 'tick', now: 6000 })
  assert.deepEqual(result.effects, [{ kind: 'flush', texts: ['a', 'b'] }])
  assert.deepEqual(result.state, emptyMergeState)
})

test('commands bypass the buffer immediately', () => {
  let state = mergeReduce(emptyMergeState, { kind: 'message', text: 'hello', hasMedia: false, isCommand: false, now: 0 }).state
  const result = mergeReduce(state, { kind: 'message', text: '/stop', hasMedia: false, isCommand: true, now: 1000 })
  assert.deepEqual(result.effects, [
    { kind: 'flush', texts: ['hello'] },
    { kind: 'flush', texts: ['/stop'] },
  ])
  assert.deepEqual(result.state, emptyMergeState)
})

test('media messages flush existing buffer and are delivered separately', () => {
  let state = mergeReduce(emptyMergeState, { kind: 'message', text: 'a', hasMedia: false, isCommand: false, now: 0 }).state
  const result = mergeReduce(state, { kind: 'message', text: 'pic', hasMedia: true, isCommand: false, now: 1000 })
  assert.deepEqual(result.effects, [
    { kind: 'flush', texts: ['a'] },
    { kind: 'flush', texts: ['pic'] },
  ])
})

test('.. suffix keeps waiting and strips suffix, !! flushes immediately', () => {
  let result = mergeReduce(emptyMergeState, { kind: 'message', text: 'first..', hasMedia: false, isCommand: false, now: 0 })
  assert.equal(result.state.buffer[0]![0], 'first')
  assert.equal(result.state.deadline, 5000)

  result = mergeReduce(result.state, { kind: 'message', text: 'second!!', hasMedia: false, isCommand: false, now: 1000 })
  assert.deepEqual(result.effects, [{ kind: 'flush', texts: ['first', 'second'] }])
})

test('empty text does not merge and long text requests ack', () => {
  let result = mergeReduce(emptyMergeState, { kind: 'message', text: '   ', hasMedia: false, isCommand: false, now: 0 })
  assert.deepEqual(result.state, emptyMergeState)
  assert.equal(result.effects.length, 0)

  result = mergeReduce(emptyMergeState, { kind: 'message', text: 'x'.repeat(5000), hasMedia: false, isCommand: false, now: 0 })
  assert.ok(result.effects.some((effect) => effect.kind === 'ack-long'))
})

test('continuous typing cannot starve the merge lane: firstAt caps the deadline', () => {
  let state = emptyMergeState
  state = mergeReduce(state, { kind: 'message', text: 'a', hasMedia: false, isCommand: false, now: 0 }).state
  // Keep typing every 4s: each message resets the sliding deadline, but the fixed
  // firstAt cap (5 * windowMs) still fires at 25000.
  for (let now = 4000; now <= 24_000; now += 4000) {
    const result = mergeReduce(state, { kind: 'message', text: 'x', hasMedia: false, isCommand: false, now })
    state = result.state
    assert.ok(state.deadline !== undefined && state.deadline <= 25_000)
  }
  const result = mergeReduce(state, { kind: 'tick', now: 25_000 })
  assert.equal(result.state.buffer.length, 0)
  assert.deepEqual(result.effects, [{ kind: 'flush', texts: ['a', 'x', 'x', 'x', 'x', 'x', 'x'] }])
})

test('empty .. suffix re-arms the timer without adding a buffer entry', () => {
  const first = mergeReduce(emptyMergeState, { kind: 'message', text: 'a', hasMedia: false, isCommand: false, now: 0 })
  const result = mergeReduce(first.state, { kind: 'message', text: '..', hasMedia: false, isCommand: false, now: 2000 })
  assert.equal(result.state.buffer.length, 1)
  assert.deepEqual(result.effects, [{ kind: 'armTimer', at: 7000 }])
})
