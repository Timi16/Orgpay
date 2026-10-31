#!/usr/bin/env bash
# Runs ON the server, from the repo root: deploy a commit with pm2 and roll back if unhealthy.
#   ./deploy/deploy.sh <git sha>
# First time only: see docs/DEPLOY.md (then: pm2 start ecosystem.config.cjs && pm2 save && pm2 startup).
set -euo pipefail

SHA="${1:?usage: deploy.sh <git sha>}"
API_HEALTH="${API_HEALTH:-http://127.0.0.1:4400/health}"
WEB_HEALTH="${WEB_HEALTH:-http://127.0.0.1:3400/}"
cd "$(dirname "$0")/.."
PREVIOUS="$(git rev-parse HEAD)"

# Edits to tracked files on the server would block the checkout (or be silently deployed).
# .env and apps/web/.env.production are untracked, so they are never in the way.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "The server has local changes to tracked files:" >&2
  git status --short --untracked-files=no >&2
  echo "Undo them (e.g. git checkout -- pnpm-lock.yaml) and run the deploy again." >&2
  exit 1
fi
if [ ! -f apps/web/.env.production ]; then
  echo "apps/web/.env.production is missing: the dashboard needs NEXT_PUBLIC_API_URL at build time (docs/DEPLOY.md)." >&2
  exit 1
fi

build() {
  pnpm install --frozen-lockfile
  pnpm build        # API and worker (prisma generate + tsup)
  pnpm build:web    # the dashboard (next build, reads apps/web/.env.production)
}

release() {
  git fetch --quiet origin
  git checkout --quiet --detach "$1"
  pnpm install --frozen-lockfile
  # Migrations are additive, so the previous build can still read the schema on rollback.
  pnpm --filter @orgpay/api db:deploy   # reads DATABASE_URL from the repo-root .env
  build
  pm2 reload ecosystem.config.cjs --update-env
  pm2 save
}

ok() { [ "$(curl -s -o /dev/null -w '%{http_code}' "$1")" = "200" ]; }
healthy() {
  for _ in $(seq 1 12); do
    ok "$API_HEALTH" && ok "$WEB_HEALTH" && return 0
    sleep 5
  done
  return 1
}

release "$SHA"
if healthy; then
  echo "deployed $SHA"
  exit 0
fi
echo "health check failed; rolling back to $PREVIOUS" >&2
git checkout --quiet --detach "$PREVIOUS"
build
pm2 reload ecosystem.config.cjs --update-env
# pm2 backs off after a crash loop, so the old version can take a few seconds to come up.
if healthy; then
  echo "rolled back to $PREVIOUS and healthy again" >&2
else
  echo "ROLLBACK DID NOT RECOVER. Check: pm2 logs orgpay-api / orgpay-web, curl $API_HEALTH" >&2
fi
exit 1
