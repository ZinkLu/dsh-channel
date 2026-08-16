import { installChannelContractSuite } from 'dsh-channel-kit'
import { WeChatChannel } from '../src/channel.ts'
import type { WeixinClient } from '../src/client.ts'

const fakeClient = {
  async sendMessage(_token: string, _chatKey: string, _text: string): Promise<{ client_id: string; message_id?: string }> {
    return { client_id: 'wx-1' }
  },
} as unknown as WeixinClient

installChannelContractSuite({
  name: 'wechat',
  chunking: 'split',
  maxMessageChars: 2000,
  supportsChoices: false,
  supportsEdit: false,
  supportsMedia: false,
  proofs: {},
  async send(req) {
    const channel = new WeChatChannel({ client: fakeClient, resolveToken: async () => 'tok' })
    const result = await channel.send(req.chatKey, req.markdown)
    return { status: 'sent', platformMessageIds: [result.platformMessageId] }
  },
})
