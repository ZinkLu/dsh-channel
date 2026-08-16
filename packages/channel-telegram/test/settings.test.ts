import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ChannelRegistry } from 'dsh-channel'
import { CHANNEL_TELEGRAM_NS } from 'dsh-channel-config'
import { apply, type TelegramConfig } from '../src/index.ts'

interface RegisterCall {
  ns: unknown
  schema: unknown
  options: unknown
}

function createFakeSettingsService() {
  const calls: RegisterCall[] = []
  let resolved: unknown
  return {
    calls,
    setResolved(value: unknown) {
      resolved = value
    },
    service: {
      register(ns: unknown, schema: unknown, options?: unknown) {
        calls.push({ ns, schema, options })
        return {
          get: () => resolved,
          watch: () => () => {},
        }
      },
    },
  }
}

test('apply registers the telegram settings namespace with config as base', async () => {
  const ctx = new Context()
  new ChannelRegistry(ctx)
  ctx.provide('credentials', { resolve: async () => ({ value: 'tok', source: 'test' }) })

  const fake = createFakeSettingsService()
  ctx.provide('settings', fake.service)

  const config: TelegramConfig = {
    allowedUserIds: [123],
    provider: 'deepseek-official',
    pollingTimeoutSec: 30,
    mergeWindowSec: 5,
    approvalTimeoutSec: 120,
    statePath: '/tmp/dsh-channel-settings-test.json',
  }
  apply(ctx, config)

  // installSettingsSection runs through ctx.inject → a Cordis fiber, so the
  // registration lands on a later tick. Poll briefly instead of guessing.
  for (let i = 0; i < 40 && fake.calls.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0]!.ns, CHANNEL_TELEGRAM_NS)
  assert.deepEqual(fake.calls[0]!.options, { base: config })
})
