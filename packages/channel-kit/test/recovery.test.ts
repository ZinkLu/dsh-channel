import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultRecoveryPolicy, hashText, splitDeliveryKey, type ReconcileLike, type RecoverableDelivery, type RecoveryPolicy } from '../src/policy/recovery.ts'

const noReconcile: ReconcileLike = { supportsReconciliation: false, async reconcile() { return 'unknown' } }

test('defaultRecoveryPolicy abandons unparseable keys and resends recoverable ones', async () => {
  const entries: RecoverableDelivery[] = [
    { key: 'not-a-delivery-key', state: 'failed', chatKey: 'c' },
    { key: 'sess:1', state: 'failed', chatKey: 'c' },
  ]
  const actions = await defaultRecoveryPolicy.sweep(entries, {
    channel: noReconcile,
    resolveText: (_sessionId, seq) => (seq === 1 ? 'hello' : ''),
  })

  assert.equal(actions[0]!.kind, 'abandon')
  assert.equal(actions[1]!.kind, 'resend')
  assert.equal((actions[1] as { text: string }).text, 'hello')
  assert.ok((actions[1] as { marker?: string }).marker?.includes('resumed resend'))
})

test('defaultRecoveryPolicy skips when reconcile reports confirmed-sent', async () => {
  const channel: ReconcileLike = { supportsReconciliation: true, async reconcile() { return 'confirmed-sent' } }
  const actions = await defaultRecoveryPolicy.sweep(
    [{ key: 'sess:1', state: 'attempting', chatKey: 'c' }],
    { channel, resolveText: () => 'hello' },
  )
  assert.equal(actions[0]!.kind, 'skip')
})

test('a custom RecoveryPolicy is adopted verbatim', async () => {
  const atMostOnce: RecoveryPolicy = {
    async sweep(entries) {
      return entries.map((item) => ({ kind: 'abandon' as const, item, reason: 'at-most-once: no blind resend' }))
    },
  }
  const actions = await atMostOnce.sweep(
    [{ key: 'sess:1', state: 'failed', chatKey: 'c' }],
    { channel: noReconcile, resolveText: () => 'x' },
  )
  assert.deepEqual(actions.map((action) => action.kind), ['abandon'])
})

test('splitDeliveryKey parses sessionId:seq and rejects malformed keys', () => {
  assert.deepEqual(splitDeliveryKey('chan:abc:42'), { sessionId: 'chan:abc', seq: 42 })
  assert.deepEqual(splitDeliveryKey('no-seq'), {})
  assert.deepEqual(splitDeliveryKey('a:not-a-number'), {})
})

test('hashText is stable', () => {
  assert.equal(hashText('hello'), hashText('hello'))
  assert.notEqual(hashText('hello'), hashText('world'))
})
