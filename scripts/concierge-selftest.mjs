/**
 * Concierge self-test (M19+M20): the REAL dsh stack headless — AgentLoop,
 * LlmRuntime + deepseek-official (API key), ToolRuntime, SystemPrompt,
 * SessionStore, projections — plus OUR dsh-session-manager with
 * concierge.enable, driven end to end against the real model.
 *
 * NOT part of `npm test` (it spends ~5 deepseek-flash calls and needs a key).
 * It resolves imports from wherever it is installed, so run it from a scratch
 * project that installs the stack at the pinned baseline plus this repo's
 * built packages:
 *
 *   mkdir -p /tmp/concierge-selftest && cd /tmp/concierge-selftest
 *   npm init -y && npm pkg set type=module
 *   npm i @deepseek-ai/cordis@~0.0.0-placeholder \
 *         @deepseek-ai/dsh-agent@<baseline> @deepseek-ai/dsh-agent-loop@<baseline> \
 *         @deepseek-ai/dsh-credentials-local@<baseline> @deepseek-ai/dsh-llm@<baseline> \
 *         @deepseek-ai/dsh-llm-deepseek-api-key@<baseline> @deepseek-ai/dsh-session@<baseline> \
 *         @deepseek-ai/dsh-session-projection@<baseline> @deepseek-ai/dsh-system-prompt@<baseline> \
 *         @deepseek-ai/dsh-tools@<baseline> dsh-session-manager@file:<repo>/packages/session-manager
 *   cp <repo>/scripts/concierge-selftest.mjs .
 *   DEEPSEEK_API_KEY=... node concierge-selftest.mjs
 *
 * Scenario (3 concierge turns + 1 worker turn):
 *   1. "list sessions, create one labeled docs"  → list_sessions + create_session
 *   2. "dispatch 'reply pong' to docs"           → dispatch_message (+ the C4 copy)
 *   3. (automatic) the wake loop re-awakens the concierge when the worker ends
 *
 * Run: node concierge-selftest.mjs   (needs DEEPSEEK_API_KEY in env; DSH_HOME is scratch)
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { apply as llmDeepSeekApply, inject as llmDeepSeekInject, Config as LlmDeepSeekConfig } from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { apply as managerApply, inject as managerInject, Config as ManagerConfig, CONCIERGE_SESSION_ID } from 'dsh-session-manager'
const HOME = join(tmpdir(), 'concierge-selftest')
rmSync(HOME, { recursive: true, force: true })
mkdirSync(HOME, { recursive: true })
if (process.env.DEEPSEEK_API_KEY === undefined) {
  console.error('FATAL: DEEPSEEK_API_KEY is not in the environment')
  process.exit(1)
}

const CHAT = 'channel:telegram:selftest'
const PROVIDER = 'deepseek-official'
const MODEL = 'deepseek-flash'
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail !== '' ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(label, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined && value !== false) return value
    await sleep(400)
  }
  throw new Error(`timeout waiting for ${label}`)
}

// ---- compose the stack ----

const root = new Context()
await root.plugin(LocalCredentialProvider, { dshHome: HOME, watch: false })
await root.plugin(LlmRuntime)
await root.plugin({ name: 'llm-deepseek-api-key', inject: llmDeepSeekInject, Config: LlmDeepSeekConfig, apply: llmDeepSeekApply }, {})
await root.plugin(ToolRuntime)
await root.plugin(SystemPrompt)
await root.plugin(SessionStore)
await root.plugin(SessionProjectionRegistry)
await root.plugin(AgentRegistry)
await root.plugin(AgentLoop)
await root.plugin({ name: 'dsh-session-manager', inject: managerInject, Config: ManagerConfig, apply: managerApply }, {
  provider: PROVIDER,
  model: MODEL,
  statePath: join(HOME, 'manager-state.json'),
  concierge: { enable: true },
})

const manager = root.sessionManager
await manager.ready()

const events = []
root.on('manager/task', (task) => events.push(`task ${task.taskId} ${task.state}`))
root.on('session/event', (session, event) => {
  if (String(session.id) === CONCIERGE_SESSION_ID && event.type === 'tool/call') {
    events.push(`concierge tool → ${event.data?.name}`)
  }
})

try {
  // The bridge's role, played by hand: bind the chat to the concierge.
  manager.watch(CHAT, CONCIERGE_SESSION_ID)
  await manager.adopt(CONCIERGE_SESSION_ID, CHAT)
  const concierge = root.agents.get(CONCIERGE_SESSION_ID)
  check('concierge spawns lazily under the well-known id', concierge !== undefined)

  // ---- turn 1: list + create ----
  await manager.dispatch({
    sessionId: CONCIERGE_SESSION_ID,
    by: CHAT,
    message: createUserMessage({
      content: [{ type: 'text', text: 'Call list_sessions and report how many sessions exist. Then call create_session with label "docs" and no text. Answer in one line.' }],
      source: { kind: 'user' },
    }),
  })
  await waitFor('turn 1 done', async () => {
    const tasks = manager.tasks({ sessionId: CONCIERGE_SESSION_ID, state: ['done'] })
    return tasks.length >= 1
  }, 120_000)
  check('turn 1 folded done (real turn/start..turn/end)', true)

  const docs = (await manager.list()).find((view) => view.label === 'docs')
  check('create_session really created the docs session', docs !== undefined, docs?.sessionId ?? '')

  const toolCalls = events.filter((line) => line.startsWith('concierge tool →')).map((line) => line.slice('concierge tool → '.length))
  check('the model saw and called our tools (real ToolRuntime path)', toolCalls.some((name) => name === 'list_sessions') && toolCalls.some((name) => name === 'create_session'), toolCalls.join(',') || 'none')

  // ---- turn 2: dispatch to the worker ----
  manager.watch(CHAT, docs.sessionId) // what a focused chat would have anyway
  await manager.dispatch({
    sessionId: CONCIERGE_SESSION_ID,
    by: CHAT,
    message: createUserMessage({
      content: [{ type: 'text', text: 'Use dispatch_message to send the session labeled docs this instruction: "Reply with exactly the single word pong and nothing else." Then confirm in one line.' }],
      source: { kind: 'user' },
    }),
  })
  await waitFor('turn 2 done', async () => {
    return manager.tasks({ sessionId: CONCIERGE_SESSION_ID, state: ['done'] }).length >= 2
  }, 120_000)
  check('turn 2 folded done', true)

  check('C4 subscriber copy: the chat watches the worker', manager.subscribersOf(docs.sessionId).includes(CHAT), manager.subscribersOf(docs.sessionId).join(','))

  // ---- the worker turn runs, then the wake loop must fire ----
  const workerTask = waitFor('worker task done', async () => {
    return manager.tasks({ sessionId: docs.sessionId, state: ['done'] })[0]
  }, 120_000)
  const workerTaskRow = await workerTask
  check('worker task folded done', workerTaskRow !== undefined, `#${workerTaskRow.taskId} by=${workerTaskRow.by}`)

  await waitFor('wake stamped', async () => {
    return manager.tasks({ sessionId: docs.sessionId }).find((task) => task.wokeAt !== undefined)
  }, 60_000)
  check('wake loop stamped wokeAt (real manager/task edge)', true)

  const wakeTasks = manager.tasks({ sessionId: CONCIERGE_SESSION_ID, state: ['done'] })
  check('the wake followup ran a turn on the concierge', wakeTasks.length >= 3, `concierge done tasks: ${wakeTasks.length}`)

  const wakeEvents = root.agents.get(CONCIERGE_SESSION_ID).session.snapshotEvents()
  const userMsgs = wakeEvents.filter((event) => event.type === 'user/message')
  const wakeMsg = userMsgs.find((event) => {
    const source = event.data?.message?.source ?? event.data?.source
    return source?.kind === 'manager'
  })
  if (wakeMsg === undefined) {
    console.log('   debug: user/message sources =', JSON.stringify(userMsgs.map((event) => event.data?.message?.source ?? event.data?.source)))
  }
  check('the wake message entered the log with manager provenance', wakeMsg !== undefined, wakeMsg?.data?.message?.source?.origin ?? wakeMsg?.data?.source?.origin ?? '')

  const workerLast = (await manager.describe(docs.sessionId)).lastAssistantText
  check('the worker really answered (real model)', typeof workerLast === 'string' && workerLast.toLowerCase().includes('pong'), JSON.stringify(workerLast ?? '').slice(0, 60))

  // ---- M20 spot checks through the real manager ----
  const running = manager.tasks({ state: ['running'] })
  check('list_tasks surface answers the fleet question', Array.isArray(running))
  const tail = manager.tail(docs.sessionId, 5)
  check('tail_session reads the live log', tail.length > 0 && tail.every((event) => typeof event.seq === 'number'))
  manager.setSessionLabel(docs.sessionId, 'docs-nightly')
  check('set_session_label renames', (await manager.list()).some((view) => view.label === 'docs-nightly'))
} catch (error) {
  check('scenario completed without throwing', false, error instanceof Error ? error.message : String(error))
} finally {
  const failed = results.filter((result) => !result.ok)
  console.log(`\n${failed.length === 0 ? '🎉 ALL PASS' : `💥 ${failed.length} FAILED`} (${results.length - failed.length}/${results.length})`)
  await root.fiber.dispose().catch(() => {})
  process.exit(failed.length === 0 ? 0 : 1)
}
