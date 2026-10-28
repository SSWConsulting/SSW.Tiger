# Test-only Portal and IdentityServer integration

## Portal Actions removed — 2026-10-28

At the user's request, Portal CI and both Portal deployment workflows were removed while Azure deployment authorization is unavailable. Validation and publishing remain local/manual; see [Local validation and deployment](README.md#local-validation-and-deployment). Existing container/Function workflows and application/runtime resources were not changed by this removal.

Earlier setup created GitHub Environment `portal-test` with ten variables and the deployment identity `id-tiger-portal-test-deploy` (client ID `7be35e11-989b-45df-972b-07e0e32c719c`, principal ID `4db2d485-748d-4ea9-94b7-69277fc15ede`). Its OIDC federation trusts `repo:SSWConsulting/SSW.Tiger:environment:portal-test`. These configurations remain unused by this branch; no Azure role assignment was granted and no staging configuration was created.

Historical test workflow [run 40626512714](https://github.com/SSWConsulting/SSW.Tiger/actions/runs/40626512714), from `portal-settings` at `0afd0e5`, passed Portal/release-tool tests, Bicep compilation and artifact packaging, then failed at `azure/login@v2`. It did not reach deployment or post-deploy checks. Test SCM basic publishing authentication was read back as disabled and was not changed; no publish profile was fetched.

This runbook only targets TIGER **test** and the selected **IdentityServer test/staging** environment. It does not authorize production deployment. The resources whose names contain `staging` may serve TIGER production; do not use `infra/portal-staging.bicepparam`, `infra/staging.bicepparam`, the `latest` image, production DNS or the production IdentityServer issuer for this validation.

## Portal meeting-list presentation — 2026-10-28

Deployed the current `portal/` application source to `app-tiger-portal-test` only, using OneDeploy `49c9bf5c-ae25-4ad9-b21e-2d33aa439bb9` (`status=4`, complete and active). Package `/tmp/tiger-portal-ui-test-20261028.zip` SHA-256: `77d949c39cbc478ef97fd3298fed1b44d495ca281b279403db853b4d00685e8a`. All 48 Portal tests passed before upload. Kudu read-back matched the package manifest for `src/app.js`, `src/views.js`, `src/projects.js`, `src/storage.js` and `public/portal.css`.

The test app was restarted after the remote Oryx build; dependency extraction delayed startup, after which `/healthz` returned 200. Authenticated browser verification showed all 16 projects, the original calendar tiles, the latest three meetings horizontally in the `test` project row, single-line titles with ellipsis, and participant counts in native hover text. `View all` opened `/test/` with all six meetings and visible participant chips. The example `152902-e1920a4b` is now displayed as `Meeting · 15:29`. This pass did not test report password unlock or a new processing run. No production deployment, infrastructure/role/configuration change, pipeline cutover or DNS change was made.

## Account linking deployment and validation — 2026-10-28

The current local Portal source was deployed only to `app-tiger-portal-test` using OneDeploy ID `79ddb5ec-3030-4a8a-8f46-30d397bcb7d2` (`status=4`, successful remote Oryx build). The package `/tmp/tiger-portal-identity-link-test-20261028.zip` has SHA-256 `ce5ad447945c3ccaf9da5bf18ec3d2ed323e01e62c9e42612b6c3839e61096ab`. Kudu read-back confirmed that both deployed `src/users.js` and `src/app.js` match the package manifest. The test app was restarted, `/healthz` returned 200, and a fresh authenticated `/api/me` request returned the new internal `id` while preserving the original login `sub`. The test app retains Node 22, `npm start`, IdentityServer staging and test Cosmos `tiger/users`. No production resource, shared-plan setting, pipeline, DNS or IdentityServer code/configuration was changed.

Validation results:

- All 45 local Portal tests passed before deployment.
- Real test Cosmos integration with isolated synthetic verified claims: concurrent distinct subjects with the same email shared one internal user; changing stored roles affected both identities; disabling denied both identities and a third attempted identity; explicit restoration restored access. All four temporary records (user, email reservation and two identity mappings) were deleted in `finally`. This validates real database behavior, **not** real IdentityServer authentication. Evidence: `/tmp/tiger-identity-link-live-cosmos-evidence.json`.
- With explicit user approval, the existing staff test account's roles were temporarily set to `[]`; its existing Chrome session immediately read back `roles: []`. Setting its internal `isActive=false` made `/api/me` return `account_disabled` and blocked the existing single-meeting report URL. The account was restored to its original `roles=["User"]`, `isActive=true`, and the browser read back the restored role and same internal ID. Real employee identities were not fabricated or linked by the validation scripts.
- Full same-email Microsoft-versus-password login acceptance remains **pending**. The user attempted password-account registration in IdentityServer staging, but the registration POST returned HTTP 500 at 2026-10-28 10:25:57 Asia/Shanghai. Application Insights operation `009a18e7f285abe1df9dcfc460144d07` records `AADSTS7000222`: the client secret for Azure application `a59b15f6-11be-4520-9c21-f541a86322c5` is expired. The exception stack runs through `EmailService.SendEmailAsync`, `RegistrationEmailConfirmationService.Send` / `SendConfirmation` and `RegisterModel.OnPostAsync`. The user received no confirmation email. Source order suggests the password account may already exist because creation precedes email sending; this was not independently checked in the identity database. Do not repeatedly register or bypass `email_verified`. An authorized IdentityServer maintainer must repair the mail credential and complete confirmation before resuming the second real login.

Direct IdentityServer application-log download was denied by Azure RBAC; the diagnosis above used read-only Application Insights queries successfully. No identity account, secret or mail configuration was changed.

## Verified test integration — 2026-10-28

The test Portal source was deployed to `app-tiger-portal-test` (deployment `13fdbfd2-57ca-45e1-84e3-0ef3f1b2ba76`). Its origin is the Azure hostname in `infra/portal-app-test.bicepparam`; its issuer is IdentityServer staging and its client ID is `ssw-tiger-portal`. The obsolete `OIDC_CLIENT_SECRET` app setting was removed. Settings were applied with targeted Azure CLI commands; the application Bicep what-if succeeded but a Bicep create was not run in this session. The shared plan, processor pipeline, production resources and DNS were not changed.

The existing `id-tiger-test` identity has a Cosmos data contributor assignment. The test `tiger/users` container was created with partition key `/id`. All 32 existing test blobs were copied from `satigertestweb/$web` into private `reports`, with content verification and a local manifest at `/tmp/tiger-portal-test-migration-20261028.json`; no public source was deleted. Historical blobs with empty metadata exposed a migration SDK validation error, which was fixed and covered by a regression test before retrying the copy.

An initial startup failure occurred while the old empty application directory was still running during the remote build. After build completion and a test-app restart, `/healthz` returned 200 and the application logged `TIGER Portal listening on 8080`. `/auth/login` returned 302 to the staging authorization endpoint with the correct callback, `ssw-tiger-portal`, `openid profile email offline_access ssw-tiger-api`, S256, state, nonce and a Secure/HttpOnly transaction cookie.

The user completed a real company-account login in Chrome and reached the authenticated project list (16 projects). An earlier attempt showed `Sign-in expired`; restarting from the Portal homepage in the same browser succeeded. Browser checks then confirmed **View all** opens the native `/test/` page with all six meetings, a historical protected report still shows its password unlock page, both `/yakshaver/` and `/yakshaver/index.html` show the native Portal project page, and `/yakshaver/2026-03-16/` renders the original meeting dashboard. Anonymous `/yakshaver/?tab=all` returns 302 with the original path/query preserved in `returnTo`. Live password unlock, refresh after token expiry, user disabling, role callbacks and logout were not exercised in this browser acceptance pass; no end-to-end processing job or production cutover was run.

Use `infra/portal-app-test.bicepparam` for Portal application infrastructure only. `infra/portal-test.bicepparam` changes the transcript-processing pipeline and is a separate cutover step. The current Portal renders project routes natively without static index HTML. Existing legacy static deployments are retained until their environment is switched.

## 1. Confirm inputs and tools

Use Node.js 22+, Azure CLI, Bicep and GitHub CLI. Sign in to the intended Azure tenant/subscription. Do not print connection strings or client secrets.

```sh
az login
az account show --query '{subscription:id, tenant:tenantId, name:name}'
```

Confirm the following values before provisioning. Names below are based on current Bicep naming, not proof that deployed resources exist:

| Setting | Test value / action |
|---|---|
| Resource group | Confirm the group containing `func-tiger-test`; it may be shared with production |
| Test Portal app | `app-tiger-portal-test` |
| Shared B1 plan | `plan-tiger-portal-test` (existing name; both apps will reference this plan) |
| Plan resource group / region | Confirm the existing plan's resource group and Australia East location |
| Existing managed identity reused by Portal | `id-tiger-test` |
| Dashboard storage | Expected `satigertestweb`; confirm the test account, never the staging account |
| New hostname | `portal-test.sswtiger.com`, or initially the app's `*.azurewebsites.net` hostname |
| Old hostname | Confirm the existing test dashboard hostname before changing routing |
| IdentityServer issuer | Obtain the test/staging issuer from its deployed environment; explicitly override the production default |
| IdentityServer client | `ssw-tiger-portal` |
| Employee subjects | Confirm test users' IdentityServer `sub` values **in that issuer's user store** |

Fetch `<TEST_ISSUER>/.well-known/openid-configuration` read-only. Confirm its returned `issuer`, endpoints and S256 support. A production issuer's `sub` or client registration may not exist in staging.

## 2. Register only the IdentityServer test client

In the IdentityServer repository, add the `Clients.SSWTigerPortalClient` and `Applications.SSWTigerPortal` entries shown in [README.md](README.md#identityserver-registration). Include them in **staging/test deployment substitutions**, including callback, post-logout URL and application URL. The same branch may prepare global production substitutions, but only staging is published for this test. Leave existing clients unchanged and do not run a production deployment.

The base IdentityServer configuration fixes both `Clients.SSWTigerPortalClient.ClientId` and `Applications.SSWTigerPortal.ClientId` to `ssw-tiger-portal`, using the normal enabled default. Environment files override only callback/logout, AppUrl and scope API URLs. Test and production trust different issuers despite sharing the client ID. The deployed test App still has the earlier client ID until a separately authorized settings update; align it before login testing.

Required client settings:

```text
ClientName                 SSW TIGER
ClientId                   ssw-tiger-portal
RequirePkce                true
RequireClientSecret        false
AlwaysIncludeUserClaimsInIdToken true
AlwaysSendClientClaims     true
AllowedGrantTypes          authorization_code
AllowOfflineAccess         true
AllowedScopes              openid, profile, email, offline_access, ssw-tiger-api
RefreshTokenUsage          Reuse
RedirectUris               https://<TEST_PORTAL_HOST>/auth/callback
PostLogoutRedirectUris      https://<TEST_PORTAL_HOST>/
AllowedCorsOrigins         https://<TEST_PORTAL_HOST>
```

Add matching `Applications` settings with the same ClientId and test AppUrl. Leave TIGER client `IdentityProviderRestrictions` and application `AllowedIdps` unset so login uses the providers enabled in that IdentityServer environment. Include `ssw-tiger-api` in ApiScopes and AllowedScopes, register the `tiger` ApiResource with the user claims shown in README, set `Applications.SSWTigerPortal.Scope=ssw-tiger-api`, and map that scope to the test backend origin. Keep `RequiresAutoprovisioning=false` so unrelated SSW sign-ins do not provision TIGER users. The existing IdentityServer logic calls TIGER registration and role endpoints; no shared authentication code changes are needed. First test with an existing confirmed company identity; separately check new-user provisioning/email confirmation if needed.

No OIDC client secret, secret hash or Key Vault reference is required. TIGER explicitly sends `client_id` and the PKCE verifier without an Authorization header or `client_secret`. Keep S256, exact HTTPS callbacks, state, nonce and signed-token validation enabled.

For Azure-hostname testing, `infra/portal-app-test.bicepparam` uses `https://app-tiger-portal-test-d4dubvh9g5eeeaea.australiaeast-01.azurewebsites.net` as `PORTAL_ORIGIN`. The IdentityServer staging branch includes this origin and the future custom test origin in its callback/logout allowlists. No DNS change is needed for the initial Azure-hostname test.

Deploy only the IdentityServer staging/test application through its existing staging workflow. Verify the effective registration is deployed; editing local appsettings alone has no effect on the running service.

## 3. Provision only the test Portal

First review/adopt the **existing** `plan-tiger-portal-test` using `infra/portal-plan.bicep`. This is the single shared Linux B1 plan, not a new plan per environment. The manually created test plan and app should be adopted in place:

```sh
az deployment group what-if --resource-group <PLAN_RESOURCE_GROUP> \
  --template-file infra/portal-plan.bicep \
  --parameters location=australiaeast sharedPlanName=plan-tiger-portal-test
```

Verify the existing plan stays Linux B1 with one instance. Apply it only after reviewing the diff; do not blindly change the SKU of an existing shared plan. Do not create or deploy the production Web App during this test procedure. Once production uses the plan, plan-level changes can affect it even when initiated for testing.

Then use `infra/portal.bicep` with **explicit** test parameters. It references the existing shared plan and cannot change its SKU. It does not deploy the production Web App or modify the existing pipeline. A local parameter file can avoid shell-quoting problems with the employee list; do not commit real subject lists.

`infra/portal-app-test.bicepparam` records the verified test infrastructure names and IdentityServer staging issuer. It is an **application infrastructure** parameter file, distinct from `infra/portal-test.bicepparam`, which switches the processing pipeline. The application file leaves role assignments and custom domain bindings disabled, contains no secret or employee subjects, and does not make login ready by itself. Supply confirmed employee subjects or a trusted employee claim separately before deploying application code.

```sh
az deployment group what-if \
  --resource-group SSW.Transcript-Intelligence-Group-Event-Reasoning.Dev \
  --parameters infra/portal-app-test.bicepparam
```

The initial 2026-10-27 preview with role assignments enabled failed because the signed-in operator lacked `Microsoft.Authorization/roleAssignments/write`. The design now reuses `id-tiger-test`, whose existing Storage Blob Data Contributor grant on `satigertestweb` covers both private containers. Keep role assignment management disabled; no additional grants are needed while those grants remain effective. User storage now uses Cosmos `tiger/users`, which is not provisioned by those earlier deployments. Blob permissions do not grant Cosmos access; verify the identity’s Cosmos data-plane grant before deploying this revision. If they change, the minimum required roles are listed below.

Following explicit approval, the initial deployment `tiger-portal-test-config-20261027` created `id-tiger-portal-test` and private `reports` / `portal-sessions` containers. The revised template uses the existing `id-tiger-test` instead (principal ID `ae858702-2fd5-45e2-8dc8-68e11f5613c7`, client ID `36c5d3a8-9e9f-4f38-9d7d-b0ee8430b7e7`). The initial switch updated the App Service binding, `AZURE_CLIENT_ID` and the then-used Key Vault reference identity together. The earlier dedicated identity is retained unless explicitly cleaned up. Client registration and employee qualification still need configuration before login acceptance.

Deployment `tiger-portal-test-identity-20261027` subsequently succeeded. Read-back confirmed the test app is bound only to `id-tiger-test`, with the matching client ID and Key Vault reference identity. The earlier identity resource still exists but is not attached to the app. Production identity `id-tiger-staging` and its grants were inspected read-only; no production configuration was applied.

```sh
az deployment group what-if --resource-group <TEST_RESOURCE_GROUP> \
  --template-file infra/portal.bicep \
  --parameters environment=test portalOrigin=https://<TEST_PORTAL_HOST> \
    legacyHosts=<OLD_TEST_HOST> identityServerIssuer=<TEST_ISSUER> \
    sharedPlanName=plan-tiger-portal-test sharedPlanResourceGroup=<PLAN_RESOURCE_GROUP> \
    oidcClientId=ssw-tiger-portal cosmosAccountName=cosmos-tiger-test \
    dashboardStorageAccountName=<TEST_DASHBOARD_ACCOUNT>
```

Review the target resources, then run the same command with `create` instead of `what-if`. Leave `bindCustomDomains=false` until DNS ownership validation is ready. Use `manageRoleAssignments=true` only when the deployment identity has role-assignment authority; otherwise grant the following manually:

| Identity | Scope | Role |
|---|---|---|
| Portal identity | Test `reports` container | Storage Blob Data Reader |
| Portal identity | Test `portal-sessions` container | Storage Blob Data Contributor |
| Portal identity | Test Cosmos `tiger/users` container | Cosmos DB Built-in Data Contributor (data plane) |
| Existing test processor/security-tool identity | Test `reports` container | Storage Blob Data Contributor |
| Migration operator | Test `$web` and `reports` containers | Storage Blob Data Contributor |

The migration now uses ordinary container properties; Blob Data Owner / Get Container ACL is not required. Allow storage RBAC changes to propagate before testing.

Check App Service application settings (list names/status only when inspecting in logs):

```text
PORTAL_ORIGIN                https://<TEST_PORTAL_HOST>
PORTAL_LEGACY_HOSTS          <OLD_TEST_HOST>
OIDC_ISSUER                  <TEST_ISSUER>
OIDC_CLIENT_ID               ssw-tiger-portal
OIDC_API_AUDIENCE            tiger
DASHBOARD_STORAGE_ACCOUNT   <TEST_DASHBOARD_ACCOUNT>
DASHBOARD_CONTAINER         reports
PORTAL_SESSION_CONTAINER    portal-sessions
COSMOS_ENDPOINT             https://cosmos-tiger-test.documents.azure.com:443/
COSMOS_DATABASE             tiger
PORTAL_USER_CONTAINER       users
AZURE_CLIENT_ID             <test Portal managed-identity client ID>
```

The Portal requires a signed boolean `email_verified=true` and an email whose domain is exactly `ssw.com.au`. Missing or string-valued confirmation is denied. Remove obsolete `PORTAL_EMPLOYEE_*` settings; they do not bypass this rule. A valid login upserts a user, but never restores disabled accounts. Use the README’s Cosmos procedure for manual account or mailbox disables. No user management UI is provided.

The public-client changes in this branch have not been applied to Azure. The previously provisioned test App may still contain the obsolete `OIDC_CLIENT_SECRET` reference and `keyVaultReferenceIdentity`; the new code does not use either. Remove the obsolete OIDC setting in the next separately authorized configuration release and align `PORTAL_ORIGIN` with the Azure hostname before login testing. Do not delete shared identities, Key Vault permissions or Graph/processor credentials as part of this cleanup.

## 4. Deploy the test Web app

Run `npm ci --prefix portal` and `npm test --prefix portal`. Configure GitHub's `portal-test` deployment environment variables:

- `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` for the **test deployment identity**.
- `PORTAL_APP_NAME=app-tiger-portal-test`.
- An Azure federated credential matching `repo:SSWConsulting/SSW.Tiger:environment:portal-test` and permission to deploy only the intended test app.

Use a separate protected `portal-production` GitHub environment for any future production app release, with separate deployment credentials and `PORTAL_APP_NAME=app-tiger-portal-staging`. Its federated credential must match `repo:SSWConsulting/SSW.Tiger:environment:portal-production`. If you previously configured the old environment named `portal`, migrate its test-only values/federation to `portal-test`; do not share a production deployment identity. Run the `Portal` workflow on the implementation branch with `target=test` and `deploy=true`. It verifies the app name matches the selected target before Azure login. It packages `portal/` as the app root. App Service uses Node 22 and installs dependencies. Do not deploy the whole repository as the Portal app root.

Provision Cosmos `tiger/users` with partition key `/id` and no TTL before deploying this revision. `infra/portal.bicep` references the existing environment account/database and creates only this container. Keep `manageRoleAssignments=false` when the existing environment identity already has adequate Cosmos data-plane access; otherwise have an authorized operator grant it or separately authorize enabling the template assignment. Do not create a new Cosmos account, copy production data, or use database keys. Ensure Cosmos network rules permit the App Service. If old Blob user records exist, migrate roles and disables before cutover; the application does not read or migrate them automatically. IdentityServer's test scope mapping must target this same backend. Verify `POST /api/User/Register` (empty body) and `GET /api/User/MyRoles` using valid signed user callback tokens that include `email` and boolean `email_verified=true`: no Portal cookie or redirect should be needed. Unverified or non-SSW emails, wrong issuer/audience/client, expired tokens and invalid signatures must be rejected. The current IdentityServer registration service does not include `email_verified`; that callback will receive 403 until its source is aligned. Portal login can provision eligible users independently. Confirm role-callback claims separately; do not assume ID-token success proves every token path. `GET /api/me` accepts normal scoped access tokens or a Portal cookie, but not scope-less callback tokens. Never bypass JWT validation to make these tests pass.

Before acceptance, disable a test user in Cosmos and verify their existing cookie cannot open project metadata, report GET/HEAD or `/api/me`; a new login must not restore them. Add a mailbox block and verify a second subject with the same verified email cannot enter. Restore only explicitly and check `lastLoginAt` changes on successful login but not browsing or role queries.

Initially the homepage can be empty; verify `/healthz`, company-account login, `/api/me`, logout, and rejection of an unapproved account. Check PKCE S256, state and nonce in the authentication flow without sharing tokens or secrets. Ensure no unexpected App Service Easy Auth layer intercepts the application-managed OIDC routes.

## 5. Copy test reports with a persistent manifest

```sh
export DASHBOARD_STORAGE_ACCOUNT=<TEST_DASHBOARD_ACCOUNT>
export DASHBOARD_CONTAINER=reports
node portal/scripts/migrate-reports.js
node portal/scripts/migrate-reports.js --apply --manifest portal/.migration-test.json
```

Keep this manifest until cleanup is complete, and run only one migration process at a time. It is bound to the account and destination container. Copy is resumable and never overwrites unverified differences. Metadata, HTML and encrypted password pages are preserved.

Verify all-project navigation, project meeting lists, direct report paths, `index.html` links, and a known password-protected report. No login should auto-unlock the report. Update the **test** security-tool environment to `DASHBOARD_CONTAINER=reports` before testing password rotation; it must update the private copy.

## 6. Switch only the test processing pipeline and hostnames

Pause new **test** processing, let active test jobs finish, and ensure all old-container writers are stopped during final reconciliation. Leave production jobs running unchanged.

1. Build the processor image from this branch with tag `test` using the existing manual container workflow. Do not push `latest`.
2. Review and deploy `infra/portal-test.bicepparam` against the test resource group. It sets `dashboardBaseUrl=portal-test.sswtiger.com` and `dashboardContainer=reports` on both the Function App and job. Review what-if for any unexpected non-test resources before applying.
3. Deploy the changed `azure-function/` code to **`func-tiger-test`**, including `jobEnv.js`; otherwise per-execution overrides can still send reports to `$web`.
4. Bind the new and old **test** custom hostnames to the test Portal App Service, validate ownership, and provision/bind HTTPS certificates. Point the new test hostname to App Service. Move the old test hostname to the same app or configure an equivalent edge redirect. Do not point either at public static hosting. Existing domain bindings may need to be released from their previous test service first.
5. Keep `PORTAL_ORIGIN`, IdentityServer callbacks, DNS/TLS and pipeline hostname consistent. If changing from the Azure hostname to the custom hostname, update both client registration and App Service configuration together.
6. Resume test processing only after the Portal and private storage path are ready. Generate one test report and check its Teams URL. A different private root/project index is now expected; the original migration manifest permits newer generated indexes during cleanup.

## 7. Remove verified public test copies only after acceptance

Run the cleanup against the **same test account and manifest**:

```sh
node portal/scripts/migrate-reports.js --apply --manifest portal/.migration-test.json --remove-public --confirm-portal-verified
```

This is a deliberate deletion of verified test public copies, not a required part of initial login testing. Preflight rejects missing records, changed public sources, and differing report/password bodies before deleting anything. Only root/project indexes may be newer in private storage. If password rotation has changed a private report since copying, cleanup deliberately stops: reconcile that report explicitly before retrying; do not overwrite the rotated private report with the stale public copy. Source ETag changes during deletion also stop the run. Keep final source writes paused; a full-container listing/deletion is not atomic.

If copy was done with the earlier manifest-free script, restore original equality or otherwise reconcile the files first and create a verified manifest; do not hand-author migration evidence.

Purge old test CDN caches and disable the test static website once it is no longer needed. Deleting objects or changing container ACL alone does not prove the old static/CDN entry points are inaccessible. Keep private reports and required retention backups intact.

## 8. Test acceptance

- Approved company account can browse all projects and meetings; unapproved account receives 403.
- Registration is idempotent, role queries return TIGER-owned roles, and claimed/body-supplied Admin values cannot escalate privileges.
- Private user records survive session expiry/logout; no administrator UI or meeting ACL is introduced.
- OIDC code + S256 flow requests offline_access and receives a refresh token. After access-token expiry, a cookie request refreshes it without another login. Invalid/revoked refresh authorization requires login; temporary failures return 503 without deleting the session. Logout deletes the local session and revokes the refresh token. No access/refresh token appears in HTML, JSON responses, cookies or logs.
- Session lifecycle cleanup retains renewable sessions for their 30-day maximum; no old one-day session cleanup rule remains. Existing pre-release sessions require one new sign-in.
- Normal report renders; protected report still asks for its original password.
- Test password-management tools read/write the private container and rotation works.
- Old test link returns 308 to the new host with the original path/query, then returns to that report after login.
- New test job writes to `reports`; its Teams message uses the Portal test hostname.
- Raw old static website and cached public paths no longer return report bodies after cleanup.
- Production resources, production IdentityServer registration and production URLs remain unchanged.


## Internal users and login identities

For this revision, use two confirmed login methods with the same verified SSW email and different IdentityServer subjects. Confirm one internal `user`, two `identity` mappings and one `emailIdentity` reservation in Cosmos. Both `/api/me` responses must have the same `id` and their own login `sub`. Both methods must return the same stored roles, preserve operator audit fields and continue working after token refresh. Disable the internal user and verify both existing sessions and a third new subject are rejected, including report GET/HEAD. Repeat with an email block. Unverified email and differing issuers must never link.

Check for duplicate legacy `user` records by normalized email before cutover. A unique existing user is adopted without changing its ID, roles or activation. Duplicate legacy records require manual reconciliation; the application returns `account_link_conflict` rather than choosing one. Restart all Portal instances on this revision together; do not run a subject-only version concurrently or roll back to one after mappings exist. No deployed-data changes have been performed as part of local implementation.
