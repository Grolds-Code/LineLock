#!/usr/bin/env bash
set -euo pipefail

# The Codegeist submission build is deliberately deployed only to this Jira
# *development* installation. Never grant this script production access.
SITE="one-atlas-sadl.atlassian.net"
APP_ID="ari:cloud:ecosystem::app/806d313b-57d3-41d5-b781-73e48a1effe7"

if [[ "${LINELOCK_CONFIRM_DEV_SITE:-}" != "${SITE}" ]]; then
  echo "Refusing deployment: set LINELOCK_CONFIRM_DEV_SITE=${SITE} after checking the target." >&2
  exit 2
fi
if [[ -z "${FORGE_EMAIL:-}" || -z "${FORGE_API_TOKEN:-}" ]]; then
  echo "Forge authentication is missing. Configure FORGE_EMAIL and FORGE_API_TOKEN securely in the cloud environment, never in GitHub source or chat." >&2
  exit 2
fi
if ! grep -Fq "${APP_ID}" manifest.yml; then
  echo "Wrong Forge app ID. Aborting to avoid deploying another application." >&2
  exit 2
fi
if [[ ! -f package-lock.json ]]; then
  echo "Run from the LineLock repository root." >&2
  exit 2
fi

echo "[1/5] Full engineering verification"
npm run verify

echo "[2/5] Forge lint (must pass before deployment)"
npx --no-install forge lint

echo "[3/5] Deploying ONLY to the existing Forge development environment"
npx --no-install forge deploy -e development --non-interactive

echo "[4/5] Upgrade ONLY the known test Jira site"
npx --no-install forge install --upgrade --site "${SITE}" --product jira --non-interactive -e development

echo "[5/5] Checking actual Runs on Atlassian eligibility"
npx --no-install forge eligibility -e development --non-interactive

echo "Development deploy completed. Record Forge CLI output, inspect the app in Jira, and do not claim production verification."
