import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { apply, ChannelRegistry } from '../src/index.ts'

test('apply installs ChannelRegistry and unload removes it', async () => {
  const root = new Context()
  const fiber = root.plugin(apply)
  await fiber
  assert.ok(root.channels instanceof ChannelRegistry)

  const dispose = root.channels.register({ id: 'x', async send() { return { platformMessageId: '1' } } } as any)
  assert.equal(root.channels.get('x')?.id, 'x')
  await fiber.dispose()
  assert.equal(root.get('channels'), undefined)
})
