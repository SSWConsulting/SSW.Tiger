# 🐳 Docker Deployment Guide

## Prerequisites

- Docker installed ([Get Docker](https://docs.docker.com/get-docker/))
- Docker Compose installed (included with Docker Desktop)
- Authentication credentials (choose one):
  - **Option 1:** Anthropic API Key ([Get one here](https://console.anthropic.com/))
  - **Option 2:** Claude Subscription Plan (e.g., SSW Claude subscription or similar)

## Quick Start

### 1. Set Up Environment

#### Option A: Using Standard API Key

Create a `.env` file in the project root:

```bash
ANTHROPIC_API_KEY=your-api-key-here
```

Or export it directly:

```bash
# Linux/Mac
export ANTHROPIC_API_KEY=your-api-key-here

# Windows PowerShell
$env:ANTHROPIC_API_KEY="your-api-key-here"
```

#### Option B: Using Subscription Plan

Create a `.env` file with subscription credentials:

```bash
CLAUDE_SUBSCRIPTION=true
CLAUDE_SUBSCRIPTION_TOKEN=your-subscription-token-here
CLAUDE_ENDPOINT=https://your-claude-endpoint.com
```

Or export them:

```bash
# Linux/Mac
export CLAUDE_SUBSCRIPTION=true
export CLAUDE_SUBSCRIPTION_TOKEN=your-token-here
export CLAUDE_ENDPOINT=https://your-endpoint.com

# Windows PowerShell
$env:CLAUDE_SUBSCRIPTION="true"
$env:CLAUDE_SUBSCRIPTION_TOKEN="your-token-here"
$env:CLAUDE_ENDPOINT="https://your-endpoint.com"
```

### 2. Build the Container

```bash
docker-compose build
```

### 3. Process a Transcript

Place your `.vtt` transcript file in the `dropzone/` directory, then run:

```bash
docker-compose run --rm meeting-processor /app/dropzone/your-transcript.vtt project-name
```

**Example:**

```bash
docker-compose run --rm meeting-processor /app/dropzone/sprint-review.vtt yakshaver
```

## Usage Patterns

### One-off Processing

Process a single transcript and exit:

```bash
docker-compose run --rm meeting-processor \
  /app/dropzone/meeting.vtt \
  myproject
```

### Using Absolute Paths

You can also mount external directories:

```bash
docker run --rm \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -v /path/to/transcripts:/transcripts:ro \
  -v ./projects:/app/projects \
  meeting-summariser:latest \
  /transcripts/meeting.vtt \
  projectname
```

### Batch Processing Multiple Transcripts

Create a simple shell script:

```bash
#!/bin/bash
for file in dropzone/*.vtt; do
  name=$(basename "$file" .vtt)
  echo "Processing $name..."
  docker-compose run --rm meeting-processor "/app/dropzone/$(basename $file)" "$name"
done
```

## Output

Results are saved to `projects/<project-name>/`:

```
projects/
  └── yakshaver/
      ├── transcripts/
      │   └── yakshaver.vtt
      ├── analysis/
      │   ├── timeline.json
      │   ├── people.json
      │   ├── insights.json
      │   ├── analytics.json
      │   ├── longitudinal.json
      │   └── consolidated.json
      └── dashboards/
          └── 2026-01-21/
              └── index.html
```

## Exit Codes

The processor returns clear exit codes:

- `0` = Success
- `1` = Error (check logs for details)

**Example with error handling:**

```bash
if docker-compose run --rm meeting-processor /app/dropzone/meeting.vtt myproject; then
  echo "✓ Processing succeeded"
else
  echo "✗ Processing failed with exit code $?"
fi
```

## Logs

All logs are written to stdout in JSON format for easy parsing:

```json
{
  "timestamp": "2026-01-21T10:30:00.000Z",
  "level": "INFO",
  "message": "Processing complete",
  "data": {
    "project": "yakshaver",
    "dashboard": "/app/projects/yakshaver/dashboards/2026-01-21/index.html"
  }
}
```

**View logs in real-time:**

```bash
docker-compose run meeting-processor /app/dropzone/meeting.vtt myproject | jq
```

## Troubleshooting

### Authentication Issues

**For Standard API Key:**

If you get "ANTHROPIC_API_KEY not set" error:

```bash
# Verify your key is set
echo $ANTHROPIC_API_KEY

# Set it in .env file or export it
export ANTHROPIC_API_KEY=your-key-here
```

**For Subscription Plan:**

If you get "CLAUDE_SUBSCRIPTION_TOKEN not set" error:

```bash
# Verify your credentials are set
echo $CLAUDE_SUBSCRIPTION
echo $CLAUDE_SUBSCRIPTION_TOKEN
echo $CLAUDE_ENDPOINT

# Set them in .env file or export them
export CLAUDE_SUBSCRIPTION=true
export CLAUDE_SUBSCRIPTION_TOKEN=your-token-here
export CLAUDE_ENDPOINT=https://your-endpoint.com
```

### Permission Issues

If you get permission errors on Linux:

```bash
# Fix ownership of output directories
sudo chown -R $USER:$USER projects/
```

### Container Won't Build

```bash
# Clean rebuild
docker-compose build --no-cache
```

### View Container Logs

```bash
docker-compose logs -f meeting-processor
```

## Advanced Configuration

### Custom Resource Limits

Edit `docker-compose.yml` to adjust CPU/memory:

```yaml
deploy:
  resources:
    limits:
      cpus: '4.0'
      memory: 4G
```

### Using Different Agent Configurations

Mount custom agent files:

```bash
docker run --rm \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -v ./custom-agents:/app/.claude/agents:ro \
  -v ./projects:/app/projects \
  meeting-summariser:latest \
  /app/dropzone/meeting.vtt \
  projectname
```

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Process Transcript
on:
  workflow_dispatch:
    inputs:
      transcript_path:
        description: 'Path to transcript file'
        required: true
      project_name:
        description: 'Project name'
        required: true

jobs:
  process:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Build container
        run: docker-compose build
      
      - name: Process transcript
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          docker-compose run --rm meeting-processor \
            ${{ github.event.inputs.transcript_path }} \
            ${{ github.event.inputs.project_name }}
      
      - name: Upload results
        uses: actions/upload-artifact@v3
        with:
          name: dashboard
          path: projects/${{ github.event.inputs.project_name }}/dashboards/
```

## Automated Processing (Future)

For automated processing triggered by file arrival:

1. Use a file watcher service (e.g., `inotify` on Linux)
2. Trigger the container when new `.vtt` files appear
3. Example with `inotifywait`:

```bash
#!/bin/bash
inotifywait -m dropzone/ -e create -e moved_to |
  while read path action file; do
    if [[ "$file" =~ \.vtt$ ]]; then
      name="${file%.vtt}"
      echo "New transcript detected: $file"
      docker-compose run --rm meeting-processor "/app/dropzone/$file" "$name"
    fi
  done
```

## Support

For issues or questions:
1. Check container logs: `docker-compose logs`
2. Verify API key is set correctly
3. Ensure transcript file is valid VTT format
4. Check exit code for error indication
