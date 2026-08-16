export interface PromptHintChannel {
  readonly id: string
  readonly formatTier: 'plain' | 'markdown' | 'html'
  readonly maxMessageChars?: number
  readonly supportsChoices: boolean
}

export function promptHint(channel: PromptHintChannel): string {
  const parts: string[] = [`You are talking to the user via ${channel.id}`]

  if (channel.formatTier === 'html') {
    parts.push('Supports limited HTML rich text (<b>, <i>, <code>, <pre>, <a>)')
  } else if (channel.formatTier === 'markdown') {
    parts.push('Supports Markdown rich text')
  } else {
    parts.push('Plain-text channel; do not output Markdown syntax')
  }

  if (channel.maxMessageChars !== undefined) {
    parts.push(`Max ${channel.maxMessageChars} chars per message`)
  }

  parts.push(channel.supportsChoices ? 'Supports buttons' : 'No buttons; structured choices degrade to numbered text')

  return `${parts.join('; ')}. Avoid wide tables; long code will be chunked.`
}
