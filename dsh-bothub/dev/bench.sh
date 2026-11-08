#!/bin/sh
# Isolated mock bench using the installed public DSH CLI.
set -eu
NAME=${1:-bothub-smoke}
WEB_PORT=${2:-3196}
MOCK_PORT=${3:-8896}
ACTION=${4:-start}
case "$NAME" in bothub-*) ;; *) echo "Use a bothub- bench name." >&2; exit 1 ;; esac
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
case "$NAME" in *[!a-z0-9-]*) echo "Invalid bench name." >&2; exit 1 ;; esac
BENCH_HOME="$ROOT/.dsh-test-$NAME"
export DSH_CLI="${DSH_CLI:-$ROOT/ds-bot/dev/harness/node_modules/.bin/dsh}"
if [ "$ACTION" = start ] || [ "$ACTION" = reset ]; then
  mkdir -p "$BENCH_HOME/profiles/web"
  node --input-type=module - "$ROOT" "$BENCH_HOME" <<'JS'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [root, home] = process.argv.slice(2)
writeFileSync(join(home, 'profiles/web/package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true,
  dependencies: { 'ds-bot': `link:${root}/ds-bot`, 'dsh-bothub': `link:${root}/dsh-bothub` },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot', 'dsh-bothub'] } },
}, null, 2))
writeFileSync(join(home, 'profiles/web/pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
JS
  (cd "$BENCH_HOME/profiles/web" && DSH_HOME="$BENCH_HOME" pnpm install --ignore-scripts --reporter=silent)
fi
exec sh "$ROOT/ds-bot/dev/bench.sh" "$NAME" "$WEB_PORT" "$MOCK_PORT" "$ACTION"
