---
name: deploy-dashboard
description: Deploy a meeting dashboard to Azure Blob Storage (configured dashboard hostname) and persist to Cosmos DB. Use when the user wants to deploy, publish, share, or host a dashboard online.
allowed-tools: Bash
---

# Deploy Dashboard to Azure Blob Storage

Deploy a locally-generated meeting dashboard to Azure Blob Storage (served via `DASHBOARD_BASE_URL`) and save meeting data to Cosmos DB.

## Instructions

1. Determine the `<project-name>` and `<meeting-id>` from the user's request or the current working context
2. Verify the dashboard exists at `projects/{project}/{meeting-id}/dashboard/index.html`
   - If it doesn't exist, generate it first using the generate-dashboard skill
3. Run the deploy command:
   ```bash
   node processor/deploy-local.js <project-name> <meeting-id>
   ```
4. Report the deployed URL back to the user

## What It Does

The script (`processor/deploy-local.js`) reuses the same `deployer.js` as the Azure pipeline:

1. Uploads dashboard files to Azure Blob Storage
2. Persists meeting metadata + consolidated analysis to Cosmos DB (if `COSMOS_ENDPOINT` is set)
3. Legacy `$web` only: regenerates the per-project index page (`{project}/index.html`) and rebuilds the static root index (`index.html`). With a private container (`DASHBOARD_CONTAINER=reports`) both steps are skipped, because the Portal lists published reports directly
4. Returns the configured report URL (requires Portal sign-in after cutover)

## Deployment URL Convention

URLs use `DASHBOARD_BASE_URL`. After authenticated Portal cutover, set **both** `DASHBOARD_BASE_URL` to the Portal hostname and `DASHBOARD_CONTAINER=reports`. Point the hostname at App Service, not public Storage hosting. Follow `portal/README.md` for validation, deployment and migration. Do not switch production while testing. Do not hardcode the hostname when reporting a deployment.

Current example: `https://dashboards.sswtiger.com/{project}/{meeting-id}`

Example: `https://dashboards.sswtiger.com/yakshaver/2026-01-22-094557`

The project index page lists every meeting: `https://dashboards.sswtiger.com/{project}/`

The authenticated Portal builds its project and meeting lists from the published report paths in the private container; it does not read index blobs. `npm run deploy:portal` only rebuilds the legacy `$web` root index (and does nothing for a private container); it does not deploy the App Service application.

## Prerequisites

- Azure CLI installed and logged in (`az login`)
- `DASHBOARD_STORAGE_ACCOUNT` environment variable set in `.env`
- `DASHBOARD_BASE_URL` set to the verified Portal hostname after cutover
- `DASHBOARD_CONTAINER=reports` after cutover, including in local password-management tools
- Existing `$web` defaults are only for legacy publishing before cutover

## Output

Report:
- Deployed to: {url}
- Provide the clickable link for easy access
