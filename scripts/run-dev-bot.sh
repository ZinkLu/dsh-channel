#!/usr/bin/env bash
# Dev bot through the real dsh launcher — binary + patch YAML, the same path a
# user takes; nothing is hand-assembled. The script maintains a `dev-bot`
# profile under $DSH_HOME (web-identical bundles + this repo's packages as
# file: dependencies), refreshes the installed copies from packages/*/lib on
# every launch, then boots dsh with scripts/dev-bot.yaml as the patch layer.
#
#   npm run build                        # after code changes
#   scripts/run-dev-bot.sh               # web UI + Telegram bridge, full agent
#   scripts/run-dev-bot.sh --port 5299   # extra args go to the web app
#   DEV_BOT_LOG_LEVEL=2 scripts/run-dev-bot.sh   # runtime log threshold (default 3 = debug)
#
# Runtime logs go to stderr through scripts/dev-logger.mjs (dsh itself ships no
# log sink); session transcripts stay under $DSH_HOME/sessions as usual.
#
# Credentials (shared with your other profiles via $DSH_HOME): set them in the
# web UI's credentials page (0.2 has no `dsh credentials set` subcommand), or as
# plain environment variables of the same names:
#   TELEGRAM_BOT_TOKEN / DEEPSEEK_API_KEY
#
# NOTE: two processes long-polling the same bot token fight over getUpdates
# (Telegram 409) — stop any other instance using this token first.
set -euo pipefail

DSH_VERSION="${DSH_VERSION:-0.2.0-rc.2}"
PROFILE="${DEV_BOT_PROFILE:-dev-bot}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
WORKSPACE="$REPO/agent-workspace"

command -v pnpm >/dev/null || { echo "[dev-bot] pnpm is required (profiles are pnpm-managed)"; exit 1; }

# Build once if any package has no lib/ yet (rebuilds after edits stay yours).
for p in channel session-manager channel-kit channel-telegram; do
  if [ ! -d "$REPO/packages/$p/lib" ]; then
    (cd "$REPO" && npm run build)
    break
  fi
done

# Profile manifest: the web profile's bundle stack plus this repo's packages.
mkdir -p "$PROFILE_DIR"
cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "dsh-profile-$PROFILE",
  "private": true,
  "dependencies": {
    "dsh-channel": "file:$REPO/packages/channel",
    "dsh-session-manager": "file:$REPO/packages/session-manager",
    "dsh-channel-kit": "file:$REPO/packages/channel-kit",
    "dsh-channel-telegram": "file:$REPO/packages/channel-telegram"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
    }
  }
}
EOF
[ -f "$PROFILE_DIR/cordis.yml" ] || printf '[]\n' > "$PROFILE_DIR/cordis.yml"
[ -f "$PROFILE_DIR/cordis.patch.yml" ] || printf '[]\n' > "$PROFILE_DIR/cordis.patch.yml"
cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<'EOF'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
EOF

# The dev logger sink is a plain file the loader imports relative to the
# profile directory (`name: ./dev-logger.mjs` in dev-bot.yaml), so ship the
# current copy alongside the manifest.
cp "$REPO/scripts/dev-logger.mjs" "$PROFILE_DIR/dev-logger.mjs"

# pnpm's file: dependencies are copies, not links — refresh from the current
# build on every launch so the bot never runs stale code.
rm -rf "$PROFILE_DIR/node_modules"
(cd "$PROFILE_DIR" && pnpm install --silent)

# Stand in the gitignored agent workspace: cwd derives the agent workspace by
# the same rule production uses, so the bot never writes into the repo tree.
mkdir -p "$WORKSPACE"
cd "$WORKSPACE"
# 0.2's web app opens a browser by default; --no-open keeps the bot headless.
exec npx -y "@deepseek-ai/dsh@$DSH_VERSION" --profile "$PROFILE" --patch "$REPO/scripts/dev-bot.yaml" --no-open "$@"
