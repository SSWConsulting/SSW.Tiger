---
name: deploy-dashboard
description: Deploy a meeting dashboard to Azure Blob Storage (dashboards.sswtiger.com) for public sharing. Use when the user wants to deploy, publish, share, or host a dashboard online.
allowed-tools: Bash
---

# Deploy Dashboard to Azure Blob Storage

Deploy a meeting dashboard to Azure Blob Storage, served via dashboards.sswtiger.com.

## Instructions

1. Verify the dashboard exists at `projects/{project}/{meeting-id}/dashboard/index.html`
   - If it doesn't exist, generate it first using the generate-dashboard skill
2. Login with Managed Identity (in Azure) or Azure CLI (locally):
   ```bash
   # Azure Container App (uses managed identity)
   az login --identity --username $AZURE_CLIENT_ID

   # Local development (use interactive login)
   az login
   ```
3. Upload the dashboard directory to blob storage:
   ```bash
   az storage blob upload-batch \
     --source projects/{project}/{meeting-id}/dashboard \
     --destination '$web/{project}/{meeting-id}' \
     --account-name $DASHBOARD_STORAGE_ACCOUNT \
     --auth-mode login \
     --overwrite
   ```
4. Report the deployed URL back to the user

## Deployment URL Convention

URLs follow the pattern: `https://dashboards.sswtiger.com/{project}/{meeting-id}`

Example: `https://dashboards.sswtiger.com/yakshaver/2026-01-22-094557`

## Prerequisites

- Azure CLI must be installed
- `DASHBOARD_STORAGE_ACCOUNT` environment variable must be set
- User must have Storage Blob Data Contributor role (or Managed Identity in Azure)

## Output

Report:
- Deployed to: {url}
- Provide the clickable link for easy access
