/**
 * Capability proofs (openclaw message/contracts.ts:119-142): for every
 * `supportsX === true`, the suite demands a proof callback and fails the build
 * without it. Declaring a capability without a proof is recorded, not skipped.
 */

export type CapabilityFacts = Record<string, boolean | undefined>
export type CapabilityProof = () => void | Promise<void>

export function assertCapabilityProofs(
  facts: CapabilityFacts,
  proofs: Record<string, CapabilityProof | undefined>,
): void {
  for (const [fact, value] of Object.entries(facts)) {
    if (value === true && typeof proofs[fact] !== 'function') {
      throw new Error(`capability ${fact} is declared true but no proof callback was provided`)
    }
  }
}

export function capabilityProofNames(facts: CapabilityFacts): string[] {
  return Object.entries(facts)
    .filter(([, value]) => value === true)
    .map(([fact]) => fact)
}
