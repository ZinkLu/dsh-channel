import assert from 'node:assert/strict'
import { test } from 'node:test'
import { feishuConfigSchema } from '../src/config.ts'

test('feishu domain defaults to feishu and rejects unknown values', () => {
  const schema = feishuConfigSchema()
  const resolved = schema({ allowedUserIds: ['ou_1'] })
  assert.equal(resolved.domain, 'feishu')
  assert.equal(resolved.provider, 'deepseek-official')
  assert.equal(schema({ allowedUserIds: ['ou_1'], domain: 'lark' }).domain, 'lark')
  assert.throws(() => schema({ allowedUserIds: ['ou_1'], domain: 'nope' }))
  assert.throws(() => schema({}))
})
