# TIGER Portal

An authenticated portal for SSW staff to browse projects, meeting lists and HTML meeting reports. Reports are listed from private Blob storage and enriched with Cosmos metadata when available. Reports without Cosmos records remain visible. Password-protected reports retain their existing password requirement.

## Architecture

The Portal is a standalone Next.js / React application with a custom Node server. It runs independently of the transcript-processing pipeline and Graph webhook authentication.

- `src/server.js` and `src/nextRenderer.js`: application startup and Next.js integration.
- `src/app.js`: request routing and authorization before rendering pages or streaming reports.
- `src/components.js` and `pages/`: shared React components, pages and styles.
- `src/auth.js`, `src/users.js` and `src/storage.js`: OIDC, user access and data services.

The home page lists projects. `/{project}/` and `/{project}/index.html` render the project's meeting list directly from published report paths; static project indexes are not required. Individual report HTML is streamed unchanged from private storage after authorization, with a CSP sandbox that isolates scripts from the Portal origin. Password unlock scripts and charts can run, but cannot read Portal pages or session data. New reports pin CDN versions and use SRI for Alpine and Chart.js. The Tailwind v3 CDN lacks CORS support, so its pinned script relies on sandbox isolation rather than SRI. Historical report scripts are isolated by the same response policy.

Only `/_next/static/` build assets are public after host validation. Page props contain authorized user/profile summaries and project data; tokens and storage clients stay on the server.

## Authentication and access

Sign-in uses IdentityServer Authorization Code with PKCE S256. The Portal is a public OIDC client and requires no client secret. It requests `openid profile email offline_access ssw-tiger-api`; the API audience is `tiger`.

Admission requires a signed `email_verified=true` claim and an exact `ssw.com.au` email domain. Within the same issuer, login identities with the same verified email map to one internal TIGER user. TIGER owns roles and activation status; token role claims do not grant permissions. Every protected request checks the current Cosmos account and mailbox block status. All active eligible staff see the same reports; there is no per-meeting ACL or administrator UI.

Users and identity mappings are stored in Cosmos `tiger/users`, partitioned by `/id`. Access and refresh tokens remain in private server-side session storage. The browser receives a Secure, HttpOnly cookie. Sessions have a fixed 30-day maximum; refresh does not extend it. Logout removes the local session and attempts refresh-token revocation.

IdentityServer integration endpoints:

| Endpoint | Purpose |
|---|---|
| `POST /api/User/Register` | Provision an eligible user from a validated Bearer token |
| `GET /api/User/MyRoles` | Return TIGER-owned roles for the signed user |
| `GET /api/me` | Return the current authorized user via session or scoped Bearer token |

Registration and role callbacks also accept IdentityServer's scope-less internal tokens with a maximum issued lifetime of 300 seconds. Other Bearer requests require the `ssw-tiger-api` scope. Issuer, signature, audience, expiry and client identity are validated.

## Configuration

Use `.env.example` as the configuration reference. Keep local `.env` files untracked.

| Setting | Purpose |
|---|---|
| `PORTAL_ORIGIN` | Canonical HTTPS origin, matching the IdentityServer callback registration |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_API_AUDIENCE` | IdentityServer issuer, public client and API audience |
| `DASHBOARD_STORAGE_ACCOUNT`, `DASHBOARD_CONTAINER` | Report storage account and private report container (`reports`) |
| `PORTAL_SESSION_CONTAINER` | Private session container (`portal-sessions`) |
| `COSMOS_ENDPOINT`, `COSMOS_DATABASE`, `PORTAL_USER_CONTAINER` | Cosmos account, database and users container |
| `PORTAL_LEGACY_HOSTS` | Legacy hosts redirected to the canonical origin, preserving path and query |
| `PORT` | HTTP listener port |

Azure data access uses managed identity in hosting and `DefaultAzureCredential` for local development. Infrastructure creates a dedicated `id-tiger-portal-{environment}` identity, separate from the processor. It receives container-scoped read access to reports and meeting metadata, and write access to sessions and users. Enable `manageRoleAssignments` when provisioning these grants, or have an administrator apply them before deploying. Existing apps must detach the processor identity; release preflight rejects extra identities. No processor Key Vault access is granted.

Changing the Portal origin does not migrate historical reports or remove public copies. The processor's `DASHBOARD_BASE_URL` and `DASHBOARD_CONTAINER` determine where new reports are linked and stored. The pipeline does not publish a root project listing in either container; the authenticated Portal generates it on request. Existing `$web` reports require a separate migration; `scripts/migrate-reports.js` provides copy/verification and manifest-based cleanup. Deployment, migration and acceptance records are maintained outside this repository.

## Local development

Requires Node.js 22 or later and access to the configured IdentityServer, Blob storage and Cosmos resources.

```sh
npm ci --prefix portal
node --env-file=portal/.env portal/src/server.js --dev
```

Use an HTTPS development reverse proxy whose origin matches `PORTAL_ORIGIN`, with its callback registered in IdentityServer. Cookies are Secure in every environment.

For a production build:

```sh
npm run build --prefix portal
npm start --prefix portal
```

## Validation

Run from the repository root:

```sh
npm test --prefix portal
npm run test:next --prefix portal
node --test scripts/portal-*.test.mjs
```

The suites cover OIDC/token validation, account linking, access checks, sessions, report passthrough, redirects and real Next.js rendering with synthetic data. They do not establish acceptance against live IdentityServer or Azure services.

Release utilities are in `../scripts/portal-release.mjs` (source packaging and configuration checks) and `../scripts/portal-smoke.mjs` (deployed revision and authentication smoke checks). Infrastructure templates are in `../infra/portal*.bicep`.
