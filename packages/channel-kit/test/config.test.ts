import assert from 'node:assert/strict'
import { test } from 'node:test'
import Schema from '@deepseek-ai/schemastery'
import { agentRoutingSchema, allowedUserIdsSchema, channelBehaviorSchema } from '../src/config/common.ts'
import type { AgentRoutingConfig, ChannelBehaviorConfig } from '../src/config/common.ts'

// A provider-shaped composition: the fragments spread into one object schema.
const composed = Schema.object({
  ...allowedUserIdsSchema('number'),
  ...agentRoutingSchema(),
  ...channelBehaviorSchema(),
})

test('fragments fill shared defaults and keep optional fields undefined', () => {
  const resolved = composed({ allowedUserIds: [1, 2] })
  assert.equal(resolved.provider, 'deepseek-official')
  assert.equal(resolved.mergeWindowSec, 5)
  assert.equal(resolved.approvalTimeoutSec, 120)
  assert.equal(resolved.maxInboundMediaBytes, 20 * 1024 * 1024)
  assert.deepEqual(resolved.allowedUserIds, [1, 2])
  for (const key of ['model', 'cwd', 'agentPreset', 'statePath', 'sessionTurnTimeoutSec', 'accountId', 'proxyUrl'] as const) {
    assert.equal(resolved[key], undefined, key)
  }
})

test('behavior fields are configurable (media cap, turn guard, multi-account, proxy)', () => {
  const resolved = composed({
    allowedUserIds: [1],
    maxInboundMediaBytes: 1024,
    sessionTurnTimeoutSec: 30,
    accountId: 'prod',
    proxyUrl: 'http://proxy.local:3128',
  })
  assert.equal(resolved.maxInboundMediaBytes, 1024)
  assert.equal(resolved.sessionTurnTimeoutSec, 30)
  assert.equal(resolved.accountId, 'prod')
  assert.equal(resolved.proxyUrl, 'http://proxy.local:3128')
})

test('allowlist is required and typed by the platform id space', () => {
  assert.throws(() => composed({}))
  assert.throws(() => composed({ allowedUserIds: ['not-a-number'] }))
  const stringIds = Schema.object(allowedUserIdsSchema('string'))
  assert.deepEqual(stringIds({ allowedUserIds: ['ou_1'] }).allowedUserIds, ['ou_1'])
  assert.throws(() => stringIds({ allowedUserIds: [12345] }))
})

test('business interfaces and schema dicts name the same fields', () => {
  // Compile-time guard: a key added to one side without the other fails to type-check here.
  const routingKeys: Record<keyof AgentRoutingConfig, true> = { provider: true, model: true, cwd: true, agentPreset: true }
  const behaviorKeys: Record<keyof ChannelBehaviorConfig, true> = {
    mergeWindowSec: true,
    approvalTimeoutSec: true,
    sessionTurnTimeoutSec: true,
    statePath: true,
    maxInboundMediaBytes: true,
    accountId: true,
    proxyUrl: true,
  }
  assert.deepEqual(Object.keys(agentRoutingSchema()).sort(), Object.keys(routingKeys).sort())
  assert.deepEqual(Object.keys(channelBehaviorSchema()).sort(), Object.keys(behaviorKeys).sort())
})
