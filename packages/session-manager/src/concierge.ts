/**
 * Concierge constants and pure helpers (design §15): the well-known session
 * id, the default instructions, the prompt-section shape, and the re-awaken
 * message builder. No state, no dsh imports beyond the config type — the glue
 * that owns behavior lives in `manager.ts`, the toolset in `concierge-tools.ts`.
 */
import type { SessionManagerConfig } from './config.js'
import type { ManagerTask, TaskState } from './types.js'

/**
 * The concierge's well-known session id (§15.3): stable across restarts,
 * colon-safe for the delivery-key grammar, never colliding with `channel:*`
 * ids or random UUIDs. `managed` by construction.
 */
export const CONCIERGE_SESSION_ID = 'manager:concierge'

/** Default `/ls` label for the concierge row. */
export const DEFAULT_CONCIERGE_LABEL = 'concierge'

/** The system-prompt section name; scoped registration shadows nothing (unique). */
export const CONCIERGE_SECTION_NAME = 'session-manager:concierge'

/** After the persona (0), before tool guidance (100–199). */
export const CONCIERGE_SECTION_ORDER = 10

export const DEFAULT_CONCIERGE_INSTRUCTIONS = [
  'You are the session concierge. The user chats with you; the actual work happens in other agent sessions you operate through your session-management tools.',
  'List before acting, dispatch with clear self-contained instructions, and verify outcomes: you will be woken when a dispatched task ends — then check the result and report briefly.',
  'Never claim work you delegated, and never pretend a session exists when list_sessions says otherwise.',
].join(' ')

/** `concierge` config fragment, normalized; undefined while disabled. */
export interface ResolvedConciergeConfig {
  readonly label: string
  readonly agentPreset?: string
  readonly cwd?: string
  readonly instructions: string
}

export function resolveConciergeConfig(config: SessionManagerConfig): ResolvedConciergeConfig | undefined {
  const concierge = config.concierge
  if (concierge?.enable !== true) return undefined
  return {
    label: concierge.label !== undefined && concierge.label !== '' ? concierge.label : DEFAULT_CONCIERGE_LABEL,
    ...(concierge.agentPreset !== undefined && concierge.agentPreset !== '' ? { agentPreset: concierge.agentPreset } : {}),
    ...(concierge.cwd !== undefined && concierge.cwd !== '' ? { cwd: concierge.cwd } : {}),
    instructions: concierge.instructions ?? DEFAULT_CONCIERGE_INSTRUCTIONS,
  }
}

/** Structural `PromptSection` for the agent-scoped instructions (duck-typed, never imported). */
export function conciergeSection(instructions: string): { name: string; order: number; text: string } {
  return { name: CONCIERGE_SECTION_NAME, order: CONCIERGE_SECTION_ORDER, text: instructions }
}

/**
 * The synthetic followup that re-awakens the concierge when a task it
 * dispatched closes (§15.4). Plain text carries the whole contract — no
 * structured side channel exists for the model to miss.
 */
export function reawakenText(task: ManagerTask, label?: string): string {
  const target = label !== undefined && label !== '' ? `"${label}" (${task.sessionId})` : task.sessionId
  const reason = task.reason !== undefined ? ` (reason: ${task.reason})` : ''
  const original = task.summary !== '' ? ` Its instruction was: ${task.summary}.` : ''
  return `Task #${task.taskId} on ${target} ended: ${task.state}${reason}.${original} Check the outcome with describe_session if details matter, then report the result to the user; stay quiet only if the user already saw it.`
}

/**
 * The loop's own brake (§15.4). The wake path is at-least-once and nothing
 * bounds it: a session that keeps crashing can ping-pong against the
 * concierge forever, two LLM turns per cycle and nobody asking for it. So the
 * per-target streak is counted here — in memory, deliberately: it is a liveness
 * guard for THIS process, not a durable fact about the task.
 */
export const DEFAULT_WAKE_LIMIT = 3

export interface WakeBudget {
  /** Consecutive unsuccessful terminal tasks seen for this target session. */
  readonly streak: number
  /** Whether the brake is already engaged (the humans were told once). */
  readonly cut: boolean
}

export const INITIAL_WAKE_BUDGET: WakeBudget = { streak: 0, cut: false }

export type WakeDecision =
  | { readonly action: 'wake'; readonly next: WakeBudget }
  /**
   * The brake is engaged: no synthetic followup this time. `notice` is set
   * only on the edge INTO the cut (one message to the humans, not one per
   * task), so a stuck loop stays silent until it actually changes.
   */
  | { readonly action: 'cut'; readonly next: WakeBudget; readonly notice: string | undefined }

const UNSUCCESSFUL: readonly TaskState[] = ['failed', 'crashed']

/**
 * One pure step of the brake. `limit <= 0` disables it entirely (the wake
 * path then behaves exactly as §15.4 shipped). A successful task clears the
 * streak and re-arms the loop — progress is what re-opens it, not time.
 */
export function wakeBudgetReduce(
  budget: WakeBudget,
  input: { state: TaskState; limit: number; sessionId: string; label?: string },
): WakeDecision {
  const successful = !UNSUCCESSFUL.includes(input.state)
  if (successful || input.limit <= 0) {
    const next = successful ? INITIAL_WAKE_BUDGET : { streak: budget.streak + 1, cut: false }
    return { action: 'wake', next }
  }
  const streak = budget.streak + 1
  const next: WakeBudget = streak >= input.limit ? { streak, cut: true } : { streak, cut: false }
  if (!next.cut) return { action: 'wake', next }
  const target = input.label !== undefined && input.label !== '' ? `"${input.label}"` : input.sessionId
  const notice = budget.cut
    ? undefined
    : `Automatic re-awakening stopped for ${target}: ${streak} tasks in a row ended ${input.state}. It resumes by itself after one succeeds — dispatch there yourself, or ask the concierge to.`
  return { action: 'cut', next, notice }
}
