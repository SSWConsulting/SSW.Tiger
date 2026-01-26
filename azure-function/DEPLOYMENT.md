# Azure Function Deployment Guide

## Prerequisites

Before deploying, ensure you have:

- [ ] Correct Azure subscription access
- [ ] App Registration with Client Secret
- [ ] Admin consent for Graph API permissions
- [ ] Azure CLI installed and logged in

## Step 1: Verify App Registration

### Required Graph API Permissions (Application)

| Permission | Type | Status |
|------------|------|--------|
| `OnlineMeetings.Read.All` | Application | Needs Admin Consent |
| `OnlineMeetingTranscript.Read.All` | Application | Needs Admin Consent |

### Create Client Secret

1. Azure Portal → App registrations → Project T.I.G.E.R.
2. Certificates & secrets → New client secret
3. Copy the **Value** (not the Secret ID)
4. Save it securely - you'll need it for Key Vault

## Step 2: Deploy Infrastructure (Bicep)

```bash
# Login to Azure
az login

# Set correct subscription
az account set --subscription "SSW.Primary"

# Preview deployment
az deployment sub what-if \
  --location australiaeast \
  --template-file infra/main.bicep \
  --parameters environment=dev

# Deploy
az deployment sub create \
  --location australiaeast \
  --template-file infra/main.bicep \
  --parameters environment=dev
```

## Step 3: Populate Key Vault Secrets

```bash
KV_NAME="kv-tiger-dev"

# Graph API credentials
az keyvault secret set --vault-name $KV_NAME \
  --name "graph-client-id" \
  --value "YOUR_CLIENT_ID"

az keyvault secret set --vault-name $KV_NAME \
  --name "graph-client-secret" \
  --value "YOUR_CLIENT_SECRET"

az keyvault secret set --vault-name $KV_NAME \
  --name "graph-tenant-id" \
  --value "YOUR_TENANT_ID"

# Webhook validation secret
az keyvault secret set --vault-name $KV_NAME \
  --name "webhook-client-state" \
  --value "$(openssl rand -hex 32)"

# GitHub Container Registry token (for pulling images)
az keyvault secret set --vault-name $KV_NAME \
  --name "ghcr-token" \
  --value "YOUR_GITHUB_PAT"

# Container App Job image (used when triggering the job)
az keyvault secret set --vault-name $KV_NAME \
  --name "container-job-image" \
  --value "ghcr.io/your-org/tiger-processor:latest"
```

## Step 4: Deploy Function Code

```bash
cd azure-function

# Deploy to Azure
func azure functionapp publish func-tiger-dev
```

## Step 5: Create Graph Subscription

```bash
# Get Function URL
FUNCTION_URL="https://func-tiger-dev.azurewebsites.net/api/TranscriptWebhook"

# Get webhook client state from Key Vault
CLIENT_STATE=$(az keyvault secret show --vault-name $KV_NAME --name webhook-client-state --query value -o tsv)

# Create subscription (expires in ~3 days max for transcripts)
az rest --method POST \
  --uri "https://graph.microsoft.com/v1.0/subscriptions" \
  --headers "Content-Type=application/json" \
  --body "{
    \"changeType\": \"created\",
    \"notificationUrl\": \"$FUNCTION_URL\",
    \"resource\": \"communications/onlineMeetings/getAllTranscripts\",
    \"expirationDateTime\": \"$(date -d '+3 days' -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"clientState\": \"$CLIENT_STATE\"
  }"
```

## Step 6: Test End-to-End

1. **Create a Teams meeting** with transcription enabled
2. **Start the meeting**, enable transcription
3. **Speak for a few minutes**
4. **End the meeting**
5. **Wait 2-5 minutes** for transcript to be processed
6. **Check Function logs:**
   ```bash
   az functionapp log tail --name func-tiger-dev --resource-group rg-tiger-dev
   ```

## Troubleshooting

### Error: 403 Forbidden from Graph API

**Cause:** Missing admin consent for permissions

**Fix:**
1. Azure Portal → App registrations → Project T.I.G.E.R.
2. API permissions → Grant admin consent for SSW

### Error: 401 Unauthorized from Graph API

**Cause:** Invalid or expired client secret

**Fix:**
1. Create new client secret in App Registration
2. Update Key Vault:
   ```bash
   az keyvault secret set --vault-name $KV_NAME \
     --name "graph-client-secret" \
     --value "NEW_SECRET"
   ```
3. Restart Function App:
   ```bash
   az functionapp restart --name func-tiger-dev --resource-group rg-tiger-dev
   ```

### Error: Webhook validation failed

**Cause:** Function not returning validationToken correctly

**Fix:**
1. Check function logs for errors
2. Test locally with:
   ```bash
   curl -X POST "http://localhost:7071/api/TranscriptWebhook?validationToken=test123"
   ```

### Error: Container App Job not starting

**Cause:** ghcr.io authentication failed

**Fix:**
1. Verify GitHub PAT has `packages:read` scope
2. Update Key Vault secret
3. Check Container Apps logs:
   ```bash
   az containerapp job logs show \
     --name job-tiger-dev \
     --resource-group rg-tiger-dev
   ```

### Error: Meeting not found (404)

**Cause:** Using wrong user ID or meeting ID format

**Fix:**
- The notification provides `meetingOrganizerId` - use this as the userId
- Endpoint format: `/users/{organizerId}/onlineMeetings/{meetingId}`

## Monitoring

### View Function Logs

```bash
# Real-time logs
az functionapp log tail --name func-tiger-dev --resource-group rg-tiger-dev

# Application Insights (if enabled)
# Azure Portal → Function App → Monitor → Logs
```

### View Container Job Execution

```bash
# List recent executions
az containerapp job execution list \
  --name job-tiger-dev \
  --resource-group rg-tiger-dev

# View specific execution logs
az containerapp job execution logs show \
  --name job-tiger-dev \
  --resource-group rg-tiger-dev \
  --execution-name <execution-name>
```

## Subscription Renewal

Graph subscriptions expire (max ~4230 minutes for transcripts). Set up auto-renewal:

```bash
# List current subscriptions
az rest --method GET --uri "https://graph.microsoft.com/v1.0/subscriptions"

# Renew a subscription
az rest --method PATCH \
  --uri "https://graph.microsoft.com/v1.0/subscriptions/{subscription-id}" \
  --body "{\"expirationDateTime\": \"$(date -d '+3 days' -u +%Y-%m-%dT%H:%M:%SZ)\"}"
```

Consider using Azure Logic Apps or a Timer-triggered Function for automatic renewal.
