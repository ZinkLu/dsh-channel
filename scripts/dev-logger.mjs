// Dev-only logger sink. rc.6's `ctx.logger` ships with exactly one exporter — an
// in-memory ring buffer of 1000 messages — and nothing in the launcher, the
// bundles, or the host wires it to stderr or a file, so a running dsh prints
// nothing beyond `dsh web: http://…`. This plugin attaches a stderr exporter so
// the bridge's warnings (recovery, delivery failures, …) and every other
// plugin's log lines become visible. It is a patch-layer row for debugging
// profiles, never part of a published package.
//
//   - insert:
//       - id: dev-logger
//         name: ./dev-logger.mjs        # relative to the profile directory
//         config:
//           level: 3                    # 0 error · 1 info · 2 warn · 3 debug
//           levels: { hmr: 0 }          # per-logger overrides, by logger name
//
// cordis orders levels error=0 < info=1 < warn=2 < debug=3 and defaults the
// threshold to 1, so `warn` is dropped unless the exporter raises it.
import { format } from 'node:util'

export const name = 'dev-logger'
export const inject = []

const TAG = { error: 'E', info: 'I', warn: 'W', debug: 'D' }

export function apply(ctx, config = {}) {
  const level = Number.isFinite(config.level) ? config.level : 3
  ctx.logger.exporter({
    levels: { default: level, ...(config.levels ?? {}) },
    export(message) {
      const ts = new Date(message.ts).toISOString().slice(11, 23)
      process.stderr.write(`${ts} ${TAG[message.type] ?? message.type} [${message.name}] ${format(...message.args)}\n`)
    },
  })
  ctx.logger('dev-logger').info('stderr exporter attached (level %d)', level)
}
