import assert from 'node:assert/strict'
import { test } from 'node:test'
import { notifyUserTool, NOTIFY_USER_DESCRIPTION } from '../src/index.ts'
import type { NotifyToolHost } from '../src/index.ts'

function fakeHost() {
  const calls: Array<{ sessionId: string; text: string; when?: string }> = []
  let delivered = 1
  const host: NotifyToolHost = {
    async notify(sessionId, text, opts) {
      calls.push({ sessionId, text, ...(opts?.when !== undefined ? { when: opts.when } : {}) })
      return delivered
    },
  }
  return { host, calls, setDelivered: (value: number) => { delivered = value } }
}

test('notify_user executes against the manager with when defaulting to now', async () => {
  const { host, calls } = fakeHost()
  const tool = notifyUserTool(host)

  assert.equal(tool.name, 'notify_user')
  assert.equal(tool.description, NOTIFY_USER_DESCRIPTION)

  const immediate = await tool.execute({ text: 'deploy done' }, { agent: { id: 's1' } })
  assert.deepEqual(immediate, { delivered: 1 })
  assert.deepEqual(calls[0], { sessionId: 's1', text: 'deploy done', when: 'now' })

  const deferred = await tool.execute({ text: 'report ready', when: 'done' }, { agent: { id: 's2' } })
  assert.deepEqual(deferred, { delivered: 1 })
  assert.deepEqual(calls[1], { sessionId: 's2', text: 'report ready', when: 'done' })
})

test('notify_user fails closed to zero deliveries on junk input or a missing agent', async () => {
  const { host, calls, setDelivered } = fakeHost()
  setDelivered(3)
  const tool = notifyUserTool(host)

  assert.deepEqual(await tool.execute({ text: '   ' }, { agent: { id: 's1' } }), { delivered: 0 })
  assert.deepEqual(await tool.execute({ text: 42 }, { agent: { id: 's1' } }), { delivered: 0 })
  assert.deepEqual(await tool.execute({ text: 'hi' }, {}), { delivered: 0 })
  assert.deepEqual(await tool.execute({}, { agent: { id: 's1' } }), { delivered: 0 })
  assert.equal(calls.length, 0)

  // An unknown `when` degrades to immediate delivery, never a drop.
  assert.deepEqual(await tool.execute({ text: 'x', when: 'whenever' }, { agent: { id: 's1' } }), { delivered: 3 })
  assert.deepEqual(calls[0], { sessionId: 's1', text: 'x', when: 'now' })
})

test('notify_user declares a JSON-schema parameter set and renders its delivery count', () => {
  const { host } = fakeHost()
  const tool = notifyUserTool(host)

  const parameters = tool.parameters as { type: string; required: string[]; properties: Record<string, { enum?: string[] }> }
  assert.equal(parameters.type, 'object')
  assert.deepEqual(parameters.required, ['text'])
  assert.deepEqual(parameters.properties.when!.enum, ['now', 'done'])

  assert.deepEqual(tool.output.render({}, { delivered: 2 }), [{ type: 'text', text: 'Notification queued for 2 subscriber(s).' }])
  const none = tool.output.render({}, { delivered: 0 })[0]!
  assert.match(none.text, /No subscriber is watching/)
})
