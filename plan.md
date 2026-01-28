# Project T.I.G.E.R. Automation Pipeline

Automate meeting transcript processing from Microsoft Teams through to surge.sh deployment, with notifications back to the channel.

---

## Architecture Overview

```
Microsoft Teams Meeting Ends
       ↓
Graph API Webhook → Azure Function
       ↓
Function downloads VTT from Graph API
       ↓
Function uploads VTT to Blob Storage (with date-based naming)
       ↓
Function triggers Container App Job (passes: BLOB_PATH, PROJECT_NAME, MEETING_DATE)
       ↓
Job downloads VTT from Blob Storage
       ↓
Job runs: node processor.js /tmp/{date}.vtt {project-name}
       ↓
Claude processes transcript → Deploys dashboard to surge.sh
       ↓
Posts link back to Teams (via Graph API)
```

---

## 🏗️ Decision: Option B (Job downloads VTT directly)

### Architecture Choice: Option B

```
┌─────────────────────────────────────────────────────────────────┐
│  Webhook → Function → Job → Graph API → /tmp → Process         │
│              │                                                  │
│              └─ Passes: MEETING_ID, TRANSCRIPT_ID, PROJECT_NAME │
└─────────────────────────────────────────────────────────────────┘
```

### Why Option B?

| Factor | Benefit |
|--------|---------|
| **Simpler Architecture** | No Blob intermediate layer |
| **Single Responsibility** | Function is pure trigger, Job handles everything |
| **Less Infrastructure** | No transcript container, no lifecycle policy |
| **Debugging** | Can manually download VTT from Teams when needed |

### How It Works

1. **Graph Webhook** notifies Function when transcript is created
2. **Function** extracts meeting info and triggers Container App Job with:
   - `MEETING_ID` - Graph meeting identifier
   - `TRANSCRIPT_ID` - Graph transcript identifier
   - `PROJECT_NAME` - Extracted from meeting subject
3. **Container App Job** downloads VTT directly from Graph API
4. **processor.js** processes transcript and deploys dashboard
5. **Posts link** back to Teams chat/channel

### Debugging Strategy

When issues occur:
1. Download VTT manually from Teams meeting
2. Run locally: `node processor.js ./downloaded.vtt test-project`
3. Check Container App Job logs in Azure Portal

---

## ✅ Current Status

| Component | Status | Notes |
|-----------|--------|-------|
| App Registration | ✅ DONE | Graph permissions configured |
| Resource Group | ✅ DONE | Dev environment provisioned |
| API Key | ✅ DONE | ANTHROPIC_API_KEY available |
| Dockerfile | ✅ DONE | Claude CLI, Node.js, surge configured |
| processor.js | ✅ DONE | Wrapper for Claude CLI |
| docker-compose.yml | ✅ DONE | Local testing ready |
| Local Testing | ✅ DONE | Test container locally first |
| Bicep Infrastructure | ⏳ NEXT | Container App + Function + Key Vault |
| GitHub Actions CI/CD | ❌ TODO | Build image → Push to ghcr.io |
| Azure Function | ❌ TODO | Webhook receiver |
| Graph Subscription | ❌ TODO | Trigger on transcript created |

---

## Azure Resources (Minimal)

Your entire Azure footprint:

```
Resource Group (rg-tiger-dev)
│
├── App Registration (already done)
│   └── Graph API permissions for Teams access
│
├── Managed Identity (User-Assigned)
│   └── Used by Function App and Container App Job
│   └── Has RBAC access to Key Vault
│
├── Container Apps Environment
│   └── Container App Job
│       └── Pulls image from ghcr.io (NOT Azure)
│       └── Downloads VTT directly from Graph API
│       └── Runs Claude processor
│
├── Function App
│   └── Receives Graph webhook
│   └── Triggers Container App Job (passes meeting ID, transcript ID)
│
├── Storage Account
│   └── Required by Function App runtime only
│
└── Key Vault
    └── Stores: CLAUDE_CODE_OAUTH_TOKEN, SURGE_TOKEN, GHCR_TOKEN, Graph secrets
```

**No Azure Container Registry needed** - images live in GitHub Container Registry (ghcr.io).
**No Blob transcript storage** - Job downloads VTT directly from Graph API (Option B).

---

## 🚀 Phase 1: Local Validation

Before deploying to Azure, validate everything works locally.

### 1. Create `.env` file

```bash
cp .env.example .env
```

Edit `.env`:
```
ANTHROPIC_API_KEY=sk-ant-api03-YOUR-KEY-HERE
SURGE_EMAIL=your_email@example.com
SURGE_TOKEN=your_surge_token_here
```

### 2. Test with Docker Compose

```bash
# Build container
docker-compose build

# Place test transcript in dropzone/
mkdir -p dropzone
cp your-transcript.vtt dropzone/2026-01-23-test.vtt

# Run processor
docker-compose run --rm meeting-processor /app/dropzone/2026-01-23-test.vtt test-project
```

### 3. Verify Output

- Dashboard generated in `projects/test-project/2026-01-23-test/dashboard/index.html`
- Deployed to surge.sh (check logs for URL)

---

## 🏗️ Phase 2: Bicep Infrastructure

Deploy Azure resources using Infrastructure as Code.

### Bicep File Structure

```
infra/
├── main.bicep                    # Orchestration
├── staging.bicepparam            # Parameters (staging)
└── modules/
    ├── containerApp.bicep        # Container Apps Environment + Job
    ├── functionApp.bicep         # Function App + webhook + Graph download
    ├── storage.bicep             # Storage Account + transcripts container
    ├── keyVault.bicep            # Key Vault + secret references
    ├── keyVaultRoleAssignment.bicep    # RBAC for Key Vault access
    ├── storageRoleAssignment.bicep     # RBAC for Blob access
    └── managedIdentity.bicep     # User-assigned managed identity
```

### Resource Dependencies

```
Resource Group
     │
     ├── Managed Identity (created first, used by all services)
     │
     ├── Key Vault (stores all secrets)
     │        └── RBAC: Managed Identity → Key Vault Secrets User
     │
     ├── Storage Account (Function App + transcript storage)
     │        └── transcripts/ container (7-day lifecycle)
     │        └── RBAC: Managed Identity → Storage Blob Data Reader
     │
     ├── Container Apps Environment
     │        └── Container App Job
     │                └── Uses Managed Identity
     │                └── References Key Vault secrets
     │                └── Reads VTT from Blob Storage
     │
     └── Function App
              └── Uses Managed Identity
              └── References Key Vault for Graph credentials
              └── Writes VTT to Blob Storage
              └── Triggers Container App Job
```

### `main.bicep` - Orchestration

```bicep
targetScope = 'subscription'

@allowed(['dev', 'prod'])
param environment string = 'dev'

param location string = 'australiaeast'
param projectName string = 'tiger'

// Resource Group
resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${projectName}-${environment}'
  location: location
}

// Key Vault (secrets storage)
module keyVault 'modules/keyVault.bicep' = {
  name: 'keyVault'
  scope: rg
  params: {
    name: 'kv-${projectName}-${environment}'
    location: location
  }
}

// Storage Account (for Function App)
module storage 'modules/storage.bicep' = {
  name: 'storage'
  scope: rg
  params: {
    name: '${projectName}${environment}storage'
    location: location
  }
}

// Container Apps Environment + Job
module containerApp 'modules/containerApp.bicep' = {
  name: 'containerApp'
  scope: rg
  params: {
    name: 'cae-${projectName}-${environment}'
    location: location
    keyVaultName: keyVault.outputs.name
    containerImage: 'ghcr.io/${githubOrg}/tiger-processor:latest'
  }
}

// Function App (webhook receiver)
module functionApp 'modules/functionApp.bicep' = {
  name: 'functionApp'
  scope: rg
  params: {
    name: 'func-${projectName}-${environment}'
    location: location
    storageAccountName: storage.outputs.name
    keyVaultName: keyVault.outputs.name
    containerAppJobName: containerApp.outputs.jobName
  }
}

output functionAppUrl string = functionApp.outputs.url
output keyVaultName string = keyVault.outputs.name
```

### `modules/containerApp.bicep` - Container App Job (Option B)

```bicep
param name string
param location string
param keyVaultName string
param containerImage string

// Container Apps Environment
resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: name
  location: location
  properties: {
    zoneRedundant: false
  }
}

// Container App Job (pulls from ghcr.io)
// Option B: Job downloads VTT directly from Graph API
resource processorJob 'Microsoft.App/jobs@2024-03-01' = {
  name: '${name}-processor'
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 1800  // 30 minutes max
      replicaRetryLimit: 1
      secrets: [
        {
          name: 'anthropic-oauth-token'
          keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/anthropic-oauth-token'
          identity: 'system'
        }
        {
          name: 'surge-email'
          keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/surge-email'
          identity: 'system'
        }
        {
          name: 'surge-token'
          keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/surge-token'
          identity: 'system'
        }
        {
          name: 'ghcr-token'
          keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/ghcr-token'
          identity: 'system'
        }
        // Graph API credentials (Option B - Job downloads VTT)
        {
          name: 'graph-client-id'
          keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/graph-client-id'
          identity: 'system'
        }
        {
          name: 'graph-client-secret'
          keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/graph-client-secret'
          identity: 'system'
        }
        {
          name: 'graph-tenant-id'
          keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/graph-tenant-id'
          identity: 'system'
        }
      ]
      registries: [
        {
          server: 'ghcr.io'
          username: 'yourGitHubUsername'
          passwordSecretRef: 'ghcr-token'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'tiger-processor'
          image: containerImage
          resources: {
            cpu: json('2.0')
            memory: '4Gi'
          }
          env: [
            { name: 'CLAUDE_CODE_OAUTH_TOKEN', secretRef: 'anthropic-oauth-token' }
            { name: 'SURGE_EMAIL', secretRef: 'surge-email' }
            { name: 'SURGE_TOKEN', secretRef: 'surge-token' }
            { name: 'NODE_ENV', value: 'production' }
            // Graph API credentials (Option B - Job downloads VTT)
            { name: 'GRAPH_CLIENT_ID', secretRef: 'graph-client-id' }
            { name: 'GRAPH_CLIENT_SECRET', secretRef: 'graph-client-secret' }
            { name: 'GRAPH_TENANT_ID', secretRef: 'graph-tenant-id' }
            // These are passed when job is triggered:
            // MEETING_ID, TRANSCRIPT_ID, PROJECT_NAME
          ]
        }
      ]
    }
  }
}

output jobName string = processorJob.name
output environmentId string = environment.id
```

### `modules/keyVault.bicep` - Secrets Storage

```bicep
param name string
param location string

resource keyVault 'Microsoft.KeyVault/vaults@2024-04-01-preview' = {
  name: name
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
  }
}

output name string = keyVault.name
output uri string = keyVault.properties.vaultUri
```

### Deploy Commands

```bash
# Preview what will be created
az deployment sub what-if \
  --location australiaeast \
  --template-file infra/main.bicep \
  --parameters environment=dev

# Deploy infrastructure
az deployment sub create \
  --location australiaeast \
  --template-file infra/main.bicep \
  --parameters environment=dev
```

### Post-Deployment: Populate Key Vault Secrets

```bash
KV_NAME="kv-tiger-staging"

# Claude Code OAuth token (get from: claude config get oauthToken)
az keyvault secret set --vault-name $KV_NAME \
  --name anthropic-oauth-token --value "your-oauth-token"

# Surge deployment credentials
az keyvault secret set --vault-name $KV_NAME \
  --name surge-email --value "your@email.com"
az keyvault secret set --vault-name $KV_NAME \
  --name surge-token --value "your-surge-token"

# GitHub Container Registry token (for pulling images)
az keyvault secret set --vault-name $KV_NAME \
  --name ghcr-token --value "ghp_your-github-pat"

# Graph API credentials (from App Registration)
az keyvault secret set --vault-name $KV_NAME \
  --name graph-client-id --value "your-app-client-id"
az keyvault secret set --vault-name $KV_NAME \
  --name graph-client-secret --value "your-app-client-secret"
az keyvault secret set --vault-name $KV_NAME \
  --name graph-tenant-id --value "your-tenant-id"
```

### Grant RBAC Permissions

```bash
# Get Container App Job's managed identity
PRINCIPAL_ID=$(az containerapp job show \
  --name cae-tiger-dev-processor \
  --resource-group rg-tiger-dev \
  --query identity.principalId -o tsv)

# Grant Key Vault Secrets User role
az role assignment create \
  --role "Key Vault Secrets User" \
  --assignee $PRINCIPAL_ID \
  --scope "/subscriptions/{sub-id}/resourceGroups/rg-tiger-dev/providers/Microsoft.KeyVault/vaults/kv-tiger-dev"
```

---

## 🐙 Phase 3: GitHub Actions CI/CD

Build container images and push to GitHub Container Registry.

### Workflow Files

```
.github/workflows/
├── build-container.yml      # Build & push to ghcr.io
├── deploy-infra.yml         # Deploy Bicep infrastructure
└── full-pipeline.yml        # Combined workflow
```

### `build-container.yml` - Build & Push to ghcr.io

```yaml
name: Build Container

on:
  push:
    branches: [main]
    paths:
      - 'Dockerfile'
      - 'processor.js'
      - 'entrypoint.sh'
      - '.claude/**'
      - 'templates/**'
  workflow_dispatch:

permissions:
  contents: read
  packages: write

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: |
            ghcr.io/${{ github.repository_owner }}/tiger-processor:latest
            ghcr.io/${{ github.repository_owner }}/tiger-processor:${{ github.sha }}
```

### `deploy-infra.yml` - Deploy Bicep

```yaml
name: Deploy Infrastructure

on:
  push:
    branches: [main]
    paths: ['infra/**']
  workflow_dispatch:
    inputs:
      environment:
        description: 'Target environment'
        required: true
        default: 'dev'
        type: choice
        options: [dev, prod]

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Azure Login (OIDC)
        uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

      - name: Deploy Bicep
        uses: azure/arm-deploy@v2
        with:
          scope: subscription
          region: australiaeast
          template: infra/main.bicep
          parameters: environment=${{ inputs.environment || 'dev' }}
```

### Setting Up GitHub Actions

1. **Create Azure Service Principal**
   ```bash
   az ad sp create-for-rbac \
     --name "github-tiger-deployer" \
     --role Contributor \
     --scopes /subscriptions/{subscription-id}
   ```

2. **Configure OIDC Federated Credentials** (recommended)
   ```bash
   az ad app federated-credential create \
     --id {app-object-id} \
     --parameters '{
       "name": "github-main",
       "issuer": "https://token.actions.githubusercontent.com",
       "subject": "repo:your-org/your-repo:ref:refs/heads/main",
       "audiences": ["api://AzureADTokenExchange"]
     }'
   ```

3. **Add GitHub Repository Secrets**
   | Secret | Value |
   |--------|-------|
   | `AZURE_CLIENT_ID` | Service principal app ID |
   | `AZURE_TENANT_ID` | Azure AD tenant ID |
   | `AZURE_SUBSCRIPTION_ID` | Your subscription ID |

---

## ⚡ Phase 4: Azure Function (Webhook)

Receives Graph API notifications when transcripts are created.

### Function Structure

```
azure-function/
├── host.json
├── package.json
└── TranscriptWebhook/
    ├── function.json
    └── index.js
```

### `TranscriptWebhook/index.js` (Option B - Simplified)

```javascript
const { DefaultAzureCredential } = require('@azure/identity');
const { ContainerAppsAPIClient } = require('@azure/arm-appcontainers');
const { ConfidentialClientApplication } = require('@azure/msal-node');

// Option B: Function is a pure trigger - Job downloads VTT directly from Graph API
module.exports = async function (context, req) {
  // Handle Graph webhook validation
  if (req.query.validationToken) {
    context.res = { body: req.query.validationToken };
    return;
  }

  const credential = new DefaultAzureCredential();

  for (const notification of req.body.value || []) {
    if (notification.resourceData?.['@odata.type'] !== '#microsoft.graph.callTranscript') {
      continue;
    }

    const meetingId = notification.resourceData.meetingId;
    const transcriptId = notification.resourceData.id;

    // 1. Get Graph API token to fetch meeting details
    const graphToken = await getGraphToken();

    // 2. Get meeting details for project name and date
    const meeting = await fetchMeeting(graphToken, meetingId);
    const meetingDate = meeting.startDateTime.split('T')[0];
    const projectName = extractProjectName(meeting.subject);
    const filename = generateFilename(meeting);

    // 3. Trigger Container App Job (Job will download VTT itself)
    const containerClient = new ContainerAppsAPIClient(credential, process.env.SUBSCRIPTION_ID);
    await containerClient.jobs.start(
      process.env.CONTAINER_APP_JOB_RESOURCE_GROUP,
      process.env.CONTAINER_APP_JOB_NAME,
      {
        template: {
          containers: [{
            name: 'tiger-processor',
            env: [
              { name: 'MEETING_ID', value: meetingId },
              { name: 'TRANSCRIPT_ID', value: transcriptId },
              { name: 'PROJECT_NAME', value: projectName },
              { name: 'MEETING_DATE', value: meetingDate },
              { name: 'FILENAME', value: filename }
            ]
          }]
        }
      }
    );

    context.log(`Triggered job for: ${projectName}/${filename}`);
  }

  context.res = { status: 202 };
};

function extractProjectName(subject) {
  // "[YakShaver] Sprint Review" → "yakshaver"
  const match = subject?.match(/^\[([^\]]+)\]/);
  return match ? match[1].toLowerCase().replace(/\s+/g, '-') : 'default';
}

function generateFilename(meeting) {
  const date = meeting.startDateTime.split('T')[0];
  const slug = meeting.subject
    ?.replace(/^\[[^\]]+\]\s*/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || '';
  return slug ? `${date}-${slug}.vtt` : `${date}.vtt`;
}

async function getGraphToken() {
  const cca = new ConfidentialClientApplication({
    auth: {
      clientId: process.env.GRAPH_CLIENT_ID,
      clientSecret: process.env.GRAPH_CLIENT_SECRET,
      authority: `https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID}`,
    },
  });
  const result = await cca.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  });
  return result.accessToken;
}

async function fetchMeeting(token, meetingId) {
  // Note: May need to use /users/{organizerId}/onlineMeetings/{meetingId}
  const res = await fetch(`https://graph.microsoft.com/v1.0/me/onlineMeetings/${meetingId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.json();
}
```

### Create Graph Subscription

```bash
# After Function App is deployed, create webhook subscription
az rest --method POST \
  --uri "https://graph.microsoft.com/v1.0/subscriptions" \
  --headers "Content-Type=application/json" \
  --body '{
    "changeType": "created",
    "notificationUrl": "https://func-tiger-dev.azurewebsites.net/api/TranscriptWebhook",
    "resource": "communications/onlineMeetings/getAllTranscripts",
    "expirationDateTime": "2026-01-26T00:00:00Z",
    "clientState": "your-secret-state"
  }'
```

---

## 📋 Development Checklist

### ✅ Completed
- [x] App Registration with Graph permissions
- [x] Azure Resource Group
- [x] Anthropic API Key
- [x] Dockerfile
- [x] processor.js
- [x] docker-compose.yml

### 🔄 Phase 1: Local Validation (Current)
- [ ] Create `.env` file with credentials
- [ ] Test with `docker-compose run`
- [ ] Verify dashboard deploys to surge.sh

### ⏳ Phase 2: Bicep Infrastructure
- [ ] Create `infra/main.bicep`
- [ ] Create `infra/modules/containerApp.bicep`
- [ ] Create `infra/modules/keyVault.bicep`
- [ ] Create `infra/modules/storage.bicep`
- [ ] Create `infra/modules/functionApp.bicep`
- [ ] Run `az deployment sub create`
- [ ] Populate Key Vault secrets
- [ ] Grant RBAC permissions

### ⏳ Phase 3: GitHub Actions
- [ ] Create `.github/workflows/build-container.yml`
- [ ] Create `.github/workflows/deploy-infra.yml`
- [ ] Configure Azure OIDC credentials
- [ ] Push and verify image appears in ghcr.io

### ⏳ Phase 4: Azure Function
- [ ] Create Function App code
- [ ] Deploy to Azure
- [ ] Create Graph subscription
- [ ] Test end-to-end

---

## 🔑 Credentials Reference

### Key Vault Secrets (to populate after Bicep deploy)

| Secret Name | Source | Purpose |
|-------------|--------|---------|
| `anthropic-oauth-token` | Claude Code CLI (`claude config get oauthToken`) | Claude Code OAuth access |
| `surge-email` | surge.sh account | Dashboard deployment |
| `surge-token` | `surge token` command | Dashboard deployment |
| `ghcr-token` | GitHub PAT (packages:read) | Pull container images |
| `graph-client-id` | App Registration | Graph API auth |
| `graph-client-secret` | App Registration | Graph API auth |
| `graph-tenant-id` | App Registration | Graph API auth |

**Note:** Using `anthropic-oauth-token` (Claude Code OAuth) instead of `anthropic-api-key` for cost efficiency with subscription pricing.

### GitHub Repository Secrets

| Secret | Purpose |
|--------|---------|
| `AZURE_CLIENT_ID` | Deploy to Azure |
| `AZURE_TENANT_ID` | Deploy to Azure |
| `AZURE_SUBSCRIPTION_ID` | Deploy to Azure |

---

## 💰 Estimated Costs

| Resource | Cost |
|----------|------|
| Container App Job | ~$0.02 per run (20 min @ 2 CPU) |
| Function App | Free tier (1M executions/month) |
| Key Vault | ~$0.03/10K operations |
| Storage Account | ~$0.02/GB/month |
| **ghcr.io** | **Free** (public repos) / included with GitHub |

**Monthly estimate:** Under $5 for typical meeting frequency.
