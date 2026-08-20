import assert from 'node:assert/strict'
import { test } from 'node:test'
import { wechatConfigSchema } from '../src/config.ts'

test('wechat allowlist is string-based and platformAccountId is optional', () => {
  const schema = wechatConfigSchema()
  const resolved = schema({ allowedUserIds: ['ou_1'] })
  assert.deepEqual(resolved.allowedUserIds, ['ou_1'])
  assert.equal(resolved.platformAccountId, undefined)
  assert.equal(resolved.pollingTimeoutSec, 30)
  assert.equal(resolved.provider, 'deepseek-official')
  assert.throws(() => schema({ allowedUserIds: [12345] }))
})
