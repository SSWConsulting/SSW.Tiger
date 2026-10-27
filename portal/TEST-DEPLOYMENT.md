# Test-only Portal and IdentityServer integration

This runbook only targets TIGER **test** and the selected **IdentityServer test/staging** environment. It does not authorize production deployment. The resources whose names contain `staging` may serve TIGER production; do not use `infra/portal-staging.bicepparam`, `infra/staging.bicepparam`, the `latest` image, production DNS or the production IdentityServer issuer for this validation.

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
| Portal managed identity | `id-tiger-portal-test` |
| Dashboard storage | Expected `satigertestweb`; confirm the test account, never the staging account |
| Key Vault | Expected `kv-tiger-test`; confirm before writing any secret |
| New hostname | `portal-test.sswtiger.com`, or initially the app's `*.azurewebsites.net` hostname |
| Old hostname | Confirm the existing test dashboard hostname before changing routing |
| IdentityServer issuer | Obtain the test/staging issuer from its deployed environment; explicitly override the production default |
| IdentityServer client | `ssw-tiger-portal-test` |
| Employee subjects | Confirm test users' IdentityServer `sub` values **in that issuer's user store** |

Fetch `<TEST_ISSUER>/.well-known/openid-configuration` read-only. Confirm its returned `issuer`, endpoints and S256 support. A production issuer's `sub` or client registration may not exist in staging.

## 2. Register only the IdentityServer test client

In the IdentityServer repository, add the `Clients.TigerPortalClient` and `Applications.TigerPortalClient` entries shown in [README.md](README.md#identityserver-registration). Include them in **staging/test deployment substitutions**, including callback, post-logout URL and application URL. Do not change production workflow/environment substitutions or existing clients.

Required client settings:

```text
ClientId                   ssw-tiger-portal-test
AllowedGrantTypes           authorization_code
RequirePkce                true
AllowPlainTextPkce         false
RequireClientSecret        true
AllowedScopes              openid, profile, email
AlwaysIncludeUserClaimsInIdToken true
RedirectUris               https://<TEST_PORTAL_HOST>/auth/callback
PostLogoutRedirectUris     https://<TEST_PORTAL_HOST>/signed-out
```

Add matching `Applications` settings with the same ClientId and test AppUrl. Verify the actual enabled Microsoft scheme name for `AllowedIdps`. No new business API scope, downstream registration endpoint or IdentityServer authentication code change is needed. First test with an existing confirmed company identity; separately check new-user provisioning/email confirmation if needed.

Generate a dedicated test secret through your secret-management process. Store its **original exact text** in test Key Vault secret `tiger-portal-oidc-client-secret`. Store its **base64 SHA-256 hash** in this authorization-code client's `ClientSecrets`. Current `HashClientSecrets()` only automatically hashes clients using `client_credentials`; do not hash this value twice. Use secure environment substitution for the hash, and do not commit or print the original secret.

If needed, derive the hash from a protected local UTF-8 secret file with no trailing newline:

```sh
node --input-type=module -e 'import{readFileSync}from"node:fs";import{createHash}from"node:crypto";console.log(createHash("sha256").update(readFileSync(process.argv[1])).digest("base64"))' <SECRET_FILE>
az keyvault secret set --vault-name <TEST_VAULT> --name tiger-portal-oidc-client-secret --file <SECRET_FILE> --query id -o tsv
```

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

```sh
az deployment group what-if --resource-group <TEST_RESOURCE_GROUP> \
  --template-file infra/portal.bicep \
  --parameters environment=test portalOrigin=https://<TEST_PORTAL_HOST> \
    legacyHosts=<OLD_TEST_HOST> identityServerIssuer=<TEST_ISSUER> \
    sharedPlanName=plan-tiger-portal-test sharedPlanResourceGroup=<PLAN_RESOURCE_GROUP> \
    oidcClientId=ssw-tiger-portal-test employeeSubjects=<CONFIRMED_TEST_SUBJECTS> \
    dashboardStorageAccountName=<TEST_DASHBOARD_ACCOUNT> keyVaultName=<TEST_VAULT>
```

Review the target resources, then run the same command with `create` instead of `what-if`. Leave `bindCustomDomains=false` until DNS ownership validation is ready. Use `manageRoleAssignments=true` only when the deployment identity has role-assignment authority; otherwise grant the following manually:

| Identity | Scope | Role |
|---|---|---|
| Portal identity | Test `reports` container | Storage Blob Data Reader |
| Portal identity | Test `portal-sessions` container | Storage Blob Data Contributor |
| Portal identity | Test Key Vault | Key Vault Secrets User |
| Existing test processor/security-tool identity | Test `reports` container | Storage Blob Data Contributor |
| Migration operator | Test `$web` and `reports` containers | Storage Blob Data Contributor |

The migration now uses ordinary container properties; Blob Data Owner / Get Container ACL is not required. Allow RBAC and Key Vault reference resolution to propagate before testing.

Check App Service application settings (list names/status only when inspecting in logs):

```text
PORTAL_ORIGIN                https://<TEST_PORTAL_HOST>
PORTAL_LEGACY_HOSTS          <OLD_TEST_HOST>
OIDC_ISSUER                  <TEST_ISSUER>
OIDC_CLIENT_ID               ssw-tiger-portal-test
OIDC_CLIENT_SECRET           Key Vault reference to the original test secret
PORTAL_EMPLOYEE_SUBJECTS     <approved test IdentityServer subjects>
DASHBOARD_STORAGE_ACCOUNT   <TEST_DASHBOARD_ACCOUNT>
DASHBOARD_CONTAINER         reports
PORTAL_SESSION_CONTAINER    portal-sessions
AZURE_CLIENT_ID             <test Portal managed-identity client ID>
```

Without a trusted employee claim or a subject allowlist, startup intentionally fails. Do not use an email-domain bypass. The allowlist only controls internal Portal access, not meeting-level permissions. Add other confirmed SSW staff as required for test.

## 4. Deploy the test Web app

Run `npm ci --prefix portal` and `npm test --prefix portal`. Configure GitHub's `portal-test` deployment environment variables:

- `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` for the **test deployment identity**.
- `PORTAL_APP_NAME=app-tiger-portal-test`.
- An Azure federated credential matching `repo:SSWConsulting/SSW.Tiger:environment:portal-test` and permission to deploy only the intended test app.

Use a separate protected `portal-production` GitHub environment for any future production app release, with separate deployment credentials and `PORTAL_APP_NAME=app-tiger-portal-staging`. Its federated credential must match `repo:SSWConsulting/SSW.Tiger:environment:portal-production`. If you previously configured the old environment named `portal`, migrate its test-only values/federation to `portal-test`; do not share a production deployment identity. Run the `Portal` workflow on the implementation branch with `target=test` and `deploy=true`. It verifies the app name matches the selected target before Azure login. It packages `portal/` as the app root. App Service uses Node 22 and installs dependencies. Do not deploy the whole repository as the Portal app root.

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
- OIDC code + S256 flow completes; logout revokes the Portal session.
- Normal report renders; protected report still asks for its original password.
- Test password-management tools read/write the private container and rotation works.
- Old test link returns 308 to the new host with the original path/query, then returns to that report after login.
- New test job writes to `reports`; its Teams message uses the Portal test hostname.
- Raw old static website and cached public paths no longer return report bodies after cleanup.
- Production resources, production IdentityServer registration and production URLs remain unchanged.
