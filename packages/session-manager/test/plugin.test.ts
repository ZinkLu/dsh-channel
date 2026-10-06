import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.ts'
import { createFakeAgents, createFakeAgent, type MakeAgentCtx } from './harness.ts'

test('the plugin entry declares name, inject, and a config schema with only optional fields', () => {
  assert.equal(plugin.name, 'dsh-session-manager')
  assert.deepEqual([...plugin.inject], ['agents', 'sessions'])

  const parsed = plugin.Config({}) as Record<string, unknown>
  // Zero-config start: strings stay unset, the subscriber list normalizes to empty.
  assert.deepEqual(parsed.defaultSubscribers, [])
  assert.equal(parsed.statePath, undefined)
  assert.equal(parsed.provider, undefined)

  const full = plugin.Config({
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    cwd: '/tmp/p',
    agentPreset: 'standard',
    statePath: '/tmp/state.json',
    defaultSubscribers: ['channel:telegram:42'],
  }) as Record<string, unknown>
  assert.deepEqual(full.defaultSubscribers, ['channel:telegram:42'])
  assert.equal(full.statePath, '/tmp/state.json')
})

test('apply provides ctx.sessionManager and start/stop reverse on effect teardown (R1)', async () => {
  const root = new Context()
  const makeAgentCtx: MakeAgentCtx = () => ({ get: () => undefined, on: () => () => {} })
  const agents = createFakeAgents(makeAgentCtx)
  root.provide('agents', agents.service as never)
  root.provide('sessions', {} as never)

  const fiber = root.plugin(plugin as never, { statePath: join(await mkdtemp(join(tmpdir(), 'session-manager-plugin-')), 'state.json'), defaultSubscribers: [] } as never)
  await fiber
  const manager = root.sessionManager
  // The plugin's async effect runs start() in the background; await its readiness.
  await manager.ready()

  assert.ok(manager instanceof plugin.SessionManager)

  // The manager works end to end through the plugin-provided instance.
  const row = await manager.create({ cwd: process.cwd(), by: 'test' })
  assert.ok(agents.agents.has(row.sessionId))
  const agent = agents.agents.get(row.sessionId)!
  const task = await manager.dispatch({
    sessionId: row.sessionId,
    message: createUserMessage({ content: [{ type: 'text', text: 'ping' }], source: { kind: 'user' } }),
    by: 'test',
  })
  assert.equal(task.state, 'queued')
  assert.equal(agent.followed.length, 1)

  // Unload reverses everything (R1): the service key disappears and owned agents are disposed.
  await fiber.dispose()
  assert.equal(root.get('sessionManager'), undefined)
  assert.deepEqual(agents.disposed, [row.sessionId])
})

test('stop disposes every handle the manager owns', async () => {
  const root = new Context()
  const makeAgentCtx: MakeAgentCtx = () => ({ get: () => undefined, on: () => () => {} })
  const agents = createFakeAgents(makeAgentCtx)
  root.provide('agents', agents.service as never)
  root.provide('sessions', {} as never)

  const manager = new plugin.SessionManager(root, {}, plugin.createMemoryManagerStore())
  await manager.start()
  const live = createFakeAgent('pre-existing')
  agents.agents.set('pre-existing', live)
  await manager.adopt('pre-existing', 'test')
  const created = await manager.create({ cwd: process.cwd(), by: 'test' })

  await manager.stop()
  // The adopted-live session carries no owned handle; only created/resumed ones do.
  assert.deepEqual(agents.disposed, [created.sessionId])
  // A second stop is a no-op.
  await manager.stop()
})
