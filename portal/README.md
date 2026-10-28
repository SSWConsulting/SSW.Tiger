# TIGER Portal — App Service + application OIDC / PKCE

Phase 1–2: SSW staff sign in, browse all published projects, open their meeting lists and existing HTML reports. Password-protected reports still require their existing password. A persistent user/role foundation is included; no administrator UI, per-meeting ACL, personal filtering or videos are introduced.

The Portal lists private report storage, including historical reports whose non-fatal Cosmos write failed. It enriches published meetings with Cosmos metadata (participant count, duration and action items), querying summary fields only. Meetings without a Cosmos record remain visible without metadata chips. `portal/` is a standalone Node application; it does not change the Graph webhook's authentication.

Project titles and **View all** open `/{project}/` as a native Portal page, with shared branding, account navigation, breadcrumbs and a complete meeting list using the original static index’s SSW square motif, date/time headings and individual meeting cards. `/{project}/index.html` is also handled by this route for existing links. Neither address reads a static project HTML body. The meeting list comes directly from published report paths, so it works without project index blobs. Project names use the latest report's `displayname` metadata, falling back to legacy project-index metadata or the project slug. Private-container deployments publish meeting reports only; static root/project indexes are retained only for legacy `$web` deployments until cutover. Existing static index blobs can be retired after migration verification; these code changes do not delete live blobs or change DNS. Individual meeting HTML and password unlock pages continue to be served as before.

For test-only commands and the exact configuration order, see [TEST-DEPLOYMENT.md](TEST-DEPLOYMENT.md). Production is out of scope until test acceptance.

## IdentityServer registration

In `SSW.IdentityServer`, add a **new** client to `src/SSW.IdentityServer/appsettings.json` and its environment-specific deployment substitutions. Do not reuse the Graph app or YakShaver client. Use the same `ssw-tiger-portal` client ID in both IdentityServer environments, with separate issuers and URL substitutions. Both are public clients using Authorization Code + PKCE S256 with no client secret, matching the existing SSW interactive clients.

```json
{
  "Clients": {
    "SSWTigerPortalClient": {
      "ClientName": "SSW TIGER",
      "ClientId": "ssw-tiger-portal",
      "RequirePkce": true,
      "RequireClientSecret": false,
      "AlwaysIncludeUserClaimsInIdToken": true,
      "AlwaysSendClientClaims": true,
      "AllowedGrantTypes": ["authorization_code"],
      "AllowOfflineAccess": true,
      "AllowedScopes": ["openid", "profile", "email", "offline_access", "ssw-tiger-api"],
      "RefreshTokenUsage": "Reuse",
      "RedirectUris": ["https://<TEST_PORTAL_HOST>/auth/callback"],
      "PostLogoutRedirectUris": ["https://<TEST_PORTAL_HOST>/"],
      "AllowedCorsOrigins": ["https://<TEST_PORTAL_HOST>"]
    }
  },
  "ApiScopes": [{ "Name": "ssw-tiger-api", "DisplayName": "TIGER API" }],
  "ApiResources": [{
    "Name": "tiger",
    "DisplayName": "TIGER API",
    "Scopes": ["ssw-tiger-api"],
    "UserClaims": ["sub", "email", "email_verified", "name", "full_name", "given_name", "family_name", "role"]
  }],
  "ScopeToUrlMappings": { "Mappings": { "ssw-tiger-api": "https://<TEST_PORTAL_HOST>" } },
  "Applications": {
    "SSWTigerPortal": {
      "ClientId": "ssw-tiger-portal",
      "Scope": "ssw-tiger-api",
      "RequiresAutoprovisioning": false,
      "AppUrl": "https://<TEST_PORTAL_HOST>",
      "ApplicationName": "TIGER Portal",
      "DisplayName": "SSW TIGER",
      "HasCustomUi": false,
      "CustomLayout": "_Layout",
      "SkipEmailConfirmation": false
    }
  }
}
```

Merge these entries into the existing sections; never replace the full sections. TIGER does not apply a provider filter: it uses the login providers enabled in the selected IdentityServer environment. `Applications` is necessary because the external-login callback reads application configuration when provisioning a new user. The Portal requests `openid profile email offline_access ssw-tiger-api`. The `tiger` API resource name is the access-token audience; it is different from the client ID. Environment substitutions must set `ScopeToUrlMappings.Mappings.ssw-tiger-api` to the same backend origin as `Applications.SSWTigerPortal.AppUrl`. Verify that signed ID, access and role-callback tokens carry `email` and boolean `email_verified=true` for confirmed SSW users.

Add the exact Portal origin to the environment's global `AllowedOrigins` and the client's `AllowedCorsOrigins`, preserving all existing origins. Keep scope mappings, application URLs and client URL settings within their existing environment-file sections.

Do not configure `ClientSecrets`, `OIDC_CLIENT_SECRET`, a secret hash or a Key Vault reference for Portal OIDC. The application explicitly uses `token_endpoint_auth_method=none` and still validates PKCE, state, nonce and signed ID tokens. This does not change the Graph/processor credentials used elsewhere in TIGER.

The existing registration callback currently sends no `email_verified`; TIGER rejects that callback with 403 until IdentityServer supplies a verified database-backed value. It never infers confirmation from the email suffix. An eligible user is still provisioned by the validated Portal login, so a missing registration callback does not require an access bypass. Verify the role callback independently: missing confirmation also returns 403, and IdentityServer may issue a token without TIGER roles when its role lookup fails. The Portal requests S256 PKCE, state and nonce. Its callback validates the issuer, audience, nonce, state and ID-token signature using `openid-client`.

## User registration and role API

IdentityServer calls `POST /api/User/Register` with an empty body and `GET /api/User/MyRoles` for the signed user. Both routes use Bearer JWT authentication before the cookie/session gate, so role retrieval cannot redirect into another login. They validate the trusted issuer, RS256 signature, `aud=tiger`, expiry, user `sub` and the configured client ID. Ordinary access tokens must contain `ssw-tiger-api` as a scope. IdentityServer's internal callback tokens have no scope claim: only these two routes allow that contract, and require an issued lifetime of at most 300 seconds. `/api/me` also accepts scoped Bearer user tokens; it does not accept the scope-less callback exception.

SSW users with a signed, boolean `email_verified=true` and an exact `ssw.com.au` email domain are upserted into the existing environment's Cosmos database `tiger`, container `users`, partition key `/id`. TIGER owns an internal user independently of IdentityServer's login subjects. Within the same trusted issuer, different subjects presenting the same verified SSW email automatically link to one internal user (email comparison is case-insensitive). IdentityServer configuration and code are unchanged. No tokens, passwords or report data are stored in user records.

Three record types in the same container implement this mapping:

- `user`: the internal account, owning roles, activation, profile and audit fields. New IDs are `user-<SHA256 of JSON [issuer, normalized-email]>`; the ID stays fixed when the email changes. Its `sub` is the original subject for compatibility, not the complete list of login identities.
- `identity`: ID `identity-<SHA256 of JSON [issuer, sub]>`, fields `issuer`, `sub`, `userId`. Every login identity maps to exactly one internal user. Existing bindings cannot be reassigned by changing the token email.
- `emailIdentity`: ID `email-<SHA256 of JSON [issuer, normalized-email]>`, fields `issuer`, `email`, `userId`. Create-only reservations ensure concurrent first logins converge on one internal account. Incomplete provisioning is retried on the next login; a missing mapped user denies access.

All records also carry `type` and `id`; their partition key is `/id`. Email block records remain unchanged. Identity and email mappings are issuer-scoped. The application never links different emails by name or infers aliases. A known identity can update its verified email only if the new email is not owned by another internal user. Old email reservations remain: a fresh subject presenting a retired email requires manual reconciliation rather than inheriting access.

A new identity inherits the existing internal user's roles, including explicitly granted Admin, but cannot supply or combine roles through token claims. A disabled internal user or blocked mailbox cannot gain a new active account through another login method. Every protected request resolves its login identity to the current internal account and checks activation and mailbox blocks. Session and `/api/me` `sub` continue to identify the actual login subject for token refresh; `id` identifies the shared internal user.

Existing Cosmos user records retain their original ID, roles, activation, creation date and operator audit fields. Old sessions can still resolve their subject directly. On the first registration/login using that email, the application finds a unique legacy user and adds mappings without recreating the user. If multiple legacy users already share the email, registration fails with `account_link_conflict`; do not delete or arbitrarily combine these accounts. Reconcile the canonical account and its roles/disables before rollout. Concurrent mixed old/new application versions are not supported: restart all Portal instances together for cutover and do not roll back to a subject-only build after creating mappings. No live account cleanup or cloud data migration is performed by this change.

New records have `type="user"`, `roles=["User"]`, `isActive=true`, `emailVerified=true`, `createdAt` and `updatedAt`. Only a successful, authorized Portal OIDC callback records `lastLoginAt` in UTC; registration, role queries and browsing do not update it. This is the time the user enters TIGER, which may use an existing IdentityServer SSO session, not necessarily the time they typed a password. ETag-conditional writes preserve concurrent operator changes, roles, activation and audit fields. Existing accounts cannot be reactivated by logging in or changing email.

TIGER owns roles. Token role claims and POST bodies cannot grant `Admin`; no user list, administrator-management endpoint or UI exists in this phase. Maintain roles and activation directly in Cosmos Data Explorer using authorized data-plane access. All eligible active staff, including admins, see the same projects and meetings; report passwords remain unchanged.

## Access checks and manual offboarding

Every protected page, report GET/HEAD and API request checks the current Cosmos user and email-block record without an application cache. Missing users, invalid records and database failures never fall back to cookie roles or allow access. Logout remains available for disabled users. Disabling a user does not terminate their IdentityServer account; it blocks their access to TIGER, including existing Portal sessions.

To disable one account, edit its existing `type="user"` document and set `isActive=false`, optionally adding `disabledAt`, `disabledReason` and `disabledBy`. Follow the login identity’s `userId` to the internal `type="user"` document (or use the legacy user document before mapping). Preserve its `id`, `issuer`, `sub` and existing fields. This disable covers every linked login identity; do not disable an `identity` or `emailIdentity` document. Set `isActive=true` explicitly to restore it. Do not delete the document: deletion would permit automatic provisioning at the next eligible login.

For an offboarded or compromised mailbox, also create the following document in the **same** `users` container to block existing and future accounts using that email. The partition key is the document's `id`. The block is scoped to this environment's issuer, and is checked regardless of the login method. To restore the mailbox, explicitly set `isBlocked=false`; individually disabled users remain disabled.

```json
{
  "id": "email-block-<SHA256 of JSON [issuer, lowercase-email]>",
  "type": "emailBlock",
  "issuer": "https://<IDENTITYSERVER_ISSUER>",
  "email": "staff@ssw.com.au",
  "isBlocked": true,
  "reason": "Offboarded"
}
```

Generate the exact document ID locally from the repository root, without any database writes:

```sh
node --input-type=module <<'NODE'
import { UserStore } from './portal/src/users.js';
const users = new UserStore(null, 'https://<IDENTITYSERVER_ISSUER>');
console.log(users.emailBlockId('staff@ssw.com.au'));
NODE
```

Use the exact configured issuer without a trailing slash and the normalized lowercase email. Block the mailbox before updating individual records to close the alternate-login path. A verified corporate mailbox is the chosen first-phase admission rule, not an automatic check of current employment. Offboarding requires this manual operation; Entra synchronization is deferred. Existing `PORTAL_EMPLOYEE_SUBJECTS`, `PORTAL_EMPLOYEE_CLAIM` and `PORTAL_EMPLOYEE_VALUE` settings are obsolete and cannot bypass verification.

The `users` container has no TTL. Keep user and block records indefinitely until an intentional retention decision. Blob `portal-users` is no longer read. If a previous build already persisted users there, migrate its identity keys and operator-maintained roles/disables into Cosmos before switching; otherwise the fresh database would lose those restrictions. No cloud migration or configuration change is performed by application startup. Pre-change sessions whose users have no Cosmos record must sign in again; old cookies are never used to provision or restore accounts.

## Shared B1 hosting

Use **two separate Web Apps on one Linux B1 App Service Plan**. The existing plan name is retained to avoid moving or rebuilding the test app:

| Resource | Test | Production |
|---|---|---|
| Web App | `app-tiger-portal-test` | `app-tiger-portal-staging` |
| Portal hostname | `portal-test.sswtiger.com` | `portal.sswtiger.com` |
| Bicep environment | `test` | `staging` (the existing TIGER production naming) |
| Shared plan | `plan-tiger-portal-test` | The same plan/resource ID |
| Existing managed identity | `id-tiger-test` | `id-tiger-staging` |
| Storage account | Test dashboard account | Production dashboard account |
| IdentityServer issuer and employee list | Test values | Separate production values |
| OIDC client ID | `ssw-tiger-portal` | `ssw-tiger-portal` |
| GitHub deployment environment | `portal-test` | `portal-production` |

The plan's `test` suffix is historical; it does not limit the plan to test workloads. Each storage account has its own private `reports` and `portal-sessions` containers; each environment uses its own Cosmos `tiger/users` container. Sharing compute does not mean sharing settings, credentials, data or browser sessions. App deployment/restart remains independent, but CPU, memory, plan maintenance and scaling are shared. If the test app exhausts B1 capacity, production can be affected.

The Portal reuses the selected environment's existing user-assigned identity. `managedIdentityName` defaults to `id-${project}-${environment}`; `managedIdentityResourceGroup` defaults to the deployment resource group. The same identity is used for the App Service binding and `AZURE_CLIENT_ID` to access private Blob storage and Cosmos. Portal OIDC does not require Key Vault access. Test and production still use different identities. The Portal inherits all existing permissions of that environment's identity, including any broader storage write or processing permissions; this is not the narrower permission boundary of a dedicated Portal identity. Verify the actual grants before rollout. An unused identity from an earlier deployment is not automatically deleted.

`infra/portal-plan.bicep` alone manages the single B1 plan with one instance. `infra/portal.bicep` references it as an **existing** resource, so an app deployment cannot resize/reconfigure the plan. Both app deployments must pass the same `sharedPlanName` and `sharedPlanResourceGroup`, and use the same region/OS as the plan. Do not create a separate production plan. Any later plan-level change affects both apps and needs coordinated review.

The existing test app and plan were created manually. Before the first IaC application, use what-if to adopt the exact names, region and resource group. Do not delete/recreate them or change the test app's plan just to tidy the name. If a different shared plan name is chosen later, treat moving apps and retiring the old billable plan as a separate migration.

## Azure provisioning

1. Create the dedicated IdentityServer test client, or reserve its client ID and exact callback hostname first.
2. Confirm public-client registration with `RequireClientSecret=false`, `RequirePkce=true` and `AllowPlainTextPkce=false`; no OIDC secret needs to be created.
3. Review `infra/portal-plan.bicep` with what-if first to adopt the existing `plan-tiger-portal-test` as the shared Linux B1 plan. Provision/adopt it once. Then deploy `infra/portal.bicep` separately for each intended app, referencing that same plan and the existing environment identity. The app template manages the selected Web App, private Blob containers and the Cosmos users container; it does not create the identity or modify the shared plan or processing pipeline. Production app creation is a separate authorized deployment; preparing its hostname does not itself cut over production traffic.
4. First verify the reused identity's effective storage grants. Account-level Storage Blob Data Contributor already covers both containers. Leave `manageRoleAssignments=false` when those grants exist. Otherwise set it to `true` only if the deployer has RBAC authority, or grant manually:
   - Portal identity: Storage Blob Data Reader on `reports`.
   - Portal identity: Storage Blob Data Contributor on `portal-sessions`, plus Cosmos DB Built-in Data Reader on `tiger/meetings` and Built-in Data Contributor on the environment’s `tiger/users` container (an existing broader data-plane grant also covers it).
   - Existing processor/security-tool identity: Blob write access on `reports` (existing account-level grants may already cover it; verify).
5. Configure `COSMOS_ENDPOINT`, `COSMOS_DATABASE=tiger` and `PORTAL_USER_CONTAINER=users`. Verify the signed email-confirmation claims for each login/token path before granting access. Missing claims are denied.
6. Bind and configure valid HTTPS certificates for **both** the portal and legacy dashboard hostnames. `bindCustomDomains` only creates hostname bindings after DNS verification; it does not create certificates or change DNS. Do not enable it before DNS is ready. You may initially use the app's Azure hostname as `PORTAL_ORIGIN`, with a matching IdentityServer callback, then update both when moving to the custom domain.
7. Deploy **the contents of `portal/`** as the App Service application root. `npm start` runs `src/server.js`; App Service installs locked dependencies with build automation. Set `OIDC_API_AUDIENCE=tiger`, `COSMOS_ENDPOINT`, `COSMOS_DATABASE=tiger` and `PORTAL_USER_CONTAINER=users`. Run the local checks below, then publish manually using an authorized Azure account. Portal GitHub Actions are currently removed.

## Local validation and deployment

Portal CI and the test/staging GitHub deployment workflows were removed while deployment authorization is unavailable. Changes to Portal no longer trigger a Portal-specific workflow. Existing container and Azure Function workflows remain separate.

Run local validation before publishing:

```sh
npm test --prefix portal
node --test scripts/portal-*.test.mjs
```

The local release helpers remain available: `scripts/portal-release.mjs` provides allowlisted source packaging and runtime configuration checks, and `scripts/portal-smoke.mjs` checks the deployed revision, anonymous access restrictions and OIDC login initiation. These scripts do not install GitHub workflows or grant Azure permissions. A packaged `release.json` records the revision served by `/healthz`; source without this manifest reports `development`.

Deploy manually with an Azure account that already has access to the intended App Service. Keep test and staging targets explicit, and follow the test deployment evidence and acceptance checklist in [TEST-DEPLOYMENT.md](TEST-DEPLOYMENT.md). Review infrastructure with what-if before applying it. The removed workflow's environment locking no longer applies to manual releases; coordinate releases to the same app.

The earlier `portal-test` GitHub Environment and `id-tiger-portal-test-deploy` federated identity remain configured but unused by this branch. The deployment identity was not granted an App Service role. Staging was not configured or deployed as part of that setup. Reintroducing Actions deployment later requires a separate authorization decision.

Example shared-plan review (replace placeholders; these commands are instructions, not evidence of deployment):

```sh
az deployment group what-if --resource-group <PLAN_RESOURCE_GROUP> \
  --template-file infra/portal-plan.bicep \
  --parameters location=australiaeast sharedPlanName=plan-tiger-portal-test
```

Apply that template only after reviewing the diff. Do not run it as part of every app release.

Example test-app provisioning:

```sh
az deployment group create --resource-group <TIGER_RG> \
  --template-file infra/portal.bicep \
  --parameters environment=test portalOrigin=https://<TEST_PORTAL_HOST> \
    legacyHosts=<OLD_TEST_DASHBOARD_HOST> identityServerIssuer=<TEST_ISSUER> \
    sharedPlanName=plan-tiger-portal-test sharedPlanResourceGroup=<PLAN_RESOURCE_GROUP> \
    oidcClientId=ssw-tiger-portal \
    cosmosAccountName=cosmos-tiger-test \
    dashboardStorageAccountName=<DASHBOARD_ACCOUNT>
```

When separately authorized to prepare the production app, use `environment=staging`, `portalOrigin=https://portal.sswtiger.com`, production storage/IdentityServer values, and the **same** shared plan parameters. The existing TIGER naming calls production `staging`; it must not be confused with IdentityServer's staging issuer. Do not apply pipeline cutover parameters or old-host redirects merely to create the app. The test and production Portal hostnames point to their own Web App hostnames, never directly to the shared plan.

If the account already has a management lifecycle policy, merge separate cleanup rules: `portal-sessions/login/` older than one day and `portal-sessions/session/` older than 31 days. Remove any earlier one-day cleanup rule that also matches `session/`; it would delete active renewable sessions. Do not replace unrelated rules. Login transactions expire after 10 minutes and are single-use.

Portal requests `offline_access` and retains access/refresh tokens only in private server-side session storage; browsers receive an opaque Secure/HttpOnly cookie. The public client sends no secret when refreshing or revoking. Each protected cookie request refreshes access tokens with less than 30 seconds remaining; unexpired tokens do not trigger a refresh. Replacement refresh tokens are saved, while responses omitting a replacement retain the previous token, matching IdentityServer's `Reuse` policy. ETag-conditional writes prevent concurrent refreshes from overwriting a winning update or recreating a logged-out session. Database user/disable checks still apply on every request.

Sessions and cookies have a fixed 30-day maximum from sign-in, matching IdentityServer’s default `AbsoluteRefreshTokenLifetime=2592000`; refreshing does not extend that maximum. `invalid_grant` clears the local session and requires sign-in (401 for APIs). Temporary token endpoint failures deny the request with 503 while retaining the session for retry. Logout deletes the local session and attempts refresh-token revocation before redirecting to IdentityServer; revocation failures are logged without tokens and do not prevent local logout. Existing sessions without refresh tokens require sign-in once after this release. Local tests use an issuer stub; real staging acceptance must verify refresh, revocation and refresh-token expiry.

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


## Mock IdentityServer account-linking verification

Run `npm test --prefix portal` for the complete suite, or from the repository root:

```sh
TIGER_MOCK_EVIDENCE=/tmp/tiger-mock-identity-evidence.json node --test portal/test/mock-identity.test.js
```

This local integration test replaces only IdentityServer discovery/JWKS/token transport with a mock issuer. It uses real `createAuth`, RS256-signed ID/access tokens, PKCE S256, state/nonce checks, HTTP login callbacks, session handling, user mapping and Bearer API verification. Two independent subjects simulate Microsoft and password identities with the same verified SSW email. The test asserts one internal user and two identity mappings, shared operator-maintained roles, separate signed token refreshes, immediate shared disable for API/report GET/HEAD, rejection of a third identity while disabled, and restoration. Unverified email is rejected; a different email gets a separate user. Incoming token Admin roles do not grant Admin; the shared Admin role is deliberately assigned to the internal test user by the fixture.

Storage uses in-memory Blob/Cosmos test adapters. This does not validate the real Microsoft/password upstream login UI, IdentityServer registration or email delivery. No mock issuer, key or authentication bypass is added to runtime configuration, and no cloud resource is changed. The optional evidence JSON includes synthetic identities and results only, never tokens or private keys. Real test Cosmos persistence was separately verified as recorded in TEST-DEPLOYMENT.md.
