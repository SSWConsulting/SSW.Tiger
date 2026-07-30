#!/bin/bash
# Verify the ONE thing that makes the Portal API safe.
#
# The Portal API's functions are authLevel:"anonymous" and they trust the
# `x-ms-client-principal` header for identity. That is only sound because the
# "Azure Static Web Apps (Linked)" EasyAuth provider — auto-provisioned when SWA
# links the backend — rejects any request that did not come through SWA.
#
# If that link is ever lost (SWA recreated, backend unlinked, the linkedBackends
# resource removed), the endpoints become reachable from the internet AND the
# identity header becomes attacker-supplied: anyone can list or impersonate any
# user by base64-encoding a principal. Nothing in the code can detect this — it
# is a platform-level control — so it gets checked here.
#
# This was once portal-post-deploy.sh and also re-checked the SWA hostname,
# registered the Entra redirect URI, and printed setup reminders. Those were
# one-off tasks done by hand with the sysadmin, and the reminders went stale
# (they referenced a config placeholder that no longer exists). The name was half
# the problem: "post-deploy" is an invitation to append more post-deploy steps,
# which is exactly how it rotted. It now verifies one thing and says so.
#
# WHEN TO RUN: after any deployment that touches the SWA or its backend link —
# a `deployPortal=true` bicep run, a re-link, a SWA recreate. NOT needed after
# shipping SPA or Function code; that cannot move this boundary.
#
# This is a point-in-time check, not monitoring. Nothing alerts if the link is
# dropped tomorrow.
#
# Requires: az CLI (logged in) and node (used to parse the authsettingsV2 JSON).
#
# Usage:
#   ./verify-portal-auth-boundary.sh <environment>
#
# Env overrides:
#   RESOURCE_GROUP   Azure resource group (defaults to the Dev RG)

set -euo pipefail

ENV="${1:?Usage: ./verify-portal-auth-boundary.sh <environment>}"
RESOURCE_GROUP="${RESOURCE_GROUP:-SSW.Transcript-Intelligence-Group-Event-Reasoning.Dev}"
FUNC_APP="func-tiger-portal-${ENV}"
SWA_NAME="swa-tiger-portal-${ENV}"

az() { MSYS_NO_PATHCONV=1 command az "$@"; }

echo "== Portal API auth boundary: ${FUNC_APP} (RG: ${RESOURCE_GROUP}) =="

FUNC_ID=$(az functionapp show -n "$FUNC_APP" -g "$RESOURCE_GROUP" --query id -o tsv 2>/dev/null || echo "")
if [ -z "$FUNC_ID" ]; then
  echo "  [FAIL] Function App '${FUNC_APP}' not found. Did the deployment run with deployPortal=true?"
  exit 1
fi

# One call, not two: the previous version fetched authsettingsV2 twice, which
# could report a provider from one response and a flag from another.
AUTH_JSON=$(az rest --method GET \
  --url "https://management.azure.com${FUNC_ID}/config/authsettingsV2?api-version=2023-12-01" \
  -o json 2>/dev/null || echo "{}")

REQUIRES_AUTH=$(echo "$AUTH_JSON" | node -pe \
  "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'))?.properties?.globalValidation?.requireAuthentication === true" \
  2>/dev/null || echo "false")
HAS_SWA_PROVIDER=$(echo "$AUTH_JSON" | node -pe \
  "Object.keys(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'))?.properties?.identityProviders ?? {}).some(k => /static/i.test(k))" \
  2>/dev/null || echo "false")

if [ "$REQUIRES_AUTH" = "true" ] && [ "$HAS_SWA_PROVIDER" = "true" ]; then
  echo "  [ OK ] EasyAuth requires authentication and the Static Web Apps linked provider is present."
  exit 0
fi

echo "  [FAIL] The 'Azure Static Web Apps (Linked)' provider was NOT detected."
echo "         requireAuthentication=${REQUIRES_AUTH}, staticWebAppsProvider=${HAS_SWA_PROVIDER}"
echo "         The API may accept forged x-ms-client-principal headers from direct callers."
echo "         Re-link to provision it:"
echo "           az staticwebapp backends link -n ${SWA_NAME} -g ${RESOURCE_GROUP} \\"
echo "             --backend-resource-id ${FUNC_ID} --backend-region <func-region>"
exit 1
