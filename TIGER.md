# 🐯 TIGER Pipeline - Automated Deployment Guide

**T**ranscript **I**ntelligence and **G**roup **E**vent **R**easoning

This guide walks through deploying the fully automated TIGER pipeline on Azure.

---

## Architecture Overview

```
Microsoft Teams Meeting Ends
         ↓
   Graph Webhook
         ↓
   Azure Function (Trigger)
         ↓
   Azure Container App (Processing)
         ↓
   ┌─────────────────────────────────┐
   │ 1. Fetch Transcript (Graph API) │
   │ 2. Run 5 Analysis Agents        │
   │ 3. Consolidate Results           │
   │ 4. Generate HTML Dashboard       │
   │ 5. Deploy to Azure Blob/Surge    │
   └─────────────────────────────────┘
         ↓
   Deployed Dashboard URL
         ↓
   Post Link to Teams Chat (Graph API)
```

---

## Phase 1: Containerize Your Agent ✅

### Current Status
- ✅ Docker container built
- ✅ Processes transcript files
- ✅ Generates HTML dashboards
- ✅ Clear exit codes (0/1)
- ✅ JSON logging to stdout
- ✅ Optional deployment to surge.sh or Azure Blob

### Container Output

The container now returns both:
1. **Local dashboard path** (for backup/archival)
2. **Deployed URL** (for sharing)

```json
{
  "timestamp": "2026-01-21T10:30:00.000Z",
  "level": "INFO",
  "message": "SUCCESS: Meeting processing completed",
  "dashboardPath": "/app/projects/yakshaver/dashboards/2026-01-21/index.html",
  "deployedUrl": "https://yakshaver-2026-01-21.surge.sh",
  "exitCode": 0
}
```

### Deployment Options

Set `DEPLOY_METHOD` environment variable:

**Option 1: No Deployment (Development)**
```bash
DEPLOY_METHOD=none
```

**Option 2: Surge.sh (Simple, Fast)**
```bash
DEPLOY_METHOD=surge
SURGE_EMAIL=your-email@example.com
SURGE_TOKEN=your-surge-token
```

**Option 3: Azure Blob Storage (Production)**
```bash
DEPLOY_METHOD=azure-blob
AZURE_STORAGE_CONNECTION_STRING=your-connection-string
```

---

## Phase 2: Azure Identity & Permissions

### Step 1: Create App Registration

```bash
# Using Azure CLI
az ad app create \
  --display-name "TIGER-MeetingSummariser" \
  --sign-in-audience AzureADMyOrg
```

### Step 2: Grant Graph API Permissions

Required permissions:
- `OnlineMeetings.Read.All` - Detect when meetings end
- `Transcript.Read.All` - Download transcript content
- `Chat.Create` - Post dashboard link to Teams

```bash
# Add permissions
az ad app permission add \
  --id <APP_ID> \
  --api 00000003-0000-0000-c000-000000000000 \
  --api-permissions \
    883ea226-0bf2-4a8f-9f9d-92c9162a727d=Role \  # OnlineMeetings.Read.All
    a4890a77-f890-4492-bffe-a45cb0c49e44=Role \  # Transcript.Read.All
    9ff7295e-131b-4d94-90e1-69fde507ac11=Role    # Chat.Create

# Grant admin consent
az ad app permission admin-consent --id <APP_ID>
```

### Step 3: Create Service Principal

```bash
az ad sp create --id <APP_ID>

# Generate a secret
az ad app credential reset --id <APP_ID>
# Save the returned password/secret!
```

---

## Phase 3: Build the Trigger (Azure Function)

### Create Azure Function App

```bash
# Create resource group
az group create --name rg-tiger --location australiaeast

# Create storage account
az storage account create \
  --name sttiger \
  --resource-group rg-tiger \
  --location australiaeast \
  --sku Standard_LRS

# Create function app
az functionapp create \
  --resource-group rg-tiger \
  --consumption-plan-type EP1 \
  --runtime node \
  --runtime-version 18 \
  --functions-version 4 \
  --name func-tiger-trigger \
  --storage-account sttiger
```

### Function Code Structure

```javascript
// HttpTrigger or EventGridTrigger
module.exports = async function (context, req) {
  const { meetingId, organizerId, teamId } = req.body;
  
  // Filter: Only process specific teams
  const allowedTeams = process.env.ALLOWED_TEAMS.split(',');
  if (!allowedTeams.includes(teamId)) {
    context.log('Skipping meeting from non-allowed team');
    return;
  }
  
  // Trigger Container App job
  await triggerContainerJob(meetingId, organizerId);
  
  context.res = { status: 200, body: 'Processing started' };
};
```

### Configure Graph Webhook

```bash
# Subscribe to meeting events
POST https://graph.microsoft.com/v1.0/subscriptions
{
  "changeType": "created",
  "notificationUrl": "https://func-tiger-trigger.azurewebsites.net/api/webhook",
  "resource": "communications/onlineMeetings",
  "expirationDateTime": "2026-02-01T00:00:00Z",
  "clientState": "secretClientValue"
}
```

---

## Phase 4: Deploy Infrastructure

### Step 1: Build and Push Container Image

```bash
# Build image
docker build -t tiger-processor:latest .

# Tag for Azure Container Registry
docker tag tiger-processor:latest <your-acr>.azurecr.io/tiger-processor:latest

# Push to ACR
az acr login --name <your-acr>
docker push <your-acr>.azurecr.io/tiger-processor:latest
```

### Step 2: Create Azure Container Apps Environment

```bash
# Create environment
az containerapp env create \
  --name env-tiger \
  --resource-group rg-tiger \
  --location australiaeast

# Create the container app (as a job)
az containerapp job create \
  --name job-tiger-processor \
  --resource-group rg-tiger \
  --environment env-tiger \
  --image <your-acr>.azurecr.io/tiger-processor:latest \
  --registry-server <your-acr>.azurecr.io \
  --registry-username <username> \
  --registry-password <password> \
  --trigger-type Manual \
  --replica-timeout 1800 \
  --cpu 2.0 \
  --memory 4Gi \
  --env-vars \
    "CLAUDE_SUBSCRIPTION=true" \
    "CLAUDE_SUBSCRIPTION_TOKEN=secretref:claude-token" \
    "DEPLOY_METHOD=azure-blob" \
    "AZURE_STORAGE_CONNECTION_STRING=secretref:storage-conn"
```

### Step 3: Configure Secrets

```bash
# Add secrets
az containerapp job secret set \
  --name job-tiger-processor \
  --resource-group rg-tiger \
  --secrets \
    claude-token=<your-claude-token> \
    storage-conn=<your-storage-connection-string>
```

---

## Phase 5: Automate Input/Output

### Modify Container to Fetch Transcript

Update `processor.js` to accept `meetingId` instead of file path:

```javascript
// New usage
node processor.js --meeting-id <meetingId> --project-name <projectName>

// Internally fetches transcript via Graph API
const transcript = await fetchTranscriptFromGraph(meetingId);
```

### Add Graph API Integration

```javascript
async function fetchTranscriptFromGraph(meetingId) {
  const token = await getAccessToken();
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/me/onlineMeetings/${meetingId}/transcripts`,
    { headers: { Authorization: `Bearer ${token}` }}
  );
  return await response.text();
}
```

### Post Dashboard Link to Teams

```javascript
async function postToTeamsChat(chatId, dashboardUrl) {
  const token = await getAccessToken();
  await fetch(
    `https://graph.microsoft.com/v1.0/chats/${chatId}/messages`,
    {
      method: 'POST',
      headers: { 
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        body: {
          content: `📊 Meeting Dashboard Ready: ${dashboardUrl}`
        }
      })
    }
  );
}
```

---

## Complete Flow Example

### 1. Meeting Ends in Teams
A Sprint Review meeting finishes.

### 2. Graph Webhook Fires
```json
{
  "value": [{
    "subscriptionId": "abc123",
    "changeType": "created",
    "resource": "communications/onlineMeetings('meeting-id-123')"
  }]
}
```

### 3. Azure Function Triggers
Validates team membership, starts Container App job.

### 4. Container App Processes
```bash
node processor.js \
  --meeting-id meeting-id-123 \
  --project-name yakshaver-sprint-review
```

Logs:
```json
{"level":"INFO","message":"Fetching transcript from Graph API"}
{"level":"INFO","message":"Running agent: timeline-analyzer"}
{"level":"INFO","message":"Running agent: people-analyzer"}
{"level":"INFO","message":"Consolidation complete"}
{"level":"INFO","message":"Dashboard deployed","deployedUrl":"https://..."}
{"level":"INFO","message":"SUCCESS","exitCode":0}
```

### 5. Dashboard Link Posted to Teams
```
📊 Meeting Dashboard Ready: https://yakshaver-sprint-review-2026-01-21.surge.sh
```

---

## Cost Considerations

### Claude API Costs
- ~100K tokens per meeting analysis
- Cost per meeting: ~$0.30-$0.50

### Azure Costs
- **Azure Function**: Consumption plan (~free for low volume)
- **Container Apps**: ~$0.02 per execution (20 min @ 2 CPU)
- **Blob Storage**: ~$0.02/GB/month

**Total per meeting**: ~$0.35-$0.55

### Optimization
- Filter to specific teams only
- Cache common analysis patterns
- Use reserved instances for high volume

---

## Monitoring & Debugging

### View Container Logs
```bash
az containerapp job logs show \
  --name job-tiger-processor \
  --resource-group rg-tiger
```

### Check Function Logs
```bash
az functionapp log tail \
  --name func-tiger-trigger \
  --resource-group rg-tiger
```

### Test Manually
```bash
# Trigger job manually
az containerapp job start \
  --name job-tiger-processor \
  --resource-group rg-tiger
```

---

## Security Best Practices

1. ✅ **Secrets Management**: Use Azure Key Vault for all credentials
2. ✅ **Managed Identity**: Use managed identities instead of connection strings
3. ✅ **Network Isolation**: Deploy Container Apps in VNet
4. ✅ **RBAC**: Principle of least privilege for all service principals
5. ✅ **Audit Logs**: Enable Azure Monitor for all resources

---

## Next Steps

- [ ] Implement Graph API integration in processor.js
- [ ] Create Azure Function webhook handler
- [ ] Deploy Container App to Azure
- [ ] Test end-to-end with test meetings
- [ ] Set up monitoring and alerts
- [ ] Document for team onboarding
