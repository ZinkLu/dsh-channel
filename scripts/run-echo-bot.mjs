// 最小可运行示例：加载 dsh-channel + dsh-agent + dsh-credentials-local + dsh-channel-telegram。
// 当前为 echo agent（无 LLM）：普通消息原样回复，用于验证 Telegram 收发链路。
// 真实 agent 接入只需在 dsh harness 中安装本插件并配置模型。
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

// 1. 注册表 core：ctx.channels
await root.plugin(channelApply)
// 2. 服务：ctx.agents（此处仅注册表，无真实 agent loop）
await root.plugin(AgentRegistry)
// 3. 服务：ctx.credentials（local provider 读取 process.env / $DSH_HOME/.credentials.yaml）
await root.plugin(LocalCredentialProvider, { dshHome: DSH_HOME, watch: true, debounceMs: 100 })

// 4. 注入一个 echo agent factory，用于端到端验证收发链路。
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
  const reply = `[echo 模式] 你说：${text}\n\n（未配置 DEEPSEEK_API_KEY，接入真实 agent 后此处为模型回复）`
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

// 5. 加载 Telegram provider。
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

// 优雅退出。
process.once('SIGINT', async () => {
  console.log('[echo-bot] stopping...')
  await root.fiber.dispose()
  process.exit(0)
})
