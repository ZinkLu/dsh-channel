import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  feishuConfigSchema,
  telegramConfigSchema,
  wechatConfigSchema,
} from '../src/index.ts'

test('telegram schema fills shared defaults and keeps optional fields undefined', () => {
  const schema = telegramConfigSchema()
  const resolved = schema({ allowedUserIds: [1, 2] })
  assert.equal(resolved.provider, 'deepseek-official')
  assert.equal(resolved.mergeWindowSec, 5)
  assert.equal(resolved.approvalTimeoutSec, 120)
  assert.equal(resolved.pollingTimeoutSec, 30)
  assert.deepEqual(resolved.allowedUserIds, [1, 2])
  assert.equal(resolved.model, undefined)
  assert.equal(resolved.cwd, undefined)
  assert.equal(resolved.agentPreset, undefined)
  assert.equal(resolved.statePath, undefined)
  assert.equal(resolved.maxInboundMediaBytes, 20 * 1024 * 1024)
})

test('maxInboundMediaBytes is configurable', () => {
  const schema = telegramConfigSchema()
  const resolved = schema({ allowedUserIds: [1], maxInboundMediaBytes: 1024 })
  assert.equal(resolved.maxInboundMediaBytes, 1024)
})

test('telegram allowlist is required and numeric-only', () => {
  const schema = telegramConfigSchema()
  assert.throws(() => schema({}))
  assert.throws(() => schema({ allowedUserIds: ['not-a-number'] }))
})

test('wechat allowlist is string-based and platformAccountId is optional', () => {
  const schema = wechatConfigSchema()
  const resolved = schema({ allowedUserIds: ['ou_1'] })
  assert.deepEqual(resolved.allowedUserIds, ['ou_1'])
  assert.equal(resolved.platformAccountId, undefined)
  assert.equal(resolved.pollingTimeoutSec, 30)
  assert.throws(() => schema({ allowedUserIds: [12345] }))
})

test('feishu domain defaults to feishu and rejects unknown values', () => {
  const schema = feishuConfigSchema()
  const resolved = schema({ allowedUserIds: ['ou_1'] })
  assert.equal(resolved.domain, 'feishu')
  assert.equal(schema({ allowedUserIds: ['ou_1'], domain: 'lark' }).domain, 'lark')
  assert.throws(() => schema({ allowedUserIds: ['ou_1'], domain: 'nope' }))
})

test('shared behavior schema carries accountId and proxyUrl (multi-account + deployment reach)', () => {
  const schema = telegramConfigSchema()
  const defaults = schema({ allowedUserIds: [1] })
  assert.equal(defaults.accountId, undefined)
  assert.equal(defaults.proxyUrl, undefined)

  const configured = schema({ allowedUserIds: [1], accountId: 'prod', proxyUrl: 'http://proxy.local:3128' })
  assert.equal(configured.accountId, 'prod')
  assert.equal(configured.proxyUrl, 'http://proxy.local:3128')
})
