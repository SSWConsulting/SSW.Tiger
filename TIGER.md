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
   │ 3. Consolidate Results          │
   │ 4. Generate HTML Dashboard      │
   │ 5. Deploy to urge               │
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

### Container Output

The container now returns:
1. **Canonical dashboard path** (in self-contained meeting folder) - permanent
2. **Output copy path** (optional convenience copy) - for quick access
3. **Deployed URL** (for sharing)

```json
{
  "timestamp": "2026-01-21T10:30:00.000Z",
  "level": "INFO",
  "message": "SUCCESS: Meeting processing completed",
  "meetingId": "2026-01-21-sprint-review",
  "meetingDate": "2026-01-21",
  "dashboardPath": "/app/projects/yakshaver/2026-01-21-sprint-review/dashboard/index.html",
  "outputCopyPath": "/app/output/yakshaver-2026-01-21-sprint-review.html",
  "deployedUrl": "https://yakshaver-2026-01-21-sprint-review.surge.sh",
  "exitCode": 0
}
```

**Key Points:**
- `dashboardPath` is the canonical location (permanent, self-contained)
- `outputCopyPath` is optional (convenience for deployment/archival)
- Meeting folder contains the complete record (transcript + analysis + dashboard)

### Transcript Naming Convention

**CRITICAL**: Transcript files MUST be named with a date prefix:
- Format: `YYYY-MM-DD.vtt` or `YYYY-MM-DD-<identifier>.vtt`
- Valid examples:
  - `2026-01-21.vtt` (single meeting that day)
  - `2026-01-21-sprint-review.vtt` (multiple meetings same day)
  - `2026-01-21-standup.vtt`
- Invalid: `meeting.vtt`, `sprint-review.vtt`, `jan-21.vtt`

The filename (without `.vtt`) becomes the unique meeting ID used for:
- Isolating analysis and dashboards
- Preventing AI confusion between meetings
- Generating output filenames
- Creating deployment URLs

---

## Phase 2: Azure Identity & Permissions

### Step 1: Create App Registration


### Step 2: Grant Graph API Permissions

Required permissions:
- `OnlineMeetings.Read.All` - Detect when meetings end
- `Transcript.Read.All` - Download transcript content
- `Chat.Create` - Post dashboard link to Teams

### Step 3: Create Service Principal

---

## Phase 3: Build the Trigger (Azure Function)

### Create Azure Function App

### Function Code Structure

### Configure Graph Webhook

---

## Phase 4: Deploy Infrastructure

### Step 1: Build and Push Container Image


### Step 2: Create Azure Container Apps Environment

### Step 3: Configure Secrets with Azure Key Vault

**Create Key Vault and Secrets**:
```bash
# Create Key Vault
az keyvault create \
  --name kv-tiger \
  --resource-group rg-tiger \
  --location australiaeast

# Store Claude API Key
# Get your API key from https://console.anthropic.com/settings/keys
# If you have a subscription, this API key will inherit subscription benefits
az keyvault secret set \
  --vault-name kv-tiger \
  --name anthropic-api-key \
  --value sk-ant-api03-YOUR-KEY-HERE

# Store deployment credentials
az keyvault secret set \
  --vault-name kv-tiger \
  --name surge-email \
  --value <your-email@example.com>

az keyvault secret set \
  --vault-name kv-tiger \
  --name surge-token \
  --value <your-surge-token>

az keyvault secret set \
  --vault-name kv-tiger \
  --name storage-connection-string \
  --value <your-storage-connection-string>
```

**Enable Managed Identity**:
```bash
# Assign system-managed identity to container app
az containerapp job identity assign \
  --name job-tiger-processor \
  --resource-group rg-tiger \
  --system-assigned

# Get the managed identity principal ID
PRINCIPAL_ID=$(az containerapp job show \
  --name job-tiger-processor \
  --resource-group rg-tiger \
  --query identity.principalId -o tsv)

# Grant Key Vault access
az keyvault set-policy \
  --name kv-tiger \
  --object-id $PRINCIPAL_ID \
  --secret-permissions get list
```

**Configure Secrets in Container App**:
```bash
# Reference Key Vault secrets
az containerapp job secret set \
  --name job-tiger-processor \
  --resource-group rg-tiger \
  --secrets \
    "anthropic-api-key=keyvaultref:https://kv-tiger.vault.azure.net/secrets/anthropic-api-key" \
    "surge-email=keyvaultref:https://kv-tiger.vault.azure.net/secrets/surge-email" \
    "surge-token=keyvaultref:https://kv-tiger.vault.azure.net/secrets/surge-token" \
    "storage-conn=keyvaultref:https://kv-tiger.vault.azure.net/secrets/storage-connection-string"
```

---

## Phase 4.5: Authentication Configuration

### Choosing Authentication Method

**⚠️ IMPORTANT: OAuth Tokens Do Not Work in Docker**

Claude Code OAuth tokens (`sk-ant-oat01-...`) **cannot** be used in Docker containers, even with subscriptions. For Docker/Azure deployments, you MUST use API keys.

#### For Subscription Users (Claude Pro / Claude Code Subscription)

If you have a Claude subscription, your API keys will automatically inherit subscription benefits:

1. **Log into [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)** with your subscription account
2. **Create an API key** (starts with `sk-ant-api03-...`)
3. **Use this API key in Docker** - it will have your subscription benefits:
   - ✅ Higher rate limits
   - ✅ Priority access during high load
   - ✅ Access to latest models
   - ✅ Better pricing tiers

#### For Pay-as-You-Go Users

Create an API key from [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) and use standard rates.

### Setup Authentication in Azure

**Single API Key Setup (Recommended)**:

```bash
# Store your API key in Key Vault
az keyvault secret set \
  --vault-name kv-tiger \
  --name anthropic-api-key \
  --value sk-ant-api03-YOUR-KEY-HERE

# Configure Container App to use it
az containerapp job update \
  --name job-tiger-processor \
  --resource-group rg-tiger \
  --set-env-vars "ANTHROPIC_API_KEY=secretref:anthropic-api-key"
```

**Alternative Names (for compatibility)**:

The container accepts any of these environment variable names:
- `ANTHROPIC_API_KEY` (recommended)
- `CLAUDE_API_KEY` (alternative)

```bash
# Using CLAUDE_API_KEY instead
az containerapp job update \
  --name job-tiger-processor \
  --resource-group rg-tiger \
  --set-env-vars "CLAUDE_API_KEY=secretref:anthropic-api-key"
```

### Verification

Test that your API key works:

```bash
# Test in local Docker first
docker-compose run --rm --entrypoint sh meeting-processor -c "echo 'test' | claude"

# Should see a response from Claude, not an auth error
```

### Why OAuth Tokens Don't Work

| Feature | OAuth Token | API Key |
|---------|-------------|---------|
| **Format** | `sk-ant-oat01-...` | `sk-ant-api03-...` |
| **Type** | Browser session token | Direct API credential |
| **Works in Docker?** | ❌ No | ✅ Yes |
| **Works locally?** | ✅ Yes (with `claude` CLI) | ✅ Yes |
| **Automated flows?** | ❌ No (requires browser) | ✅ Yes |
| **Subscription benefits?** | N/A | ✅ Inherited from account |

### Cost Implications

**With Subscription API Key**:
- Fixed monthly subscription fee
- Lower per-token costs
- Higher rate limits
- ~$0.20-$0.35 per meeting (reduced from $0.30-$0.50)

**Pay-as-You-Go**:
- No monthly fee
- Standard per-token costs
- Standard rate limits
- ~$0.30-$0.50 per meeting

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
{"level":"INFO","message":"Setting up self-contained meeting structure"}
{"level":"INFO","message":"Transcript copied to meeting folder"}
{"level":"INFO","message":"Running agent: timeline-analyzer"}
{"level":"INFO","message":"Running agent: people-analyzer"}
{"level":"INFO","message":"Consolidation complete"}
{"level":"INFO","message":"Dashboard deployed","deployedUrl":"https://..."}
{"level":"INFO","message":"SUCCESS","exitCode":0}
```

Project structure created:
```
projects/yakshaver/
└── 2026-01-21-sprint-review/
    ├── transcript.vtt
    ├── analysis/
    │   ├── timeline.json
    │   ├── people.json
    │   ├── consolidated.json
    │   └── ...
    └── dashboard/
        └── index.html
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
