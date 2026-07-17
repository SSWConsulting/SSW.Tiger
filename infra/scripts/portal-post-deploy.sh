#!/bin/bash
# Portal post-deploy checklist / verifier.
#
# After `deployPortal=true` runs, four things still must be true before the
# portal is safe and usable. This script CHECKS them (read-only by default) and
# prints the exact remediation command for anything missing. It only mutates the
# Entra app registration when you pass --apply, and asks first.
#
# The single most important check is #2: the "Azure Static Web Apps (Linked)"
# EasyAuth provider on the Portal API Function App. Without it, the anonymous
# functions accept forged x-ms-client-principal headers from direct callers and
# per-user isolation is defeated.
#
# Usage:
#   ./portal-post-deploy.sh <environment> [--apply]
#   GRAPH_APP_ID=<clientId> ./portal-post-deploy.sh test
#
# Env overrides:
#   RESOURCE_GROUP   Azure resource group (defaults to the Dev RG)
#   GRAPH_APP_ID     Reused Entra app registration's Application (client) ID.
#                    If unset, the script tries to read it from Key Vault.
#   KEY_VAULT_NAME   Key Vault holding graph-client-id (default: kv-tiger-<env>)

set -euo pipefail

ENV="${1:?Usage: ./portal-post-deploy.sh <environment> [--apply]}"
APPLY=""
[ "${2:-}" = "--apply" ] && APPLY="1"

RESOURCE_GROUP="${RESOURCE_GROUP:-SSW.Transcript-Intelligence-Group-Event-Reasoning.Dev}"
FUNC_APP="func-tiger-portal-${ENV}"
SWA_NAME="swa-tiger-portal-${ENV}"
KEY_VAULT_NAME="${KEY_VAULT_NAME:-kv-tiger-${ENV}}"

az() { MSYS_NO_PATHCONV=1 command az "$@"; }
ok()   { echo "  [ OK ] $*"; }
warn() { echo "  [WARN] $*"; }
bad()  { echo "  [FAIL] $*"; }

echo "== Portal post-deploy checks for '${ENV}' (RG: ${RESOURCE_GROUP}) =="
echo

# --- 1. SWA exists + default hostname -------------------------------------
echo "1. Static Web App"
SWA_HOST=$(az staticwebapp show -n "$SWA_NAME" -g "$RESOURCE_GROUP" --query "defaultHostname" -o tsv 2>/dev/null || echo "")
if [ -z "$SWA_HOST" ]; then
  bad "SWA '${SWA_NAME}' not found. Did the deployment run with deployPortal=true?"
  exit 1
fi
ok "SWA host: https://${SWA_HOST}"
REDIRECT_URI="https://${SWA_HOST}/.auth/login/aad/callback"

# --- 2. CRITICAL: EasyAuth "Azure Static Web Apps (Linked)" provider -------
echo "2. Backend auth boundary (the critical one)"
FUNC_ID=$(az functionapp show -n "$FUNC_APP" -g "$RESOURCE_GROUP" --query id -o tsv 2>/dev/null || echo "")
if [ -z "$FUNC_ID" ]; then
  bad "Function App '${FUNC_APP}' not found."
  exit 1
fi
AUTH=$(az rest --method GET \
  --url "https://management.azure.com${FUNC_ID}/config/authsettingsV2?api-version=2023-12-01" \
  --query "properties.globalValidation.requireAuthentication" -o tsv 2>/dev/null || echo "")
PROVIDERS=$(az rest --method GET \
  --url "https://management.azure.com${FUNC_ID}/config/authsettingsV2?api-version=2023-12-01" \
  --query "properties.identityProviders" -o json 2>/dev/null || echo "{}")
if [ "$AUTH" = "true" ] && echo "$PROVIDERS" | grep -qi "static"; then
  ok "EasyAuth requires authentication and a Static Web Apps linked provider is present."
else
  bad "The 'Azure Static Web Apps (Linked)' provider was NOT detected (requireAuthentication='${AUTH}')."
  bad "The backend may accept forged identity headers. Re-link to provision it:"
  echo "        az staticwebapp backends link -n ${SWA_NAME} -g ${RESOURCE_GROUP} \\"
  echo "          --backend-resource-id ${FUNC_ID} --backend-region <func-region>"
fi

# --- 3. Redirect URI on the reused Graph app registration -----------------
echo "3. Entra redirect URI"
if [ -z "${GRAPH_APP_ID:-}" ]; then
  GRAPH_APP_ID=$(az keyvault secret show --vault-name "$KEY_VAULT_NAME" --name graph-client-id --query value -o tsv 2>/dev/null || echo "")
fi
if [ -z "${GRAPH_APP_ID:-}" ]; then
  warn "GRAPH_APP_ID unknown (set it or ensure ${KEY_VAULT_NAME} holds graph-client-id). Need redirect URI:"
  echo "        ${REDIRECT_URI}"
else
  EXISTING=$(az ad app show --id "$GRAPH_APP_ID" --query "web.redirectUris" -o tsv 2>/dev/null || echo "")
  if echo "$EXISTING" | grep -qxF "$REDIRECT_URI"; then
    ok "Redirect URI already registered: ${REDIRECT_URI}"
  else
    warn "Missing redirect URI: ${REDIRECT_URI}"
    if [ -n "$APPLY" ]; then
      read -r -p "  Add it to app registration ${GRAPH_APP_ID}? [y/N] " a
      if [ "$a" = "y" ] || [ "$a" = "Y" ]; then
        NEW_URIS=$(printf '%s\n%s' "$EXISTING" "$REDIRECT_URI" | grep -v '^$' | sort -u)
        # shellcheck disable=SC2086
        az ad app update --id "$GRAPH_APP_ID" --web-redirect-uris $NEW_URIS && ok "Added."
      fi
    else
      echo "        az ad app update --id ${GRAPH_APP_ID} --web-redirect-uris ${EXISTING} ${REDIRECT_URI}"
      echo "        (re-run with --apply to add interactively)"
    fi
  fi
fi

# --- 4. Manual reminders --------------------------------------------------
echo "4. Manual follow-ups"
warn "staticwebapp.config.json: replace REPLACE_WITH_SSW_TENANT_ID with the SSW tenant GUID, then redeploy the SPA."
warn "Graph app registration must allow user sign-in: Web platform + ID tokens enabled + delegated openid/profile/email."
warn "SWA SPA deploy needs the secret AZURE_STATIC_WEB_APPS_API_TOKEN_PORTAL_${ENV^^}:"
echo "        az staticwebapp secrets list -n ${SWA_NAME} -g ${RESOURCE_GROUP} --query 'properties.apiKey' -o tsv"

echo
echo "Done. Re-run after remediation until sections 1-3 all report [ OK ]."
