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
#
# Credentials (shared with your other profiles via $DSH_HOME):
#   npx -y @deepseek-ai/dsh credentials set TELEGRAM_BOT_TOKEN '...'
#   npx -y @deepseek-ai/dsh credentials set DEEPSEEK_API_KEY '...'
# or plain environment variables of the same names.
#
# NOTE: two processes long-polling the same bot token fight over getUpdates
# (Telegram 409) — stop any other instance using this token first.
set -euo pipefail

DSH_VERSION="${DSH_VERSION:-0.1.0-rc.6}"
PROFILE="${DEV_BOT_PROFILE:-dev-bot}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
WORKSPACE="$REPO/agent-workspace"

command -v pnpm >/dev/null || { echo "[dev-bot] pnpm is required (profiles are pnpm-managed)"; exit 1; }

# Build once if any package has no lib/ yet (rebuilds after edits stay yours).
for p in channel channel-kit channel-telegram; do
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

# pnpm's file: dependencies are copies, not links — refresh from the current
# build on every launch so the bot never runs stale code.
rm -rf "$PROFILE_DIR/node_modules"
(cd "$PROFILE_DIR" && pnpm install --silent)

# Stand in the gitignored agent workspace: cwd derives the agent workspace by
# the same rule production uses, so the bot never writes into the repo tree.
mkdir -p "$WORKSPACE"
cd "$WORKSPACE"
exec npx -y "@deepseek-ai/dsh@$DSH_VERSION" --profile "$PROFILE" --patch "$REPO/scripts/dev-bot.yaml" "$@"
