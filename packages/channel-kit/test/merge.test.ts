import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyMergeState, mergeReduce } from '../src/merge.ts'

test('normal messages merge and flush on tick after deadline', () => {
  let state = emptyMergeState
  let result = mergeReduce(state, { kind: 'message', text: 'a', hasMedia: false, isCommand: false, now: 0 })
  assert.equal(result.state.buffer.length, 1)
  assert.deepEqual(result.effects, [{ kind: 'armTimer', at: 5000 }])
  state = result.state

  result = mergeReduce(state, { kind: 'message', text: 'b', hasMedia: false, isCommand: false, now: 1000 })
  assert.equal(result.state.buffer.length, 2)
  state = result.state

  result = mergeReduce(state, { kind: 'tick', now: 6000 })
  assert.deepEqual(result.effects, [{ kind: 'flush', text: 'a\nb' }])
  assert.deepEqual(result.state, emptyMergeState)
})

test('commands bypass the buffer immediately', () => {
  let state = mergeReduce(emptyMergeState, { kind: 'message', text: 'hello', hasMedia: false, isCommand: false, now: 0 }).state
  const result = mergeReduce(state, { kind: 'message', text: '/stop', hasMedia: false, isCommand: true, now: 1000 })
  assert.deepEqual(result.effects, [
    { kind: 'flush', text: 'hello' },
    { kind: 'flush', text: '/stop' },
  ])
  assert.deepEqual(result.state, emptyMergeState)
})

test('media messages flush existing buffer and are delivered separately', () => {
  let state = mergeReduce(emptyMergeState, { kind: 'message', text: 'a', hasMedia: false, isCommand: false, now: 0 }).state
  const result = mergeReduce(state, { kind: 'message', text: 'pic', hasMedia: true, isCommand: false, now: 1000 })
  assert.deepEqual(result.effects, [
    { kind: 'flush', text: 'a' },
    { kind: 'flush', text: 'pic' },
  ])
})

test('.. suffix keeps waiting and strips suffix, !! flushes immediately', () => {
  let result = mergeReduce(emptyMergeState, { kind: 'message', text: 'first..', hasMedia: false, isCommand: false, now: 0 })
  assert.equal(result.state.buffer[0], 'first')
  assert.equal(result.state.deadline, 5000)

  result = mergeReduce(result.state, { kind: 'message', text: 'second!!', hasMedia: false, isCommand: false, now: 1000 })
  assert.deepEqual(result.effects, [{ kind: 'flush', text: 'first\nsecond' }])
})

test('empty text does not merge and long text requests ack', () => {
  let result = mergeReduce(emptyMergeState, { kind: 'message', text: '   ', hasMedia: false, isCommand: false, now: 0 })
  assert.deepEqual(result.state, emptyMergeState)
  assert.equal(result.effects.length, 0)

  result = mergeReduce(emptyMergeState, { kind: 'message', text: 'x'.repeat(5000), hasMedia: false, isCommand: false, now: 0 })
  assert.ok(result.effects.some((effect) => effect.kind === 'ack-long'))
})
