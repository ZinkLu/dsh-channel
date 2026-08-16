/**
 * Draft finalization decision (openclaw message/live.ts:117-236). Decides how
 * a preview draft and the final assistant text relate, as a pure function so
 * the four outcomes are explicit and testable.
 */

export type FinalizationOutcome =
  /** No preview is in play; deliver the final normally. */
  | 'normal-delivered'
  /** The preview was never actually rendered; skip any preview cleanup and deliver the final normally. */
  | 'normal-skipped'
  /** Edit-in-place is cheap and the edit result is confirmed: finalize in place (one message, no delete+send). */
  | 'preview-finalized'
  /** The edit may or may not have landed; retain the preview and send the final separately. */
  | 'preview-retained'

export interface FinalizationCaps {
  readonly streamingMode: 'off' | 'block' | 'progress'
  readonly supportsEdit: boolean
}

export interface FinalizationDraftState {
  readonly draftStarted: boolean
  readonly editFailed: boolean
}

export interface FinalizationEditResult {
  readonly ok: boolean
  /** True when the final text is already visible in the preview. */
  readonly finalVisible: boolean
}

export function resolveFinalization(
  caps: FinalizationCaps,
  draftState: FinalizationDraftState,
  editResult: FinalizationEditResult,
): FinalizationOutcome {
  if (!draftState.draftStarted) return 'normal-delivered'
  if (caps.streamingMode === 'off' || !caps.supportsEdit) return 'normal-skipped'
  if (draftState.editFailed) return 'preview-retained'
  if (editResult.ok && editResult.finalVisible) return 'preview-finalized'
  if (editResult.ok) return 'normal-delivered'
  return 'preview-retained'
}
