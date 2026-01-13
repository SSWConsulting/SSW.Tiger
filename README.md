# Meeting Summary Dashboard Generator

<div align="center">

![SSW](https://img.shields.io/badge/SSW-Brand%20Styled-CC4141?style=for-the-badge)
![Claude](https://img.shields.io/badge/Claude-Powered-333333?style=for-the-badge)

**Transform meeting transcripts into brutally honest, insight-rich dashboards**

</div>

---

## 🎯 What This Does

Takes `.vtt` transcript files from Microsoft Teams meetings and generates **comprehensive multi-tab HTML dashboards** with:

- 📋 Executive summaries and action items
- ⏱️ Timeline analysis with time waste identification
- 👥 Participant analysis with honest feedback
- 💡 Hidden insights and elephants in the room
- 📊 Forensic analytics with meeting cost calculations
- 📈 Longitudinal trends and accountability tracking

## 🔥 Critical Analysis Philosophy

This isn't a feel-good summarizer. The analysis agents are designed to:

- **Find what's NOT being said** (avoidance patterns)
- **Quantify waste** (time and money)
- **Expose dysfunction** (recurring issues, accountability failures)
- **Make predictions** (where problems are heading)
- **Deliver uncomfortable truths** (that people need to hear)

## 🏗️ Architecture

### Specialized Analysis Agents

| Agent | Purpose |
|-------|---------|
| `timeline-analyzer` | Forensic time analysis, identifies waste and what was avoided |
| `people-analyzer` | Value-per-minute scoring, power dynamics, honest feedback |
| `insights-generator` | Elephants in the room, risk radar, buried opportunities |
| `analytics-generator` | Meeting cost in $, dysfunction metrics, A-F grading |
| `longitudinal-analyzer` | Accountability audit, recurring issue tracking, predictions |
| `consolidator` | Harmonizes all outputs with consistent naming |

### Workflow

```
Transcript (.vtt)
       ↓
┌──────────────────────────────────────────────────┐
│  PARALLEL ANALYSIS (5 specialized agents)        │
└──────────────────────────────────────────────────┘
       ↓
┌──────────────────────────────────────────────────┐
│  CONSOLIDATION                                   │
│  • Name normalization                            │
│  • Cross-reference validation                    │
│  • Insight amplification                         │
└──────────────────────────────────────────────────┘
       ↓
┌──────────────────────────────────────────────────┐
│  DASHBOARD GENERATION (SSW branded)              │
└──────────────────────────────────────────────────┘
       ↓
    Deploy to surge.sh
```

## 📁 Project Structure

```
MeetingSummary/
├── .claude/
│   ├── agents/                    # Analysis agents (Critical Edition)
│   │   ├── timeline-analyzer.md
│   │   ├── people-analyzer.md
│   │   ├── insights-generator.md
│   │   ├── analytics-generator.md
│   │   ├── longitudinal-analyzer.md
│   │   └── consolidator.md
│   └── skills/                    # Claude skills (auto-triggered)
│       ├── organize-transcript/
│       ├── analyze-meeting/
│       ├── generate-dashboard/
│       ├── deploy-dashboard/
│       └── list-projects/
├── templates/
│   └── dashboard.html             # SSW-branded dashboard template
├── projects/                      # .gitignored - contains sensitive data
│   └── {project-name}/
│       ├── transcripts/           # .vtt files
│       ├── analysis/              # Agent outputs (JSON)
│       └── dashboards/            # Generated HTML
├── CLAUDE.md                      # Claude instructions
└── README.md
```

## 🚀 Quick Start

### Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/claude/docs/claude-code)
- [Node.js](https://nodejs.org/) + surge.sh: `npm install -g surge`

### Usage

```bash
cd c:\DataCalumSimpson\MeetingSummary
claude
```

Then talk naturally:

```
"Here's the weekly standup for project-alpha" + attach your .vtt file
```

Or process an existing transcript:

```
"Process the yakshaver transcript from today"
```

## 📥 Getting Transcripts from Teams

1. Open **Teams Calendar** → select the meeting
2. Go to **Recordings & Transcripts** tab
3. Download as `.vtt`
4. Place in `projects/{project}/transcripts/`

Transcripts are stored in:
- **Private meetings**: OneDrive → `Recordings` folder
- **Channel meetings**: SharePoint → Team site → `Recordings` folder

## 📊 Dashboard Tabs

| Tab | Content |
|-----|---------|
| **Overview** | Summary, decisions, action items, hard truths |
| **Timeline** | Segments, time waste analysis, flow analysis |
| **People** | Participant cards, team dynamics, power dynamics |
| **Insights** | Team health, elephants, risk radar, notable moments |
| **Analytics** | Cost analysis, charts, metrics, dysfunction metrics |
| **Trends** | Trajectory, accountability audit, recurring issues, predictions |

## 🎨 SSW Brand Styling

The dashboard follows [SSW design guidelines](https://www.ssw.com.au/rules/set-design-guidelines/):

- **Primary Red**: `#CC4141`
- **Charcoal**: `#333333`
- **Font**: Inter (web) / Helvetica Neue (print)
- **Logo motif**: Four colored squares

## 📈 What Gets Analyzed

### Standard Extraction
- Meeting summary and key decisions
- Action items with owners
- Timeline segments with energy levels

### Critical Analysis (New)
- **Time waste** quantification (minutes + dollars)
- **Participation inequality** (Gini coefficient)
- **Value-per-minute** scoring (not just airtime)
- **Power dynamics** (interruptions, who talks over whom)
- **Elephants in the room** (what's being avoided)
- **Risk radar** (technical, people, process risks)
- **Recurring issues** (the graveyard of unresolved problems)
- **Predictions** (where problems are heading)
- **Meeting grades** (A/B/C/D/F with justification)

## 🔧 Configuration

### `CLAUDE.md`
Contains instructions for Claude on how to process transcripts and generate dashboards.

## 📝 Example Output

After processing a transcript, you'll get:

1. **Analysis files** in `projects/{project}/analysis/`:
   - `timeline.json`
   - `people.json`
   - `insights.json`
   - `analytics.json`
   - `longitudinal.json`
   - `consolidated.json` ← Used for dashboard

2. **Dashboard** in `projects/{project}/dashboards/{date}/index.html`

3. **Deployment** at `https://{project}-{date}.surge.sh`

## 🤝 Contributing

The agents are in `.claude/agents/`. Each agent has:
- A specific analysis focus
- Output format specification
- "Hard truths" philosophy

Feel free to tune the agents for your team's needs!

## 📜 License

Internal SSW tool.

---

<div align="center">

**Built with Claude** | **Styled with SSW Brand Guidelines**

</div>
