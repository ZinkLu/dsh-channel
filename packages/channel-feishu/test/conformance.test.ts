import { installChannelContractSuite } from 'dsh-channel-kit'
import { FeishuChannel } from '../src/channel.ts'
import type { FeishuClient } from '../src/client.ts'

const fakeClient = {
  async getTenantAccessToken(_credentials: { appId: string; appSecret: string }): Promise<string> {
    return 'tenant-token'
  },
  async sendMessage(_token: string, _receiveId: string, _text: string): Promise<string> {
    return 'om-1'
  },
} as unknown as FeishuClient

installChannelContractSuite({
  name: 'feishu',
  chunking: 'split',
  maxMessageChars: 4096,
  supportsChoices: false,
  supportsEdit: false,
  supportsMedia: false,
  proofs: {},
  async send(req) {
    const channel = new FeishuChannel({
      client: fakeClient,
      resolveCredentials: async () => ({ appId: 'app', appSecret: 'secret' }),
    })
    const result = await channel.send(req.chatKey, req.markdown)
    return { status: 'sent', platformMessageIds: [result.platformMessageId] }
  },
})
