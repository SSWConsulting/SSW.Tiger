---
name: deploy-dashboard
description: Deploy a meeting dashboard to Azure Blob Storage (dashboards.sswtiger.com) and persist to Cosmos DB. Use when the user wants to deploy, publish, share, or host a dashboard online.
allowed-tools: Bash
---

# Deploy Dashboard to Azure Blob Storage

Deploy a locally-generated meeting dashboard to Azure Blob Storage (served via dashboards.sswtiger.com) and save meeting data to Cosmos DB.

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
3. Returns the public URL

## Deployment URL Convention

URLs follow the pattern: `https://dashboards.sswtiger.com/{project}/{meeting-id}`

Example: `https://dashboards.sswtiger.com/yakshaver/2026-01-22-094557`

## Prerequisites

- Azure CLI installed and logged in (`az login`)
- `DASHBOARD_STORAGE_ACCOUNT` environment variable set in `.env`
- `DASHBOARD_BASE_URL` environment variable set in `.env` (optional, falls back to Azure hostname)

## Output

Report:
- Deployed to: {url}
- Provide the clickable link for easy access
