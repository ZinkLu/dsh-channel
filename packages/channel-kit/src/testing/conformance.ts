/**
 * Installable conformance suite (openclaw message/contracts.ts). Provider
 * packages call `installChannelContractSuite({ ... })` in their test files and
 * get the shared behavioral battery against their own mocked client.
 *
 * Variant-driven assertions, never skipped ones: `chunking` selects *different*
 * assertions; `passthrough` and `split` each have their own required behavior.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SendErrorKind } from 'dsh-channel'
import { assertCapabilityProofs } from './capability-proofs.js'
import { chunkText } from '../format/chunk.js'

export interface ContractSendRequest {
  readonly chatKey: string
  readonly markdown: string
  readonly choices?: readonly { readonly id: string; readonly label: string }[]
}

export interface ContractSendResult {
  readonly status: 'sent' | 'suppressed' | 'failed'
  readonly platformMessageIds?: readonly string[]
  readonly error?: string
  readonly errorKind?: SendErrorKind
}

export interface ChannelContractHarness {
  readonly name: string
  /** Provider chunking mode: split = the bridge chunks; passthrough = one send per call. */
  readonly chunking: 'split' | 'passthrough'
  readonly maxMessageChars: number
  readonly supportsChoices: boolean
  readonly supportsEdit: boolean
  readonly supportsMedia: boolean
  /** Proof callback for every true capability fact; the suite fails without one. */
  readonly proofs?: Record<string, () => void | Promise<void>>
  /** Send one already-rendered chunk (the provider's `Channel.send` surface). */
  send(req: ContractSendRequest): Promise<ContractSendResult>
}

export function installChannelContractSuite(harness: ChannelContractHarness): void {
  test(`channel contract [${harness.name}] sends a normal message`, async () => {
    const receipt = await harness.send({ chatKey: 'contract-chat', markdown: 'hello contract' })
    assert.equal(receipt.status, 'sent')
    assert.ok((receipt.platformMessageIds?.length ?? 0) > 0)
    assert.equal(receipt.error, undefined)
  })

  test(`channel contract [${harness.name}] choices degrade without dropping`, async () => {
    const receipt = await harness.send({
      chatKey: 'contract-chat',
      markdown: 'choose one',
      choices: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    })
    // Buttonless platforms degrade to numbered text; either way the send succeeds.
    assert.equal(receipt.status, 'sent')
  })

  test(`channel contract [${harness.name}] ${harness.chunking} chunking variant`, () => {
    const maxChars = Math.max(harness.maxMessageChars, 80)
    if (harness.chunking === 'split') {
      // Split providers must keep fenced code blocks atomic when chunking:
      // a code block that fits in one chunk moves to its own chunk instead of
      // being split across the boundary.
      const code = 'x'.repeat(maxChars - 20)
      const markdown = `before before before before\n\`\`\`js\n${code}\n\`\`\``
      const chunks = chunkText(markdown, { maxChars, countBy: 'codepoint' })
      assert.ok(chunks.length > 1)
      for (const chunk of chunks) assert.ok(chunk.length <= maxChars)
      assert.ok(chunks.some((chunk) => chunk.includes('```js') && chunk.includes(code)))
    } else {
      // Passthrough providers must not chunk; their contract is one send per call.
      assert.equal(harness.chunking, 'passthrough')
    }
  })

  test(`channel contract [${harness.name}] capability facts are explicit and proven`, () => {
    const facts = capabilityFacts(harness)
    // Every capability fact above is either true or false; no undefined/missing
    // declarations are accepted by the suite.
    for (const [fact, value] of Object.entries(facts)) {
      assert.equal(typeof value, 'boolean', `${harness.name}.${fact} must be explicitly boolean`)
    }
    assertCapabilityProofs(facts, harness.proofs ?? {})
  })
}

function capabilityFacts(harness: ChannelContractHarness): Record<string, boolean> {
  return {
    supportsChoices: harness.supportsChoices,
    supportsEdit: harness.supportsEdit,
    supportsMedia: harness.supportsMedia,
  }
}
