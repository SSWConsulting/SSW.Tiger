# Meeting Processor Usage Guide

## Architecture

```
Docker run
  ↓
wrapper (processor.js)
  ↓
claude CLI (non-interactive, auto-accept)
  ↓
  • Read CLAUDE.md
  • Process transcript
  • Run analysis agents
  • Consolidate results
  • Generate dashboard
  • Deploy to surge
  ↓
Success → /output/index.html + surge URL
  ↓
Failure → error.log → exit 1
```

**Wrapper responsibilities:**
- Input validation
- Directory setup
- Invoke Claude Code CLI
- Verify output exists
- Log results

**Claude Code responsibilities:**
- All AI processing
- Dashboard generation
- Surge deployment

## Quick Start

### 1. Environment Setup

Create `.env` file:

```bash
ANTHROPIC_API_KEY=your_api_key_here
SURGE_EMAIL=your_email@example.com
SURGE_TOKEN=your_surge_token
```

### 2. Run with Docker

```bash
# Build the image
docker-compose build

# Process a transcript
docker-compose run --rm meeting-processor \
  /app/dropzone/meeting.vtt \
  yakshaver
```

### 3. Check Results

**Success:**
- Dashboard: `./output/index.html` (or `./projects/yakshaver/dashboards/{date}/index.html`)
- Analysis: `./projects/yakshaver/analysis/`
- Surge URL: Check Claude CLI output logs

**Failure:**
- Error log: `./error.log`
- Exit code: 1

## How It Works

1. **Wrapper (processor.js):**
   - Validates input transcript
   - Sets up project structure
   - Ensures output directory exists
   - Spawns Claude Code CLI with:
     - `--print` flag for non-interactive output
     - `--permission-mode bypassPermissions` for auto-accept
     - `--add-dir` to grant directory access
   - Monitors output and errors

2. **Claude Code CLI:**
   - Receives simple prompt: "Read CLAUDE.md and process transcript..."
   - Reads CLAUDE.md file itself (not passed as system-prompt)
   - Executes in print mode (non-interactive)
   - Processes transcript following complete workflow:
     - Run analysis agents
     - Consolidate results
     - Generate dashboard
     - **Deploy to surge.sh** (as defined in CLAUDE.md)
   - Writes to `output/index.html`
   - Outputs surge URL in logs

**Why let Claude read CLAUDE.md instead of passing it?**
- Avoids system-prompt token limits
- Follows Claude Code's file-based design
- More maintainable and flexible
- Claude can re-read if needed

## Workflow Details

The Claude Code CLI executes:

1. Read CLAUDE.md instructions
2. Read transcript from specified path
3. Run analysis agents (timeline, people, insights, analytics, longitudinal)
4. Consolidate results
5. Generate HTML dashboard using template
6. Save to `/output/index.html`
7. **Deploy to surge.sh** (using SURGE_LOGIN and SURGE_TOKEN from environment)

## Error Handling

All errors are logged to `error.log` with timestamps:

```
[2026-01-21T10:30:00.000Z] Claude Code CLI failed with exit code 1
Stderr: Error details...
```

The wrapper always exits with code 1 on failure.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | - | Claude API key |
| `SURGE_LOGIN` | Yes* | - | Surge email (for deployment) |
| `SURGE_TOKEN` | Yes* | - | Surge auth token (for deployment) |
| `CLAUDE_CLI` | No | `claude` | Claude CLI command |
| `OUTPUT_DIR` | No | `./output` | Dashboard output directory |

\* Required for surge deployment in Claude Code workflow

## Testing Locally

```bash
# Without Docker
node processor.js ./transcripts/meeting.vtt testproject

# Check output
cat error.log          # If failed
open output/index.html # If successful
```
