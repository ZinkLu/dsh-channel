import { installChannelContractSuite } from 'dsh-channel-kit'
import { TelegramChannel } from '../src/channel.ts'
import type { TelegramClient } from '../src/client.ts'

const fakeClient = {
  async sendMessage(_token: string, _chatId: string, text: string): Promise<{ message_id: number }> {
    return { message_id: 1 }
  },
} as unknown as TelegramClient

installChannelContractSuite({
  name: 'telegram',
  chunking: 'split',
  maxMessageChars: 4096,
  supportsChoices: true,
  supportsEdit: true,
  supportsMedia: true,
  proofs: {
    supportsChoices: () => {},
    supportsEdit: () => {},
    supportsMedia: () => {},
  },
  async send(req) {
    const channel = new TelegramChannel({ client: fakeClient, resolveToken: async () => 'tok' })
    const result = await channel.send(req.chatKey, req.markdown, { choices: req.choices })
    return { status: 'sent', platformMessageIds: [result.platformMessageId] }
  },
})
