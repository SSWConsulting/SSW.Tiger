# Project T.I.G.E.R. Automation Pipeline

Automate meeting transcript processing from Microsoft Teams through to surge.sh deployment, with notifications back to the channel.

---

## Architecture Overview

```
Microsoft Teams Meeting Ends
       ↓
Graph API Webhook → Azure Function (trigger)
       ↓
Function triggers → Container App Job
       ↓
Job pulls image from ghcr.io
       ↓
Claude processes transcript → Deploys dashboard to surge.sh
       ↓
Posts link back to Teams (via Graph API)
```

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
| Local Testing | ⏳ NEXT | Test container locally first |
| Bicep Infrastructure | ❌ TODO | Container App + Function + Key Vault |
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
├── Container Apps Environment
│   └── Container App Job
│       └── Pulls image from ghcr.io (NOT Azure)
│       └── Runs Claude processor
│
├── Function App
│   └── Receives Graph webhook
│   └── Triggers Container App Job
│
├── Storage Account
│   └── Required by Function App
│
└── Key Vault
    └── Stores: ANTHROPIC_API_KEY, SURGE_TOKEN, GHCR_TOKEN, Graph secrets
```

**No Azure Container Registry needed** - images live in GitHub Container Registry (ghcr.io).

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
├── main.bicepparam               # Parameters (dev/prod)
└── modules/
    ├── containerApp.bicep        # Container Apps Environment + Job
    ├── functionApp.bicep         # Function App + triggers
    ├── storage.bicep             # Storage Account
    └── keyVault.bicep            # Key Vault + secret references
```

### Resource Dependencies

```
Resource Group
     │
     ├── Key Vault (created first, stores all secrets)
     │
     ├── Storage Account (required by Function App)
     │
     ├── Container Apps Environment
     │        └── Container App Job (references Key Vault secrets)
     │
     └── Function App (references Key Vault, triggers Container App Job)
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

### `modules/containerApp.bicep` - Container App Job

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
          name: 'anthropic-api-key'
          keyVaultUrl: 'https://${keyVaultName}.vault.azure.net/secrets/anthropic-api-key'
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
            { name: 'ANTHROPIC_API_KEY', secretRef: 'anthropic-api-key' }
            { name: 'SURGE_EMAIL', secretRef: 'surge-email' }
            { name: 'SURGE_TOKEN', secretRef: 'surge-token' }
            { name: 'NODE_ENV', value: 'production' }
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
KV_NAME="kv-tiger-dev"

# Claude API key
az keyvault secret set --vault-name $KV_NAME \
  --name anthropic-api-key --value "sk-ant-api03-..."

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

### `TranscriptWebhook/index.js`

```javascript
const { DefaultAzureCredential } = require('@azure/identity');
const { SecretClient } = require('@azure/keyvault-secrets');
const { ContainerAppsAPIClient } = require('@azure/arm-appcontainers');

module.exports = async function (context, req) {
  // Handle Graph webhook validation
  if (req.query.validationToken) {
    context.res = { body: req.query.validationToken };
    return;
  }

  // Process notification
  const notifications = req.body.value || [];

  for (const notification of notifications) {
    if (notification.resourceData?.['@odata.type'] === '#microsoft.graph.callTranscript') {
      // Trigger Container App Job
      const credential = new DefaultAzureCredential();
      const client = new ContainerAppsAPIClient(credential, process.env.SUBSCRIPTION_ID);

      await client.jobs.start(
        'rg-tiger-dev',
        'cae-tiger-dev-processor',
        {
          template: {
            containers: [{
              env: [
                { name: 'MEETING_ID', value: notification.resourceData.meetingId },
                { name: 'TRANSCRIPT_ID', value: notification.resourceData.id }
              ]
            }]
          }
        }
      );
    }
  }

  context.res = { status: 202 };
};
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
| `anthropic-api-key` | Anthropic Console | Claude API access |
| `surge-email` | surge.sh account | Dashboard deployment |
| `surge-token` | `surge token` command | Dashboard deployment |
| `ghcr-token` | GitHub PAT (packages:read) | Pull container images |
| `graph-client-id` | App Registration | Graph API auth |
| `graph-client-secret` | App Registration | Graph API auth |
| `graph-tenant-id` | App Registration | Graph API auth |

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
