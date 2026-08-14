// Minimal runnable example: load dsh-channel + dsh-agent + dsh-credentials-local + dsh-channel-telegram.
// Currently an echo agent (no LLM): replies to ordinary messages verbatim, used to verify the Telegram send/receive path.
// To plug in a real agent, just install this plugin in the dsh harness and configure a model.
import { Context } from '@deepseek-ai/cordis'
import { apply as channelApply } from 'dsh-channel'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { apply as telegramApply, Config as TelegramConfig, inject as telegramInject } from 'dsh-channel-telegram'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const USER_ID = Number(process.env.TELEGRAM_USER_ID)
if (!Number.isInteger(USER_ID) || USER_ID <= 0) {
  console.error('TELEGRAM_USER_ID is not set or invalid')
  process.exit(1)
}
const DSH_HOME = process.env.DSH_HOME ?? join(tmpdir(), 'dsh-channel-echo-bot')
const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set')
  process.exit(1)
}

const root = new Context()

// 1. Registry core: ctx.channels
await root.plugin(channelApply)
// 2. Service: ctx.agents (registry only here, no real agent loop)
await root.plugin(AgentRegistry)
// 3. Service: ctx.credentials (local provider reads process.env / $DSH_HOME/.credentials.yaml)
await root.plugin(LocalCredentialProvider, { dshHome: DSH_HOME, watch: true, debounceMs: 100 })

// 4. Inject an echo agent factory to verify the send/receive path end to end.
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
    throw new Error('echo mode: no persistence')
  },
})

function scheduleEcho(agent, message) {
  const text = message.content?.map((block) => block.text ?? '').join('\n') ?? ''
  const reply = `[echo mode] You said: ${text}\n\n(No DEEPSEEK_API_KEY configured; after a real agent is plugged in, this becomes the model reply)`
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

// 5. Load the Telegram provider.
const config = {
  allowedUserIds: [USER_ID],
  provider: 'echo',
  model: 'echo',
  pollingTimeoutSec: 30,
  mergeWindowSec: 5,
  approvalTimeoutSec: 120,
  statePath: join(DSH_HOME, 'channel-telegram', 'state.json'),
}
await root.plugin({ name: 'dsh-channel-telegram', inject: telegramInject, Config: TelegramConfig, apply: telegramApply }, config)

console.log(`[echo-bot] started. DSH_HOME=${DSH_HOME} user_id=${USER_ID}`)
console.log('[echo-bot] Telegram bot is polling. Send /help or any message to t.me/dsh_channel_bot')

// Graceful shutdown.
process.once('SIGINT', async () => {
  console.log('[echo-bot] stopping...')
  await root.fiber.dispose()
  process.exit(0)
})
