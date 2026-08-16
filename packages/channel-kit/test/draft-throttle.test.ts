import assert from 'node:assert/strict'
import { test } from 'node:test'
import { draftThrottleReduce, emptyDraftThrottleState } from '../src/policy/draft-throttle.ts'
import { resolveFinalization } from '../src/policy/finalization.ts'

test('draft throttle doubles interval on failures and resets on success', () => {
  let state = emptyDraftThrottleState
  let result = draftThrottleReduce(state, { kind: 'attempt', now: 0 })
  assert.equal(result.effect.kind, 'allow')

  result = draftThrottleReduce(result.state, { kind: 'failure', now: 0 })
  assert.equal(result.state.strikes, 1)
  assert.equal(result.effect.kind, 'delay')
  assert.equal(result.effect.kind === 'delay' ? result.effect.at : -1, 800)

  result = draftThrottleReduce(result.state, { kind: 'attempt', now: 100 })
  assert.equal(result.effect.kind, 'delay')
  assert.equal(result.effect.kind === 'delay' ? result.effect.at : -1, 800)

  result = draftThrottleReduce(result.state, { kind: 'attempt', now: 800 })
  assert.equal(result.effect.kind, 'allow')

  result = draftThrottleReduce(result.state, { kind: 'success', now: 900 })
  assert.equal(result.state.strikes, 0)
  assert.equal(result.effect.kind, 'allow')
})

test('draft throttle honors retryAfterMs up to the ceiling then fails over', () => {
  let state = emptyDraftThrottleState
  let result = draftThrottleReduce(state, { kind: 'failure', now: 0, retryAfterMs: 2000 })
  assert.equal(result.effect.kind, 'delay')
  assert.equal(result.effect.kind === 'delay' ? result.effect.at : -1, 2000)

  result = draftThrottleReduce(state, { kind: 'failure', now: 0, retryAfterMs: 30_000 })
  assert.equal(result.effect.kind, 'fail-over')
  assert.equal(result.state.nextAttemptAt, 5000)
})

test('resolveFinalization covers the four outcomes', () => {
  assert.equal(
    resolveFinalization(
      { streamingMode: 'progress', supportsEdit: true },
      { draftStarted: false, editFailed: false },
      { ok: true, finalVisible: true },
    ),
    'normal-delivered',
  )
  assert.equal(
    resolveFinalization(
      { streamingMode: 'off', supportsEdit: true },
      { draftStarted: true, editFailed: false },
      { ok: true, finalVisible: true },
    ),
    'normal-skipped',
  )
  assert.equal(
    resolveFinalization(
      { streamingMode: 'progress', supportsEdit: true },
      { draftStarted: true, editFailed: false },
      { ok: true, finalVisible: true },
    ),
    'preview-finalized',
  )
  assert.equal(
    resolveFinalization(
      { streamingMode: 'progress', supportsEdit: true },
      { draftStarted: true, editFailed: true },
      { ok: false, finalVisible: false },
    ),
    'preview-retained',
  )
})
