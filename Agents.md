# T.I.G.E.R. Development Guide

**T**ranscript **I**ntelligence **G**roup **E**vent **R**easoning

## What This System Does

When a Microsoft Teams meeting ends, T.I.G.E.R. automatically downloads the transcript, runs 6 AI analysis agents, generates an HTML dashboard, deploys it to surge.sh, and notifies participants — zero human intervention.

## Architecture at a Glance

```
Teams Meeting Ends
       │
       ▼
TranscriptWebhook.js ──► Storage Queue ──► ProcessTranscriptQueue.js
(Azure Function)          (decouple)        (Azure Function)
                                                    │
                                                    ▼
                                         Container App Job
                                         ┌──────────────────────────┐
                                         │ download-transcript.js   │
                                         │ processor.js → Claude CLI│
                                         │   ├─ timeline-analyzer   │
                                         │   ├─ people-analyzer     │
                                         │   ├─ insights-generator  │
                                         │   ├─ analytics-generator │
                                         │   ├─ longitudinal-anlzr  │
                                         │   └─ consolidator        │
                                         │ → dashboard → surge.sh   │
                                         │ send-teams-notification  │
                                         └──────────────────────────┘
                                                    │
                                                    ▼
                                         Teams message to each participant
```

## Repository Structure

```
SSW.Tiger/
├── azure-function/src/functions/        # Azure Functions (webhook + queue)
│   ├── TranscriptWebhook.js             # Layer 1: Receives Graph API webhooks
│   ├── ProcessTranscriptQueue.js        # Layer 2: Dedup + trigger Container Job
│   ├── RenewSubscription.js             # Timer: Auto-renew Graph subscription
│   └── CancelProcessing.js             # HTTP: Cancel a running job
├── infra/                               # Bicep IaC
│   ├── main.bicep                       # Orchestrator
│   ├── staging.bicepparam               # Environment params
│   └── modules/                         # Per-resource modules
├── .claude/
│   ├── agents/                          # 6 analysis agent prompts
│   └── skills/                          # 6 user-facing skill definitions
├── templates/dashboard.html             # Dashboard HTML template
├── download-transcript.js               # Layer 3: Graph API → .vtt file
├── processor.js                         # Layer 4: Claude CLI wrapper
├── send-teams-notification.js           # Layer 5: Logic App → Teams message
├── entrypoint.sh                        # Container entrypoint
├── Dockerfile / docker-compose.yml      # Container build + local testing
└── projects/                            # .gitignored — generated output
```

## Pipeline Layers

Each layer is decoupled. When developing, identify which layer your change touches.

### Layer 1 — Webhook (`TranscriptWebhook.js`)

Receives Graph API HTTP POST, validates `clientState`, extracts IDs, writes to queue, returns 200 immediately.

**When to modify**: Changing webhook validation logic, adding new event types, updating queue message format.

**Key constraint**: Must respond fast. Never do heavy work here — that's what the queue is for.

### Layer 2 — Queue Processor (`ProcessTranscriptQueue.js`)

Dequeues message, dedup check (10-min in-memory cache on `${meetingId}-${transcriptId}`), prepares env vars from Key Vault, triggers Container App Job.

**When to modify**: Changing dedup logic, adding new env vars to pass to the job, adjusting retry behavior.

**Key constraint**: If this function throws, the message returns to queue for retry (max 5, then poison queue). Keep it idempotent.

### Layer 3 — Transcript Download (`download-transcript.js`)

Authenticates with Graph API (client credentials), fetches meeting details, **filters by subject** (default pattern: `"sprint"`), downloads `.vtt`, outputs JSON to stdout.

**When to modify**: Changing which meetings are processed, adjusting project name extraction, adding new metadata to the output JSON.

**Key constraint**: Non-matching meetings exit 0 with `{"skipped": true}` — not exit 1. This avoids false alerts and unnecessary retries.

### Layer 4 — Claude Processing (`processor.js`)

Wraps the Claude Code CLI. Creates project folder structure, invokes `claude --stream --output-format=json`, monitors stdout for `DEPLOYED_URL=https://...`.

**When to modify**: Changing how Claude CLI is invoked, adjusting streaming output parsing, modifying the folder structure.

**Key constraint**: The `DEPLOYED_URL=` line is a contract. `processor.js` regex-parses it to extract the dashboard URL for notifications. The line must be plain text, own line, with `https://` protocol. Breaking this format breaks notifications.

### Layer 5 — Notification (`send-teams-notification.js`)

POSTs dashboard URL + participant list to Azure Logic App, which sends individual Teams messages via Flow bot.

**When to modify**: Changing notification content, adding new notification channels, adjusting participant filtering.

## Analysis Agents

All 6 agents live in `.claude/agents/`. They run inside the Claude Code CLI (Layer 4). The first 5 run **in parallel** against the raw transcript; the consolidator runs **after all 5 complete**.

| Agent | File | Input | Output | What It Does |
|-------|------|-------|--------|-------------|
| Timeline Analyzer | `timeline-analyzer.md` | `.vtt` | `timeline.json` | Segments, time waste, speaker timeline bars, pacing diagnosis |
| People Analyzer | `people-analyzer.md` | `.vtt` | `people.json` | Per-person value density, role assessment, feedback, team dynamics |
| Insights Generator | `insights-generator.md` | `.vtt` | `insights.json` | Hidden patterns, risk radar, elephants in the room, team health |
| Analytics Generator | `analytics-generator.md` | `.vtt` | `analytics.json` | Meeting cost ($), Gini coefficient, A-F effectiveness grade |
| Longitudinal Analyzer | `longitudinal-analyzer.md` | `.vtt` + history | `longitudinal.json` | Cross-meeting trends, accountability audit, predictions |
| **Consolidator** | `consolidator.md` | All 5 JSONs above | **`consolidated.json`** | Name normalization, conflict resolution, cross-references |

**`consolidated.json` is the single source of truth.** The dashboard is generated from it, never from raw agent outputs.

### When to Modify an Agent

- **Changing what an agent analyzes**: Edit its `.claude/agents/*.md` prompt. Each agent has a single analytical lens — don't make one agent do another's job.
- **Changing output format**: Update the agent's JSON schema in its prompt, then update the consolidator to consume the new format, then update `templates/dashboard.html` placeholders if it affects the dashboard.
- **Adding a new agent**: See [Extending the System](#extending-the-system).

## Skills

Skills in `.claude/skills/` are user-facing workflows that orchestrate the agents and infrastructure.

| Skill | Purpose | When to Modify |
|-------|---------|----------------|
| `process-transcript` | **Primary** — full pipeline from `.vtt` to deployed dashboard | Adding/removing pipeline steps |
| `organize-transcript` | File a `.vtt` into the correct project folder | Changing folder structure conventions |
| `analyze-meeting` | Extract basic insights (summary, action items) | Changing what basic analysis captures |
| `generate-dashboard` | Generate HTML from `consolidated.json` | Changing dashboard generation logic |
| `deploy-dashboard` | Deploy to surge.sh | Changing hosting target |
| `list-projects` | Show all projects and meeting history | Changing project listing format |

## Data Flow

```
projects/{project-name}/
├── {YYYY-MM-DD-HHmmss}/            # Meeting folder (self-contained)
│   ├── transcript.vtt               # Input
│   ├── analysis/
│   │   ├── timeline.json            # Intermediate (agent output)
│   │   ├── people.json              # Intermediate
│   │   ├── insights.json            # Intermediate
│   │   ├── analytics.json           # Intermediate
│   │   ├── longitudinal.json        # Intermediate
│   │   └── consolidated.json        # Definitive — dashboard reads this
│   └── dashboard/
│       └── index.html               # Final deliverable
```

## Best Practices

### Automation

**Decouple webhook from processing.** The webhook must return 200 OK fast. All heavy work flows through: Webhook → Queue → Container App Job. Never add processing logic to the webhook function.

**Filter late, not early.** Meeting filtering happens in `download-transcript.js`, not at the webhook. The webhook stays simple and stateless. Non-matching meetings exit early at minimal cost.

**Keep processing idempotent.** Graph API sends duplicate webhooks. The 10-minute dedup cache in `ProcessTranscriptQueue.js` handles this. If you add new processing steps, ensure they're safe to run twice on the same input.

**Exit gracefully, not loudly.** When there's nothing to do (meeting doesn't match filter, transcript 404, no historical data), exit 0 with a skip result — not exit 1. This avoids false monitoring alerts and unnecessary queue retries.

**Respect the `DEPLOYED_URL` contract.** `processor.js` parses Claude CLI stdout for `DEPLOYED_URL=https://...`. This line must be plain text, on its own line, not wrapped in markdown. Breaking this format silently breaks the notification step.

**Manage Graph subscription lifecycle.** Subscriptions expire every 3 days. `RenewSubscription.js` auto-renews on a timer. If it lapses, new transcripts are silently missed — there's no backfill. Monitor this proactively.

**Remember the Application Access Policy.** Transcript download requires both API permissions **and** a Teams Admin-configured Application Access Policy. A 403 on download almost always means the policy is missing.

### Secrets & Infrastructure

**All secrets go through Key Vault + Managed Identity.** Never hardcode secrets. Use Key Vault references so Azure resolves them at runtime:

```bicep
secrets: [{
  name: 'anthropic-api-key'
  keyVaultUrl: 'https://kv-tiger-staging.vault.azure.net/secrets/AnthropicApiKey'
  identity: managedIdentityResourceId
}]
```

**Keep containers small.** The Container App Job uses 0.5 CPU / 1 GB RAM because the heavy AI work runs on Anthropic's servers. The container just orchestrates API calls. Consumption pricing means zero cost when idle.

### Agent Development

**One agent, one lens.** Each agent has a single analytical responsibility. The timeline analyzer never scores individuals; the people analyzer never creates segment breakdowns. This enables parallel execution and makes debugging straightforward — when data is wrong, you know which agent to fix.

**Always consolidate before generating dashboards.** Without the consolidator: names are inconsistent across tabs, metrics conflict between agents, and cross-references are missing. The consolidator resolves conflicts with explicit rules — use the more granular count for numbers, reconcile assessments by evidence, call out contradictions rather than papering over them.

**Use the template, don't write HTML from scratch.** Dashboards are generated from `templates/dashboard.html` by replacing `{{PLACEHOLDER}}` variables with content from `consolidated.json`. This ensures consistent branding and structure.

### Dashboard Content

**Each insight belongs to exactly one tab.** Don't repeat action items in both Overview and Insights, or discuss speaking time in both Timeline and People tabs:

| Tab | Content |
|---|---|
| Overview | Summary, decisions, action items |
| Timeline | Segments, speaker bars, flow analysis |
| People & Roles | Individual analysis, feedback, team dynamics |
| Insights | Risks, elephants, quotes, team health |
| Analytics | Cost metrics, participation charts, grade |
| Trends | Historical comparison, predictions |

**Score decisively.** Avoid 7/10 for everything — use 6/10 or 8/10. Grade with A/B/C/D/F honestly. Value score colors: 8-10 GREEN, 4-7 YELLOW, 3 and below RED.

**Anonymize clients, not SSW staff.** Replace client/company names with "Client A", "Client B". SSW staff names are fine. Profile photos come from SSW.People.Profiles GitHub repo with initials fallback.

## Extending the System

### Adding a New Agent

1. Create `.claude/agents/{agent-name}.md` with frontmatter:
   ```yaml
   ---
   name: agent-name
   description: One-line description.
   ---
   ```
2. Define what it analyzes that no existing agent covers
3. Specify a JSON output format with example data
4. Update the consolidator prompt to integrate the new agent's output
5. Update `process-transcript` skill to include the new agent in parallel execution
6. If the output affects the dashboard, add a `{{PLACEHOLDER}}` in `templates/dashboard.html`

### Adding a New Skill

1. Create `.claude/skills/{skill-name}/SKILL.md` with frontmatter:
   ```yaml
   ---
   name: skill-name
   description: When to use this skill.
   allowed-tools: Read, Write, Bash, Glob
   ---
   ```
2. Document step-by-step instructions
3. Define input requirements and output format

### Modifying the Dashboard Template

`templates/dashboard.html` uses Tailwind CSS v4, Alpine.js (tabs), Chart.js (charts), and SSW brand colors (Red `#CC4141`, Charcoal `#333333`).

1. Add `{{NEW_PLACEHOLDER}}` in the template
2. Document expected HTML structure in CLAUDE.md
3. Update dashboard generation logic to populate from `consolidated.json`

## Infrastructure Reference

### Azure Resources

| Resource | Purpose |
|---|---|
| Function App (Consumption) | Webhook, queue processor, subscription renewal, cancel |
| Storage Queue (`transcript-notifications`) | Decouples webhook from processing |
| Container Apps Job | Docker container running Claude Code CLI |
| Key Vault | All secrets (API keys, tokens, client secrets) |
| Application Insights | Monitoring and logging |

### Authentication

| Component | Method | Details |
|---|---|---|
| Graph API | Client credentials | `OnlineMeetings.Read.All` + `CallRecords.Read.All` + Application Access Policy |
| Claude CLI | OAuth or API key | OAuth for production, API key for dev |
| Surge.sh | Email + token | `SURGE_EMAIL` + `SURGE_TOKEN` |
| Key Vault | Managed Identity | No credentials in code |
| Webhook | `clientState` | Random string verified per notification |

### Container App Job Sizing

| Setting | Value | Why |
|---|---|---|
| CPU | 0.5 cores | Just orchestrates API calls |
| Memory | 1 GB | Transcript parsing + JSON |
| Timeout | 30 minutes | 6 agents on long meetings |
| Pricing | Consumption | Zero cost when idle |

### CI/CD

Push to `main` triggers `.github/workflows/deploy.yml`:
1. Build Docker image → push to ghcr.io
2. Update Container App Job image reference
3. Deploy Azure Function code

### Monitoring

```kusto
// Webhook notifications
traces | where message contains "[TIGER]" | summarize count() by bin(timestamp, 1h)

// Successful deployments
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "job-tiger-staging"
| where Log_s contains "DEPLOYED_URL"

// Errors
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "job-tiger-staging"
| where Log_s contains "\"level\":\"error\""
```

### Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| Webhook not triggering | Graph subscription expired (3-day TTL) | Check `RenewSubscription.js` timer is running |
| Transcript download 403 | Application Access Policy missing | Teams Admin must configure the policy |
| Claude processing timeout | Meeting too long / agents stuck | Increase Container App Job timeout |
| Dashboard not deploying | Surge credentials expired | Verify `SURGE_EMAIL` + `SURGE_TOKEN` in Key Vault |
| Notifications not sent | Logic App URL misconfigured | Check `LOGIC_APP_URL` env var |
