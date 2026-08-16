// dsh-channel-kit public surface.
//
// Directory layout (one-way dependency direction: bridge → policy → format):
//   format/  leaf text & transport shaping, no decisions, no state
//   policy/  decision logic as pure functions + the policy interfaces
//   bridge/  the handler: ChannelBridge base + store
//
// Every export below keeps its historical name so existing providers/tests stay green.
export * from './format/chunk.js'
export * from './format/format.js'
export * from './format/http-proxy.js'
export * from './format/media-limit.js'
export * from './format/prompt-hint.js'
export * from './policy/approval-render.js'
export * from './policy/busy.js'
export * from './policy/deliver-queue.js'
export * from './policy/draft-throttle.js'
export * from './policy/finalization.js'
export * from './policy/merge.js'
export * from './policy/outbound-echo.js'
export * from './policy/presentation.js'
export * from './policy/prompt-render.js'
export * from './policy/recovery.js'
export * from './policy/router.js'
export * from './policy/stream.js'
export * from './policy/thinking.js'
export * from './policy/tool-display.js'
export * from './bridge/bridge.js'
export * from './bridge/store.js'
export { createJsonFileStore } from './bridge/store/json-file.js'
export * from './testing/capability-proofs.js'
export * from './testing/conformance.js'
export * from './testing/delivery-trace.js'
