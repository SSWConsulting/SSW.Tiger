# TIGER Portal — App Service + application OIDC / PKCE

Phase 1–2: SSW staff sign in, browse all published projects, open their meeting lists and existing HTML reports. Password-protected reports still require their existing password. No per-meeting ACL, personal filtering, roles or videos are introduced.

The Portal lists private report storage, rather than Cosmos: this preserves all published project/meeting indexes, including historical reports whose non-fatal Cosmos write failed. The processor continues generating these indexes. `portal/` is a standalone Node application; it does not change the Graph webhook's authentication.

For test-only commands and the exact configuration order, see [TEST-DEPLOYMENT.md](TEST-DEPLOYMENT.md). Production is out of scope until test acceptance.

## IdentityServer registration

In `SSW.IdentityServer`, add a **new** client to `src/SSW.IdentityServer/appsettings.json` and its environment-specific deployment substitutions. Do not reuse the Graph app or YakShaver client. Use different client IDs/secrets for test and production.

```json
{
  "Clients": {
    "TigerPortalClient": {
      "ClientId": "ssw-tiger-portal-test",
      "ClientName": "SSW TIGER Portal",
      "AllowedGrantTypes": ["authorization_code"],
      "RequirePkce": true,
      "AllowPlainTextPkce": false,
      "RequireClientSecret": true,
      "ClientSecrets": [{ "Value": "<BASE64_SHA256_OF_CLIENT_SECRET>" }],
      "RedirectUris": ["https://<TEST_PORTAL_HOST>/auth/callback"],
      "PostLogoutRedirectUris": ["https://<TEST_PORTAL_HOST>/signed-out"],
      "AllowedScopes": ["openid", "profile", "email"],
      "AlwaysIncludeUserClaimsInIdToken": true
    }
  },
  "Applications": {
    "TigerPortalClient": {
      "ClientId": "ssw-tiger-portal-test",
      "AppUrl": "https://<TEST_PORTAL_HOST>",
      "ApplicationName": "TIGER Portal",
      "DisplayName": "SSW TIGER",
      "AllowedIdps": ["Microsoft"],
      "HasCustomUi": false,
      "CustomLayout": "_Layout",
      "SkipEmailConfirmation": false
    }
  }
}
```

Merge these entries into the existing sections; never replace the full sections. Confirm the enabled Microsoft scheme's actual name before deploying. `Applications` is necessary because the external-login callback reads application configuration when provisioning a new user. Standard `openid profile email` is sufficient: no new API scope, role callback or application provisioning endpoint is needed for this Portal.

The current `Helpers/ClientHelpers.cs` only hashes secrets automatically for clients with `client_credentials`. For this authorization-code client, supply the **base64 SHA-256 hash** in `ClientSecrets` and the original secret in TIGER's Key Vault; avoid double hashing. Generate the secret through your normal secret-management process. Do not commit the original secret to either repository or put it in a frontend bundle.

No IdentityServer authentication code changes are required for this registration. The Portal requests S256 PKCE, state and nonce. Its callback validates the issuer, audience, nonce, state and ID-token signature using `openid-client`.

## SSW employee qualification (required)

Microsoft login is not proof of SSW employment. IdentityServer also serves external users. The current base configuration does not expose a verified SSW employee claim. Until one is available, set `PORTAL_EMPLOYEE_SUBJECTS` to a comma-separated list of **independently confirmed SSW employees' IdentityServer subjects**. Obtain them from the IdentityServer user store through an authorized operator; do not confuse `sub` with Entra object ID or an external login ProviderKey.

This is a bootstrap employee allowlist, not a meeting ACL or new account system. Provision all intended SSW staff in that list before rollout. Unknown users receive 403 after IdentityServer login; they cannot read project metadata or report bodies. There is no email-domain fallback, anonymous mode or trusted `x-ms-client-principal` header.

If an authoritative employee claim already exists, use `PORTAL_EMPLOYEE_CLAIM` / `PORTAL_EMPLOYEE_VALUE` instead. Only configure it after checking the signed claim and how it is maintained. Adding such a claim to IdentityServer is an optional future change, not presumed by this implementation. Eligibility is rechecked on every request; remove a subject from configuration to revoke access after app restart.

## Shared B1 hosting

Use **two separate Web Apps on one Linux B1 App Service Plan**. The existing plan name is retained to avoid moving or rebuilding the test app:

| Resource | Test | Production |
|---|---|---|
| Web App | `app-tiger-portal-test` | `app-tiger-portal-staging` |
| Portal hostname | `portal-test.sswtiger.com` | `portal.sswtiger.com` |
| Bicep environment | `test` | `staging` (the existing TIGER production naming) |
| Shared plan | `plan-tiger-portal-test` | The same plan/resource ID |
| Managed identity | `id-tiger-portal-test` | `id-tiger-portal-staging` |
| Storage account | Test dashboard account | Production dashboard account |
| IdentityServer client, secret and employee list | Test values | Separate production values |
| GitHub deployment environment | `portal-test` | `portal-production` |

The plan's `test` suffix is historical; it does not limit the plan to test workloads. Each storage account has its own private `reports` and `portal-sessions` containers. Sharing compute does not mean sharing settings, credentials, data or browser sessions. App deployment/restart remains independent, but CPU, memory, plan maintenance and scaling are shared. If the test app exhausts B1 capacity, production can be affected.

`infra/portal-plan.bicep` alone manages the single B1 plan with one instance. `infra/portal.bicep` references it as an **existing** resource, so an app deployment cannot resize/reconfigure the plan. Both app deployments must pass the same `sharedPlanName` and `sharedPlanResourceGroup`, and use the same region/OS as the plan. Do not create a separate production plan. Any later plan-level change affects both apps and needs coordinated review.

The existing test app and plan were created manually. Before the first IaC application, use what-if to adopt the exact names, region and resource group. Do not delete/recreate them or change the test app's plan just to tidy the name. If a different shared plan name is chosen later, treat moving apps and retiring the old billable plan as a separate migration.

## Azure provisioning

1. Create the dedicated IdentityServer test client, or reserve its client ID and exact callback hostname first.
2. Store the **original** client secret as `tiger-portal-oidc-client-secret` in the existing Key Vault.
3. Review `infra/portal-plan.bicep` with what-if first to adopt the existing `plan-tiger-portal-test` as the shared Linux B1 plan. Provision/adopt it once. Then deploy `infra/portal.bicep` separately for each intended app, referencing that same plan. The app template manages only the selected Web App, its managed identity and private containers; it does not create or modify the shared plan or the processing pipeline. Production app creation is a separate authorized deployment; preparing its hostname does not itself cut over production traffic.
4. Set `manageRoleAssignments=true` if the deployer has RBAC authority, otherwise grant manually:
   - Portal identity: Storage Blob Data Reader on `reports`.
   - Portal identity: Storage Blob Data Contributor on `portal-sessions`.
   - Portal identity: Key Vault Secrets User on the vault.
   - Existing processor/security-tool identity: Blob write access on `reports` (existing account-level grants may already cover it; verify).
5. Set the employee allowlist/claim. Missing employee verification deliberately prevents startup.
6. Bind and configure valid HTTPS certificates for **both** the portal and legacy dashboard hostnames. `bindCustomDomains` only creates hostname bindings after DNS verification; it does not create certificates or change DNS. Do not enable it before DNS is ready. You may initially use the app's Azure hostname as `PORTAL_ORIGIN`, with a matching IdentityServer callback, then update both when moving to the custom domain.
7. Deploy **the contents of `portal/`** as the App Service application root. `npm start` runs `src/server.js`; App Service installs locked dependencies with build automation. The manual `Portal` workflow does this after tests pass. Configure its selected `portal-test` or `portal-production` GitHub environment with `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` and `PORTAL_APP_NAME`; use Azure federated credentials for deployment.

Example shared-plan review (replace placeholders; these commands are instructions, not evidence of deployment):

```sh
az deployment group what-if --resource-group <PLAN_RESOURCE_GROUP> \
  --template-file infra/portal-plan.bicep \
  --parameters location=australiaeast sharedPlanName=plan-tiger-portal-test
```

Apply that template only after reviewing the diff. Do not run it as part of every app release.

Example test-app provisioning (no secrets in command arguments):

```sh
az deployment group create --resource-group <TIGER_RG> \
  --template-file infra/portal.bicep \
  --parameters environment=test portalOrigin=https://<TEST_PORTAL_HOST> \
    legacyHosts=<OLD_TEST_DASHBOARD_HOST> identityServerIssuer=<TEST_ISSUER> \
    sharedPlanName=plan-tiger-portal-test sharedPlanResourceGroup=<PLAN_RESOURCE_GROUP> \
    oidcClientId=ssw-tiger-portal-test \
    employeeSubjects=<CONFIRMED_IDENTITYSERVER_SUBJECTS> \
    dashboardStorageAccountName=<DASHBOARD_ACCOUNT> keyVaultName=<KEY_VAULT>
```

When separately authorized to prepare the production app, use `environment=staging`, `portalOrigin=https://portal.sswtiger.com`, production storage/vault/IdentityServer values, and the **same** shared plan parameters. The existing TIGER naming calls production `staging`; it must not be confused with IdentityServer's staging issuer. Do not apply pipeline cutover parameters or old-host redirects merely to create the app. The test and production Portal hostnames point to their own Web App hostnames, never directly to the shared plan.

If the account already has a management lifecycle policy, merge cleanup rules for `portal-sessions/login/` and `portal-sessions/session/` older than one day into it. Do not replace existing rules. Application expiry is enforced independently: login transactions expire after 10 minutes and are single-use; sessions expire after 8 hours and are deleted on logout. Blob lifecycle cleanup only removes expired stored data.

## Storage and hostname cutover

Do not switch production URLs before login and report access have passed on a test hostname. Follow this sequence:

1. Copy the existing `$web` content to the **private** `reports` container. The script preserves bytes and metadata, including encrypted password pages. It does not decrypt or rotate report passwords.

   ```sh
   export DASHBOARD_STORAGE_ACCOUNT=<ACCOUNT>
   export DASHBOARD_CONTAINER=reports
   node portal/scripts/migrate-reports.js           # count only
   node portal/scripts/migrate-reports.js --apply --manifest portal/.migration.json   # copy and verify
   ```

   Keep the manifest file for cleanup and use one migration process at a time. It records the source ETag/hash and verified destination ETag/time, and is written atomically after each copy. Existing unverified differences are rejected. After cutover, newer private root/project indexes are allowed only when the original manifest proves their initial copy; report bodies and password pages must still match. Pause old-container writers during final reconciliation. New or changed public files require reconciliation before cleanup.

2. Validate root projects, project meeting links, direct report URLs, index.html URLs, password unlock and password rotation through Portal. Also verify a non-employee cannot read reports.
3. Switch the existing pipeline infrastructure settings together:

   ```text
   dashboardBaseUrl = portal.sswtiger.com
   dashboardContainer = reports
   ```

   Use the prepared `infra/portal-test.bicepparam` or `infra/portal-staging.bicepparam` cutover file. These parameters of `infra/main.bicep` are passed to the job **and** Function App. `jobEnv.js` forwards the container because execution overrides replace the job environment. Rebuild the processor image and deploy Function code as well as infrastructure. In local/security-tool environments also set `DASHBOARD_BASE_URL=portal.sswtiger.com`, `DASHBOARD_CONTAINER=reports`.
4. Bind old/new hostnames and TLS to the Portal app and change the DNS/routing from the previous static host. Old-host requests get HTTP 308 with the same path/query, before login. The new host requires login and returns users to their original report. If a CDN/Front Door terminates the old domain, an equivalent edge redirect is acceptable; purge old cached report bodies. Do not use DNS CNAME alone as a redirect.
5. After acceptance, reconcile and explicitly remove the verified public copies:

   ```sh
   node portal/scripts/migrate-reports.js --apply --manifest portal/.migration.json --remove-public --confirm-portal-verified
   ```

   This is an explicit operator action. The script preflights the complete listing against the saved manifest before deleting anything, then deletes each source conditionally on its original ETag. Newer verified private indexes are retained; changed report bodies or changed public files block cleanup. Keep final writes paused because listings and deletes are not an atomic transaction. Clear any snapshots/versions according to retention policy and purge CDN content. Disable the old static website when no longer needed. Setting container publicAccess to None or allowBlobPublicAccess=false alone does **not** protect the Storage static website endpoint.
6. Verify an old Teams link redirects to Portal, new Teams cards use Portal URLs, the raw static endpoint no longer serves report content, and an automated meeting completes normally.

Existing staging/main infrastructure intentionally retains its old defaults until this coordinated cutover; applying unrelated infrastructure must not switch live notifications prematurely. Rollback before public removal is to restore the old pipeline settings/routing. After removal, restore from private copies only under an explicit rollback decision, because restoring `$web` re-exposes content.

## Verify locally and in CI

```sh
npm ci --prefix portal
npm test --prefix portal
npm test
```

Tests include real OIDC-library PKCE generation and signed token validation using a test issuer, state rejection, single-use transactions, session expiry/revocation, employee denial, exact password-page passthrough and old-host path/query redirects. No production login is simulated as having succeeded. Real acceptance still requires IdentityServer client configuration, Azure roles, DNS/TLS and a company account.

For manual local execution use an HTTPS development reverse proxy whose origin matches `PORTAL_ORIGIN`; register its callback with IdentityServer. The application uses Secure cookies in every environment and has no authentication bypass. Use `node --env-file=portal/.env portal/src/server.js` after filling the sample configuration. Keep `.env` untracked.
