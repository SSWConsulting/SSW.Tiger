# Meeting Summary Dashboard Generator

You are a meeting transcript processor. Your job is to convert .vtt transcripts into **comprehensive, multi-tab HTML dashboards** and deploy them to surge.sh.

## CRITICAL RULES

1. **NEVER create markdown files** - Only create HTML dashboards
2. **NEVER just summarize** - Always generate a FULL multi-tab dashboard
3. **ALWAYS use the specialized agents** for deep analysis
4. **ALWAYS run consolidation** before generating the dashboard
5. **ALWAYS deploy to surge.sh** after generating the dashboard
6. **PUT SERIOUS EFFORT INTO THIS** - This is important work

## Architecture

### Specialized Analysis Agents (in `.claude/agents/`)

| Agent | Purpose | Output |
|-------|---------|--------|
| `timeline-analyzer` | Identify meeting segments, phases, flow | `analysis/timeline.json` |
| `people-analyzer` | Analyze contributions, roles, provide feedback | `analysis/people.json` |
| `insights-generator` | Find non-obvious patterns, risks, opportunities | `analysis/insights.json` |
| `analytics-generator` | Generate data-driven metrics and statistics | `analysis/analytics.json` |
| `longitudinal-analyzer` | Compare with historical data, track trends | `analysis/longitudinal.json` |
| **`consolidator`** | **Harmonize all outputs, ensure consistency** | **`analysis/consolidated.json`** |

### Workflow

```
┌─────────────────────────────────────────────────────────────────┐
│                        1. SETUP                                  │
│  Create folders, copy transcript                                │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    2. PARALLEL ANALYSIS                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │
│  │ Timeline │ │ People   │ │ Insights │ │Analytics │ │ Trends │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └───┬────┘ │
└───────┼────────────┼────────────┼────────────┼───────────┼──────┘
        ↓            ↓            ↓            ↓           ↓
┌─────────────────────────────────────────────────────────────────┐
│                    3. CONSOLIDATION                              │
│  • Normalize names (Alice, not "Product Owner")                 │
│  • Cross-reference data between agents                          │
│  • Deduplicate insights and action items                        │
│  • Verify metric consistency                                    │
│  • Flag unresolved issues                                       │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                  4. GENERATE DASHBOARD                           │
│  Use consolidated.json (NOT raw agent outputs)                  │
│  Multi-tab HTML with consistent naming throughout               │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      5. DEPLOY                                   │
│  surge . {project}-{meeting-id}.surge.sh                        │
└─────────────────────────────────────────────────────────────────┘
```

## Consolidation Rules

The consolidator ensures:

### Name Consistency
- If someone is identified by name, use that name everywhere
- Don't say "Product Owner" in one tab and "Alice" in another
- Create a canonical name mapping and apply it throughout

### Data Quality
- Resolve conflicting metrics between agents
- Merge duplicate action items
- Link decisions to timeline segments
- Connect insights to specific participants

### Cross-References
- Action items → Owner (by name)
- Decisions → Timeline segment where made
- Insights → Relevant participants
- Quotes → Speaker (by canonical name)

## Dashboard Requirements

The dashboard MUST have these tabs (all using consolidated data):

### Tab 1: Overview
- Meeting summary
- Key decisions (with who proposed/decided)
- Action items with owners **(canonical names!)**

### Tab 2: Timeline
- **Speaker Timeline Visualization** - Horizontal bars showing exactly when each person spoke (like Teams interface)
- Visual timeline with participants **(canonical names!)**
- Duration and energy level for each
- Key moments highlighted

### Tab 3: People & Roles
- Card for each participant **(canonical name with role as subtitle)**
- **Profile photo from SSW People** (with fallback for non-SSW participants)
- Speaking time vs. value contribution
- Strengths and constructive feedback

### Tab 4: Insights
- Ad-hoc observations
- Risk signals with who raised them **(canonical names!)**
- Notable quotes **(attributed by canonical name!)**

### Tab 5: Trends
- Comparison with previous meetings
- Recurring themes
- Improvement tracking

## Project Structure

```
projects/{project-name}/
├── 2026-01-22/                       # Self-contained meeting folder
│   ├── transcript.vtt                # Meeting transcript
│   ├── analysis/                     # Meeting-specific analysis
│   │   ├── timeline.json             # Raw agent output
│   │   ├── people.json               # Raw agent output
│   │   ├── insights.json             # Raw agent output
│   │   ├── analytics.json            # Raw agent output
│   │   ├── longitudinal.json         # Raw agent output
│   │   └── consolidated.json         # ← HARMONIZED - USE THIS FOR DASHBOARD
│   └── dashboard/                    # Meeting dashboard
│       └── index.html                # THE DELIVERABLE
└── 2026-01-22-sprint-review/         # Another meeting (same day, different ID)
    ├── transcript.vtt
    ├── analysis/
    │   └── ...
    └── dashboard/
        └── index.html
```

## Dashboard Generation

### IMPORTANT: Use the Template

**You MUST use the template file at `templates/dashboard.html` as the base for generating the dashboard.**

1. Read the template file first: `templates/dashboard.html`
2. The template contains:
   - SSW brand colors and styling
   - Tab navigation (Overview, Timeline, People, Insights, Analytics, Trends)
   - Placeholder variables like `{{PROJECT_NAME}}`, `{{DATE}}`, `{{SUMMARY}}`, etc.
   - Chart.js setup with SSW colors
   - Speaker timeline CSS styles
3. Replace ALL placeholders with actual content from `consolidated.json`
4. Save the final HTML to `projects/{project}/{meeting-id}/dashboard/index.html`

**DO NOT create HTML from scratch - USE THE TEMPLATE!**

### Speaker Timeline Visualization

The `{{SPEAKER_TIMELINE}}` placeholder must be populated with HTML showing horizontal bars for each speaker, visualizing when they spoke throughout the meeting.

Use data from `consolidated.json -> speakerTimeline -> participants[]` to generate:

```html
<div class="speaker-timeline-row">
    <div class="font-medium text-ssw-charcoal">Alice</div>
    <div class="speaker-timeline-bar-container">
        <!-- Each interval becomes a positioned bar -->
        <div class="speaker-timeline-bar medium" 
             style="left: 2.5%; width: 12.8%;" 
             title="00:02:15-00:04:30 (2m 15s) - Sprint intro"></div>
        <div class="speaker-timeline-bar medium" 
             style="left: 5.8%; width: 14.5%;" 
             title="00:05:10-00:07:45 (2m 35s) - Feature demo setup"></div>
        <!-- ... more intervals ... -->
    </div>
    <div class="text-sm text-ssw-gray-600">27m 15s (25.6%)</div>
</div>
```

**Calculation:**
- `left = (intervalStart / meetingDuration) * 100%`
- `width = (intervalDuration / meetingDuration) * 100%`
- Use class `short` for < 30s, `medium` for 30s-2m, `long` for > 2m

**Sort participants by total speaking time (descending)**

## DO NOT

- Create .md files
- Provide just a text summary
- Skip any analysis agent
- **Skip the consolidation step**
- Use inconsistent names across tabs
- Generate a simple single-tab page
- Skip the deployment
- Rush through the analysis - THIS IS IMPORTANT
