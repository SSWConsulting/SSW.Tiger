# T.I.G.E.R. Automated Pipeline

**T**ranscript **I**ntelligence **G**roup **E**vent **R**easoning

Fully automated meeting transcript processing pipeline that transforms Microsoft Teams meetings into actionable intelligence dashboards.

---

## 🎯 What This Does

When a Microsoft Teams meeting ends, the system automatically:

1. **Detects** new transcripts via Microsoft Graph webhooks
2. **Downloads** the transcript content (.vtt format)
3. **Processes** using Claude AI to generate comprehensive analysis
4. **Deploys** an HTML dashboard to surge.sh
5. **Notifies** meeting participants with the dashboard link

All without human intervention.

---

## 🏗️ High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Microsoft Teams Meeting Ends                  │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│  Graph API Subscription (Webhook)                               │
│  • Resource: /communications/onlineMeetings/{id}/transcripts     │
│  • Notification type: updated                                   │
│  • Filters: callTranscript resource type                        │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│  Azure Function: TranscriptWebhook                              │
│  • Validates webhook notification                               │
│  • Extracts meeting/transcript IDs                              │
│  • Writes message to Azure Storage Queue                        │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│  Azure Function: ProcessTranscriptQueue                         │
│  • Dequeue message (automatic retry on failure)                 │
│  • Deduplication check (prevents reprocessing)                  │
│  • Triggers Container App Job with parameters                   │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│  Azure Container Apps Job                                       │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ 1. download-transcript.js                                 │  │
│  │    • Authenticate with Graph API                          │  │
│  │    • Fetch meeting details                                │  │
│  │    • Filter: Only process "sprint" meetings               │  │
│  │    • Extract project name from subject                    │  │
│  │    • Generate filename: YYYY-MM-DD-HHmmss.vtt             │  │
│  │    • Download transcript content                          │  │
│  │    • Output: JSON result with transcript path             │  │
│  └───────────────────────────────────────────────────────────┘  │
│                          │                                       │
│                          ↓                                       │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ 2. processor.js                                           │  │
│  │    • Wrapper for Claude Code CLI                          │  │
│  │    • Validates transcript filename format                 │  │
│  │    • Creates project folder structure                     │  │
│  │    • Invokes Claude CLI with streaming output             │  │
│  │    • Monitors for DEPLOYED_URL in stdout                  │  │
│  │    • Extracts dashboard URL from output                   │  │
│  └───────────────────────────────────────────────────────────┘  │
│                          │                                       │
│                          ↓                                       │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ 3. Claude Code CLI                                        │  │
│  │    • Parses .vtt transcript                               │  │
│  │    • Runs 5 specialized analysis agents in parallel:      │  │
│  │      - timeline-analyzer (forensic time analysis)         │  │
│  │      - people-analyzer (participant scoring)              │  │
│  │      - insights-generator (hidden patterns)               │  │
│  │      - analytics-generator (meeting costs & grading)      │  │
│  │      - longitudinal-analyzer (recurring issues)           │  │
│  │    • Consolidates outputs (name normalization)            │  │
│  │    • Generates SSW-branded HTML dashboard                 │  │
│  │    • Deploys to surge.sh                                  │  │
│  │    • Outputs: DEPLOYED_URL=https://...surge.sh            │  │
│  └───────────────────────────────────────────────────────────┘  │
│                          │                                       │
│                          ↓                                       │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ 4. send-teams-notification.js                             │  │
│  │    • Parse participants from meeting data                 │  │
│  │    • Call Azure Logic App HTTP trigger                    │  │
│  │    • Logic App sends individual messages via Flow bot     │  │
│  │    • Each participant receives dashboard link             │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│  Microsoft Teams (Flow Bot)                                     │
│  • Private message sent to each participant                     │
│  • Contains dashboard URL and meeting summary                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔄 Detailed Processing Steps

### Step 1: Webhook Reception
**Component**: `TranscriptWebhook.js` (Azure Function)

**Trigger**: Microsoft Graph API sends webhook notification when transcript is updated

**Logic**:
```javascript
1. Receive HTTP POST from Graph API
2. Validate webhook (return validationToken if present)
3. Verify clientState matches WEBHOOK_CLIENT_STATE (security)
4. Filter: Only process callTranscript resourceData types
   (Note: ALL transcripts are queued - meeting filtering happens later)
5. Extract IDs from notification:
   - userId (meeting organizer)
   - meetingId (online meeting ID)
   - transcriptId (transcript resource ID)
6. Write message to Azure Storage Queue "transcript-notifications"
7. Return 200 OK to Graph API (prevents retry)
```

**Why Queue?**
- Decouples webhook from processing (webhook must respond quickly)
- Provides automatic retry on failure
- Prevents duplicate processing during Graph API retries

---

### Step 2: Queue Processing & Job Trigger
**Component**: `ProcessTranscriptQueue.js` (Azure Function)

**Trigger**: Message appears in "transcript-notifications" queue

**Logic**:
```javascript
1. Dequeue message (automatically triggered)
2. Parse message: { userId, meetingId, transcriptId }
3. Deduplication check:
   - Check in-memory cache for `${meetingId}-${transcriptId}`
   - If found within 10 minutes: Skip (already processing)
   - If not found: Mark as processing
4. Prepare environment variables for Container App Job:
   - GRAPH_USER_ID, GRAPH_MEETING_ID, GRAPH_TRANSCRIPT_ID
   - GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, GRAPH_TENANT_ID
   - ANTHROPIC_API_KEY (from Key Vault reference)
   - SURGE_EMAIL, SURGE_TOKEN (from Key Vault reference)
5. Generate unique execution ID
6. Trigger Container App Job via Azure SDK:
   - Pass all environment variables
   - Set timeout: 30 minutes
   - Fire-and-forget (async processing)
7. Send "started" notification to participants (optional)
8. Return success (removes message from queue)
```

**Error Handling**:
- Function throws: Message returns to queue for retry (automatic)
- Max 5 retries, then moved to poison queue

---

### Step 3: Container App Job Execution
**Component**: Docker container running `entrypoint.sh`

**Trigger**: Container App Job execution started by ProcessTranscriptQueue

**Environment Variables Passed**:
```bash
# Graph API credentials
GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, GRAPH_TENANT_ID
GRAPH_USER_ID, GRAPH_MEETING_ID, GRAPH_TRANSCRIPT_ID

# Claude authentication
ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN

# Surge.sh deployment
SURGE_EMAIL, SURGE_TOKEN

# Optional: Cancellation support
CHECK_CANCELLATION_URL (Function App endpoint to check cancel status)
JOB_EXECUTION_ID (unique execution ID)

# Optional: Teams notification
LOGIC_APP_URL (Logic App HTTP trigger)
```

**Execution Flow**:

#### 3.1. Authentication Setup (`entrypoint.sh`)
```bash
1. Check for Claude credentials:
   - If CLAUDE_CODE_OAUTH_TOKEN: Use OAuth (subscription)
   - If ANTHROPIC_API_KEY: Use API key (pay-as-you-go)
   - If neither: Fail with error
2. Configure Claude CLI authentication
3. Start background cancellation checker (if CHECK_CANCELLATION_URL set):
   - Poll every 15 seconds
   - If cancelled: Kill process group
```

#### 3.2. Download Transcript (`download-transcript.js`)
```javascript
1. Validate required environment variables
2. Acquire Graph API access token:
   - POST to https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
   - Scope: https://graph.microsoft.com/.default
   - Grant type: client_credentials
3. Fetch meeting details:
   - GET /users/{userId}/onlineMeetings/{meetingId}
   - Extract: subject, startDateTime, participants
4. ⭐ Filter meeting (THIS IS WHERE FILTERING HAPPENS):
   - Check if subject matches MEETING_FILTER_PATTERN (default: "sprint")
   - If not matched: Output {"skipped": true, "reason": "..."} and exit 0
   - If matched: Continue processing
   - NOTE: The Container App Job runs for ALL transcripts but exits early if not matched
5. Extract project name from subject:
   - Pattern: [ProjectName] Sprint Review → "projectname"
   - Lowercase, remove special characters
6. Generate filename:
   - Format: YYYY-MM-DD-HHmmss.vtt
   - Example: 2026-02-04-143000.vtt
7. Download transcript content:
   - GET /users/{userId}/onlineMeetings/{meetingId}/transcripts/{transcriptId}/content?$format=text/vtt
   - Requires: Application Access Policy (Teams Admin consent)
8. Save to file: /tmp/{filename}.vtt
9. Output JSON to stdout:
   {
     "success": true,
     "transcriptPath": "/tmp/2026-02-04-143000.vtt",
     "projectName": "projectname",
     "meetingDate": "2026-02-04",
     "filename": "2026-02-04-143000.vtt",
     "participants": [...] // For notifications
   }
```

**Error Cases**:
- Meeting not found: Exit 0 with `{"skipped": true}`
- Subject doesn't match filter: Exit 0 with `{"skipped": true}`
- Download failed: Exit 1 with `{"error": true}`

#### 3.3. Process Transcript (`processor.js`)
```javascript
1. Parse arguments: <transcript-path> <project-name>
2. Validate transcript filename:
   - Must match: YYYY-MM-DD-HHmmss.vtt
   - Extract: meetingId, meetingDate, meetingTime
3. Validate credentials:
   - Require: SURGE_EMAIL + SURGE_TOKEN
   - Check: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
4. Create project folder structure:
   projects/{project-name}/{meeting-id}/
   ├── transcript.vtt          (copy of original)
   ├── analysis/               (Claude agent outputs)
   └── dashboard/              (generated HTML)
5. Invoke Claude Code CLI:
   Command: claude --stream --output-format=json
   Input: "Process the transcript: {transcript-path} for project {project-name}"
   
6. Stream processing:
   - Read stdout line-by-line (JSON events)
   - Parse events: {type, message: {content}}
   - Skip tool_use/tool_result events (too noisy)
   - Extract text preview from assistant messages
   - Log progress to stderr
   
7. Monitor for deployment:
   - Search stdout for: DEPLOYED_URL=https://...surge.sh
   - Extract URL using regex
   - Validate URL format
   
8. Wait for completion:
   - Claude CLI exits with code 0 = success
   - Any non-zero exit code = failure
   
9. Output to stdout:
   DEPLOYED_URL=https://projectname-2026-02-04-143000.surge.sh
```

**Claude Processing (Internal)**:
```
1. timeline-analyzer:     Parse VTT → Extract timeline → Identify time waste
2. people-analyzer:       Score participants → Value-per-minute → Power dynamics
3. insights-generator:    Find hidden patterns → Elephants in the room
4. analytics-generator:   Calculate costs → Grade meeting (A-F)
5. longitudinal-analyzer: Track recurring issues → Accountability audit

6. consolidator:          Normalize names → Cross-reference → Amplify insights

7. generate-dashboard:    Merge all outputs → Apply SSW template → Generate HTML

8. deploy-dashboard:      Upload to surge.sh → Output URL
```

#### 3.4. Send Notification (`send-teams-notification.js`)
```javascript
1. Parse environment variables:
   - DASHBOARD_URL (from processor.js output)
   - MEETING_SUBJECT, PROJECT_NAME
   - PARTICIPANTS_JSON (from download-transcript.js)
   - LOGIC_APP_URL (Azure Logic App endpoint)
   
2. Parse participants:
   - Extract: [{userId: "...", displayName: "...", role: "..."}]
   - Filter: Only participants with userId
   
3. Prepare payload:
   {
     "notificationType": "completed",
     "dashboardUrl": "https://...",
     "projectName": "...",
     "meetingSubject": "...",
     "participants": [...]
   }
   
4. Call Logic App:
   - POST to LOGIC_APP_URL
   - Content-Type: application/json
   - Logic App handles individual message sending
   
5. Output result:
   {"success": true, "recipientCount": N}
```

**Logic App Flow** (configured separately):
```
1. Receive HTTP POST
2. Parse request body
3. For each participant:
   - Send individual message via Flow bot
   - Message includes: Dashboard URL, meeting summary
   - Delivered as private chat message
```

---

## 🛡️ Security & Authentication

### Graph API Authentication
**Type**: Application (app-only) authentication

**Permissions Required**:
- `OnlineMeetings.Read.All` - Read meeting metadata
- `CallRecords.Read.All` - Access transcripts
- `Chat.Create` - Send notifications (optional)

**Application Access Policy**:
- Required for transcript download
- Must be configured by Teams Admin
- Limits access to specific users/groups

### Claude CLI Authentication
**Options**:
1. **OAuth Token** (Subscription): `CLAUDE_CODE_OAUTH_TOKEN`
   - Best for production (lower per-request cost)
   - Get via: `claude auth login`
2. **API Key** (Pay-as-you-go): `ANTHROPIC_API_KEY`
   - Best for testing/development
   - Get from: https://console.anthropic.com/

### Surge.sh Authentication
**Required**: Email + Token
- Get token: `surge token`
- Store in Key Vault

### Key Vault Integration
All secrets stored in Azure Key Vault:
```bicep
@Microsoft.KeyVault(SecretUri=https://{vault}.vault.azure.net/secrets/AnthropicApiKey)
```

Accessed via **Managed Identity** (no credentials in code)

---

## 📊 Cost Optimization

### Resource Sizing
**Container App Job**:
- CPU: 0.5 cores
- Memory: 1 GB
- Timeout: 30 minutes
- Consumption-based pricing (pay per execution)

**Function App**:
- Consumption plan
- Pay per execution + compute time
- Auto-scales to zero when idle

**Storage Queue**:
- Minimal cost (~$0.05/month for 1M operations)
- Used only for queuing webhook notifications

### Claude API Costs
**Typical Transcript** (1 hour meeting, ~10K tokens):
- Input: ~10K tokens × $3/$1M = $0.03
- Output: ~5K tokens × $15/$1M = $0.075
- **Total: ~$0.10 per meeting**

**Optimization Strategies**:
1. Use OAuth token (subscription) for high volume
2. Filter meetings early (Container App Job exits if meeting doesn't match pattern)
3. Deduplication (prevent reprocessing the same transcript)
4. Consider filtering at webhook level if your Graph subscription supports it (advanced)

---

## 🔧 Configuration

### Environment Variables (Container App Job)

**Required**:
```bash
# Graph API
GRAPH_CLIENT_ID=...
GRAPH_CLIENT_SECRET=...
GRAPH_TENANT_ID=...

# Claude Authentication (choose one)
ANTHROPIC_API_KEY=...              # Pay-as-you-go
CLAUDE_CODE_OAUTH_TOKEN=...        # Subscription

# Surge.sh Deployment
SURGE_EMAIL=...
SURGE_TOKEN=...
```

**Optional**:
```bash
# Meeting Filter
MEETING_FILTER_PATTERN=sprint      # Regex pattern (default: "sprint")

# Notifications
LOGIC_APP_URL=...                  # Logic App HTTP trigger
CHECK_CANCELLATION_URL=...         # Cancel endpoint

# Mock Testing
USE_MOCK_TRANSCRIPT=true
MOCK_TRANSCRIPT_PATH=./test.vtt
```

### Bicep Parameters

**Required** (`staging.bicepparam`):
```bicep
param project = 'tiger'
param environment = 'staging'
param githubOrg = 'your-org'
param costCategoryTag = { 'cost-category': 'dev/test' }
```

---

## 🚀 Deployment

### Prerequisites
1. Azure subscription
2. App Registration (Graph API permissions)
3. GitHub repository (for CI/CD)
4. Claude API access (API key or OAuth)
5. Surge.sh account

### Initial Setup

#### 1. Configure GitHub Secrets
```bash
AZURE_CREDENTIALS         # Service principal JSON
GHCR_TOKEN               # GitHub Container Registry token
```

#### 2. Deploy Infrastructure
```bash
cd infra
az deployment group create \
  --resource-group SSW.Transcript-Intelligence-Group-Event-Reasoning.Dev \
  --template-file main.bicep \
  --parameters staging.bicepparam
```

#### 3. Store Secrets in Key Vault
```bash
az keyvault secret set --vault-name kv-tiger-staging \
  --name AnthropicApiKey --value "sk-ant-..."
  
az keyvault secret set --vault-name kv-tiger-staging \
  --name SurgeToken --value "..."
```

#### 4. Create Graph Subscription
```bash
cd azure-function/scripts
./Create-GraphSubscription.ps1 \
  -TenantId "..." \
  -ClientId "..." \
  -ClientSecret "..." \
  -WebhookUrl "https://func-tiger-staging.azurewebsites.net/api/TranscriptWebhook"
```

### CI/CD Pipeline

**Trigger**: Push to `main` branch

**Steps**:
1. Build Docker image
2. Push to ghcr.io
3. Update Container App Job (image reference)
4. Deploy Azure Function code

**GitHub Actions**: `.github/workflows/deploy.yml`

---

## 🧪 Testing

### Local Testing (Docker Compose)

```bash
# 1. Create .env file
cp .env.example .env
# Edit .env with credentials

# 2. Build container
docker-compose build

# 3. Test with mock transcript
docker-compose run --rm meeting-processor \
  /app/dropzone/test.vtt \
  test-project

# 4. Verify output
# - Dashboard generated in projects/test-project/
# - Deployed to surge.sh
```

### E2E Testing (Azure)

#### Test 1: Webhook Validation
```bash
# Trigger webhook validation
curl -X POST https://func-tiger-staging.azurewebsites.net/api/TranscriptWebhook?validationToken=test123

# Expected: Returns "test123"
```

#### Test 2: Full Pipeline
```bash
# 1. Schedule a Teams meeting
# 2. Include "sprint" in the subject
# 3. Record the meeting
# 4. End the meeting
# 5. Wait ~2 minutes for transcript generation
# 6. Check Function logs for webhook notification
# 7. Check Container App Job logs for processing
# 8. Verify dashboard deployed to surge.sh
# 9. Check Teams for notification message
```

#### Test 3: Cancellation
```bash
# 1. Trigger processing (as above)
# 2. Receive "started" notification in Teams
# 3. Click "Cancel Processing" adaptive card action
# 4. Verify Container App Job terminates
# 5. Receive "cancelled" notification in Teams
```

---

## 📈 Monitoring & Troubleshooting

### Application Insights Queries

**Webhook notifications received**:
```kusto
traces
| where message contains "[TIGER]"
| where message contains "Validation request"
| summarize count() by bin(timestamp, 1h)
```

**Container App Job executions**:
```kusto
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "job-tiger-staging"
| where Log_s contains "DEPLOYED_URL"
| project timestamp, Log_s
```

**Processing errors**:
```kusto
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "job-tiger-staging"
| where Log_s contains "\"level\":\"error\""
| project timestamp, Log_s
```

### Common Issues

**Issue**: Webhook not triggering
- **Check**: Graph subscription status (expires every 3 days)
- **Solution**: Run `RenewSubscription.js` Azure Function (scheduled)

**Issue**: Transcript download fails (403)
- **Check**: Application Access Policy configured
- **Solution**: Contact Teams Admin to grant policy

**Issue**: Claude processing times out
- **Check**: Container App Job timeout setting
- **Solution**: Increase timeout or reduce transcript length

**Issue**: Dashboard not deploying
- **Check**: Surge credentials in Key Vault
- **Solution**: Verify SURGE_EMAIL and SURGE_TOKEN

---

## 🔐 Secrets Management

### Key Vault Secrets

| Secret Name | Purpose | Get From |
|-------------|---------|----------|
| `AnthropicApiKey` | Claude API authentication | https://console.anthropic.com/ |
| `ClaudeCodeOAuthToken` | Claude subscription (alternative) | `claude auth login` |
| `SurgeToken` | Surge.sh deployment | `surge token` |
| `GraphClientSecret` | Graph API app secret | Azure Portal → App Registration |
| `WebhookClientState` | Webhook validation | Generate random string |

### Accessing Secrets (Managed Identity)

**Function App**:
```javascript
// Key Vault reference in app settings:
// @Microsoft.KeyVault(SecretUri=https://...)
const apiKey = process.env.ANTHROPIC_API_KEY;
```

**Container App Job**:
```yaml
# Bicep configuration:
env: [
  {
    name: 'ANTHROPIC_API_KEY'
    secretRef: 'anthropic-api-key'
  }
]
secrets: [
  {
    name: 'anthropic-api-key'
    keyVaultUrl: 'https://kv-tiger-staging.vault.azure.net/secrets/AnthropicApiKey'
    identity: managedIdentityResourceId
  }
]
```

---

## 📚 Project Structure

```
SSW.Tiger/
├── azure-function/              # Azure Functions (webhook + queue processor)
│   ├── host.json
│   ├── package.json
│   ├── src/
│   │   └── functions/
│   │       ├── TranscriptWebhook.js        # Webhook receiver
│   │       ├── ProcessTranscriptQueue.js   # Job trigger
│   │       ├── RenewSubscription.js        # Auto-renewal (timer)
│   │       └── CancelProcessing.js         # Cancel endpoint
│   └── scripts/
│       └── Create-GraphSubscription.ps1    # Initial subscription setup
├── infra/                       # Bicep Infrastructure as Code
│   ├── main.bicep              # Orchestration
│   ├── staging.bicepparam      # Parameters
│   └── modules/
│       ├── containerApp.bicep
│       ├── functionApp.bicep
│       ├── keyVault.bicep
│       ├── storage.bicep
│       └── monitoring.bicep
├── templates/
│   └── dashboard.html          # SSW-branded dashboard template
├── projects/                   # .gitignored - generated output
│   └── {project}/
│       └── {meeting-id}/
│           ├── transcript.vtt
│           ├── analysis/
│           └── dashboard/
├── Dockerfile                  # Container image definition
├── docker-compose.yml          # Local testing
├── entrypoint.sh              # Container entrypoint
├── download-transcript.js     # Graph API transcript downloader
├── processor.js               # Claude CLI wrapper
├── send-teams-notification.js # Notification sender
├── package.json
└── README-AUTOMATION.md       # This file
```

## Application access policy issue
"No application access policy found for this app." According to Microsoft documentation, for security reasons, an Application Access Policy is also needed other than API permission.  A Teams administrator needs to create an Application Access Policy to grant this app permission to access meeting transcripts for all users.

Documentation: https://learn.microsoft.com/en-us/graph/cloud-communication-online-meeting-application-access-policy