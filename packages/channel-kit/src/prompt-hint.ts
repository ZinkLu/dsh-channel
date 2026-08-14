export interface PromptHintChannel {
  readonly id: string
  readonly formatTier: 'plain' | 'markdown' | 'html'
  readonly maxMessageChars?: number
  readonly supportsChoices: boolean
}

export function promptHint(channel: PromptHintChannel): string {
  const parts: string[] = [`你正通过 ${channel.id} 与用户对话`]

  if (channel.formatTier === 'html') {
    parts.push('支持有限 HTML 富文本（<b>、<i>、<code>、<pre>、<a>）')
  } else if (channel.formatTier === 'markdown') {
    parts.push('支持 Markdown 富文本')
  } else {
    parts.push('纯文本渠道，不要输出 Markdown 语法')
  }

  if (channel.maxMessageChars !== undefined) {
    parts.push(`单条消息上限 ${channel.maxMessageChars} 字符`)
  }

  parts.push(channel.supportsChoices ? '支持按钮' : '不支持按钮，结构化选项会降级为编号文本')

  return `${parts.join('；')}。避免输出宽表格；长代码将被分段。`
}
