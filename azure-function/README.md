# T.I.G.E.R. Azure Function

Webhook receiver for Microsoft Graph API transcript notifications.

## Architecture

```
Graph API Webhook → This Function → Download VTT → Blob Storage → Trigger Container App Job
```

## Setup

### 1. Install dependencies

```bash
cd azure-function
npm install
```

### 2. Create local settings

```bash
cp local.settings.json.example local.settings.json
# Edit local.settings.json with your values
```

### 3. Start Azurite (local storage emulator)

```bash

npx azurite --silent --location . --skipApiVersionCheck

# Or install globally
npm install -g azurite
azurite --silent --location . --skipApiVersionCheck
```

**Note:** The `--skipApiVersionCheck` flag is required because the Azure SDK uses newer API versions than Azurite supports.

### 4. Run locally

```bash
npm start
# or
func start
```

## Local Testing (TEST_MODE)

For local development without Graph API access, enable TEST_MODE:

```json
{
  "Values": {
    "TEST_MODE": "true",
    "TEST_VTT_PATH": "../dropzone/sample.vtt"
  }
}
```

### Test with curl

```bash
# Test webhook endpoint
curl -X POST http://localhost:7071/api/TranscriptWebhook \
  -H "Content-Type: application/json" \
  -d '{
    "value": [{
      "resourceData": {
        "@odata.type": "#microsoft.graph.callTranscript",
        "meetingId": "test-meeting-123",
        "id": "transcript-456",
        "meetingOrganizerId": "user-789"
      },
      "testData": {
        "subject": "[YakShaver] Sprint Review",
        "date": "2026-01-26T10:00:00Z",
        "vttPath": "../dropzone/sample.vtt"
      }
    }]
  }'
```

### What TEST_MODE does

| Feature | TEST_MODE=true | TEST_MODE=false (Production) |
|---------|----------------|------------------------------|
| Graph API calls | Mocked | Real API calls |
| Meeting data | From `testData` in request | From Graph API |
| VTT content | From `TEST_VTT_PATH` or mock | Downloaded from Graph |
| Channel name lookup | Skipped | Attempted via Chat API |
| Container App Job | Not triggered (logged) | Triggered |
| Blob Storage | **Works** (uses Azurite) | Works (uses Azure) |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AzureWebJobsStorage` | Yes | `UseDevelopmentStorage=true` for local, connection string for Azure |
| `TRANSCRIPT_CONTAINER_NAME` | No | Blob container name (default: `transcripts`) |
| `TEST_MODE` | No | Set to `true` for local testing without Graph API |
| `TEST_VTT_PATH` | No | Path to local VTT file for TEST_MODE |
| `GRAPH_CLIENT_ID` | Prod | App Registration client ID |
| `GRAPH_CLIENT_SECRET` | Prod | App Registration client secret |
| `GRAPH_TENANT_ID` | Prod | Azure AD tenant ID |
| `SUBSCRIPTION_ID` | Prod | Azure subscription ID |
| `CONTAINER_APP_JOB_RESOURCE_GROUP` | Prod | Resource group for Container App Job |
| `CONTAINER_APP_JOB_NAME` | Prod | Name of Container App Job to trigger |
| `CONTAINER_APP_JOB_IMAGE` | Prod | Docker image for the processor (e.g., `ghcr.io/ssw/tiger-processor:latest`) |
| `WEBHOOK_CLIENT_STATE` | Prod | Secret for validating Graph webhook notifications |

## Meeting Filter

**Only meetings with "sprint" in the subject are processed.** All other meetings are skipped.

Examples:
- ✅ `[Tiger] Sprint Planning` - processed
- ✅ `YakShaver - Sprint Review` - processed
- ✅ `Sprint Retrospective` - processed
- ❌ `Daily Standup` - skipped
- ❌ `Team Sync` - skipped

## Project Name Resolution

The function extracts project name from the meeting subject:

| Meeting Subject | Project | Filename |
|-----------------|---------|----------|
| `[YakShaver] Sprint Review` | `yakshaver` | `2026-01-23-sprint-review.vtt` |
| `YakShaver - Sprint Review` | `yakshaver` | `2026-01-23-sprint-review.vtt` |
| `YakShaver: Sprint Review` | `yakshaver` | `2026-01-23-sprint-review.vtt` |
| `Sprint Planning` | `general` | `2026-01-23-sprint-planning.vtt` |

**Supported formats:**
- `[ProjectName] Meeting Title` - Square brackets prefix
- `ProjectName - Meeting Title` - Dash separator (if ProjectName ≤30 chars)
- `ProjectName: Meeting Title` - Colon separator (if ProjectName ≤30 chars)

**Fallback:** If no project can be determined, files go to the `general` folder.

## Graph API Permissions

| Permission | Type | Purpose |
|------------|------|---------|
| `OnlineMeetings.Read.All` | Application | Read meeting details (subject, date) |
| `OnlineMeetingTranscript.Read.All` | Application | Download transcript content |

## Webhook Flow

1. **Validation**: Graph API sends `validationToken` query param → return it as response
2. **Notification**: Graph API POSTs transcript created event
3. **Processing**:
   - Authenticate with Graph API (client credentials)
   - Fetch meeting details (subject, startDateTime)
   - **Filter**: Skip if subject doesn't contain "sprint"
   - Extract project name from subject (supports `[]`, `-`, `:` formats)
   - Download VTT transcript content
   - Upload to Blob Storage (`{project}/{date}-{slug}.vtt`)
   - Trigger Container App Job (fire-and-forget, job runs asynchronously)

**Note**: The Container App Job runs asynchronously after the webhook returns. Processing a transcript may take 30+ minutes. Monitor job execution via Azure Portal or CLI (see DEPLOYMENT.md for commands).

## Deployment

### Deploy to Azure

```bash
# From azure-function directory
func azure functionapp publish func-tiger-staging
```

### Create Graph Subscription

After deploying, create the webhook subscription:

```bash
az rest --method POST \
  --uri "https://graph.microsoft.com/v1.0/subscriptions" \
  --headers "Content-Type=application/json" \
  --body '{
    "changeType": "created",
    "notificationUrl": "https://func-tiger-staging.azurewebsites.net/api/TranscriptWebhook?code=YOUR_FUNCTION_KEY",
    "resource": "communications/onlineMeetings/getAllTranscripts",
    "expirationDateTime": "2026-02-26T00:00:00Z",
    "clientState": "your-secret-state"
  }'
```

**Note**: Graph subscriptions expire (max 4230 minutes for transcripts). Set up renewal logic or use Azure Logic Apps for auto-renewal.

## Troubleshooting

### Azurite connection refused

```bash
# Make sure Azurite is running
npx azurite --silent --location .
```

### "Failed to fetch meeting details"

- Check `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `GRAPH_TENANT_ID`
- Verify app registration has required permissions
- Check if permissions are admin-consented

### Project name not extracted correctly

- Ensure meeting subject follows one of the supported formats:
  - `[ProjectName] Meeting Title`
  - `ProjectName - Meeting Title`
  - `ProjectName: Meeting Title`
- Project name must be ≤30 characters and not contain " and "
