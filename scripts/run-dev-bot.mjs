// Dev bot: the echo bot's runnable sibling, configured from scripts/dev-bot.yaml
// instead of environment variables, with a gitignored agent workspace inside the
// repository. Meant for anyone debugging this plugin: edit the yaml, export
// TELEGRAM_BOT_TOKEN, run — no dsh profile required.
//
//   npm run build
//   TELEGRAM_BOT_TOKEN='...' node scripts/run-dev-bot.mjs
//
// State layout (all under the gitignored workspace):
//   <workspace>/.dsh-home/.credentials.yaml        optional token file (hot-reloaded)
//   <workspace>/.dsh-home/channel-telegram/state.json   delivery ledger
import { Context } from '@deepseek-ai/cordis'
import { apply as channelApply } from 'dsh-channel'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { apply as telegramApply, Config as TelegramConfig, inject as telegramInject } from 'dsh-channel-telegram'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configPath = process.env.DEV_BOT_CONFIG ?? join(repoRoot, 'scripts', 'dev-bot.yaml')

const doc = parse(readFileSync(configPath, 'utf8'))
if (!doc || typeof doc !== 'object' || !doc.telegram) {
  console.error(`[dev-bot] ${configPath} is missing the telegram section`)
  process.exit(1)
}
const allowedUserIds = doc.telegram.allowedUserIds
if (!Array.isArray(allowedUserIds) || allowedUserIds.length === 0) {
  console.error('[dev-bot] telegram.allowedUserIds must list at least one Telegram user id')
  process.exit(1)
}

const workspace = isAbsolute(doc.workspace ?? '') ? doc.workspace : resolve(repoRoot, doc.workspace ?? 'agent-workspace')
const dshHome = join(workspace, '.dsh-home')
mkdirSync(dshHome, { recursive: true })

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.warn(`[dev-bot] TELEGRAM_BOT_TOKEN is not set — falling back to ${join(dshHome, '.credentials.yaml')}`)
}

const root = new Context()

// Same wiring as production: registry core, agent registry, credentials.
await root.plugin(channelApply)
await root.plugin(AgentRegistry)
await root.plugin(LocalCredentialProvider, { dshHome, watch: true, debounceMs: 100 })

// Echo factory: verifies the full send/receive path without a model. Swap in a
// real factory (dsh-agent-loop) to debug against an actual agent.
let seq = 0
root.agents.setFactory({
  async createAgent(_ownerCtx, options) {
    const session = { id: options.sessionId, events: [] }
    const agent = {
      id: options.sessionId,
      session,
      status: 'idle',
      followup(message) { scheduleEcho(agent, message) },
      steer(message) { scheduleEcho(agent, message) },
      inject() {},
    }
    return { agent, dispose: async () => {} }
  },
  async resume() {
    throw new Error('dev bot: no persistence')
  },
})

function scheduleEcho(agent, message) {
  const text = message.content?.map((block) => block.text ?? '').join('\n') ?? ''
  const reply = `[dev bot · echo] You said: ${text}`
  setTimeout(() => {
    const baseSeq = ++seq
    root.emit('session/event', { id: agent.id, events: [] }, {
      type: 'turn/start',
      seq: baseSeq,
      time: Date.now(),
      data: { turn: 1 },
    })
    root.emit('session/event', { id: agent.id, events: [] }, {
      type: 'assistant/message',
      seq: baseSeq + 1,
      time: Date.now(),
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: reply }],
          source: { kind: 'model', provider: 'echo', model: 'echo' },
        },
      },
    })
  }, 200)
}

const config = {
  ...doc.telegram,
  cwd: workspace,
  statePath: join(dshHome, 'channel-telegram', 'state.json'),
}
await root.plugin({ name: 'dsh-channel-telegram', inject: telegramInject, Config: TelegramConfig, apply: telegramApply }, config)

console.log(`[dev-bot] started. config=${configPath}`)
console.log(`[dev-bot] workspace=${workspace} (gitignored; the agent's cwd)`)
console.log(`[dev-bot] allowed user ids: ${allowedUserIds.join(', ')}`)
console.log('[dev-bot] Telegram bot is polling. Send /help or any message to your bot.')

process.once('SIGINT', async () => {
  console.log('[dev-bot] stopping...')
  await root.fiber.dispose()
  process.exit(0)
})
