import assert from 'node:assert/strict'
import { test } from 'node:test'
import { telegramConfigSchema } from '../src/config.ts'

test('telegram schema composes the shared fragments with its own defaults', () => {
  const resolved = telegramConfigSchema()({ allowedUserIds: [1, 2] })
  assert.equal(resolved.provider, 'deepseek-official')
  assert.equal(resolved.mergeWindowSec, 5)
  assert.equal(resolved.approvalTimeoutSec, 120)
  assert.equal(resolved.pollingTimeoutSec, 30)
  assert.equal(resolved.maxInboundMediaBytes, 20 * 1024 * 1024)
  assert.deepEqual(resolved.allowedUserIds, [1, 2])
})

test('telegram allowlist is required and numeric-only', () => {
  const schema = telegramConfigSchema()
  assert.throws(() => schema({}))
  assert.throws(() => schema({ allowedUserIds: ['not-a-number'] }))
})
