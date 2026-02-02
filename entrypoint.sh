#!/bin/bash
# Entrypoint script for T.I.G.E.R. container
# Sets up Claude CLI authentication and runs the pipeline

set -e

# JSON logging function (consistent with JS files)
# All logs go to stderr to keep stdout clean
log() {
    local level=$(echo "$1" | tr '[:upper:]' '[:lower:]')
    local message="$2"
    echo "{\"level\":\"$level\",\"message\":\"$message\"}" >&2
}

# Setup Claude CLI authentication
setup_claude_auth() {
    mkdir -p ~/.claude ~/.config/claude

    if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
        # OAuth token authentication
        cat > ~/.claude.json <<EOF
{
  "hasCompletedOnboarding": true,
  "defaultModel": "claude-opus-4-5-20251101"
}
EOF
        cat > ~/.claude/.credentials.json <<EOF
{
  "claudeAiOauth": {
    "accessToken": "$CLAUDE_CODE_OAUTH_TOKEN",
    "refreshToken": "$CLAUDE_CODE_OAUTH_TOKEN",
    "expiresAt": 9999999999999,
    "scopes": ["user:inference", "user:profile"]
  }
}
EOF
        cp ~/.claude/.credentials.json ~/.config/claude/.credentials.json 2>/dev/null || true

    elif [ -n "$ANTHROPIC_API_KEY" ]; then
        # API key authentication
        cat > ~/.claude.json <<EOF
{
  "hasCompletedOnboarding": true,
  "defaultModel": "claude-sonnet-4-20250514"
}
EOF

    else
        log "error" "No Claude auth configured"
        exit 1
    fi
}

# Send failure notification
send_failure_notification() {
    if [ -n "$LOGIC_APP_URL" ] && [ -n "$PARTICIPANTS_JSON" ]; then
        export NOTIFICATION_TYPE="failed"
        node send-teams-notification.js >/dev/null || true
    fi
}

# Main pipeline
run_pipeline() {
    # Step 1: Download transcript
    # Note: stderr goes to console (logs), stdout captured (JSON result)
    # Capture stderr separately for error reporting
    DOWNLOAD_STDERR=$(mktemp)
    if ! DOWNLOAD_RESULT=$(node download-transcript.js 2>"$DOWNLOAD_STDERR"); then
        log "error" "Failed to download transcript"
        cat "$DOWNLOAD_STDERR" >&2
        rm -f "$DOWNLOAD_STDERR"
        exit 1
    fi
    # Show logs from stderr (info messages)
    cat "$DOWNLOAD_STDERR" >&2
    rm -f "$DOWNLOAD_STDERR"

    # Check if skipped
    if echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).skipped" 2>/dev/null | grep -q "true"; then
        REASON=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).reason")
        log "info" "Skipped: $REASON"
        exit 0
    fi

    # Extract values from download result
    TRANSCRIPT_PATH=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).transcriptPath")
    PROJECT_NAME=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).projectName")
    MEETING_SUBJECT=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).meetingSubject")
    PARTICIPANTS_JSON=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.stringify(JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).participants || [])")

    # Export variables for notifications
    export PROJECT_NAME="$PROJECT_NAME"
    export MEETING_SUBJECT="$MEETING_SUBJECT"
    export PARTICIPANTS_JSON="$PARTICIPANTS_JSON"

    # Step 2: Send "started" notification (if configured)
    if [ -n "$LOGIC_APP_URL" ]; then
        export NOTIFICATION_TYPE="started"
        node send-teams-notification.js >/dev/null || log "warn" "Started notification failed"
    fi

    # Step 3: Process transcript
    # stderr = logs (real-time), stdout = machine output (captured)
    log "info" "Processing transcript with Claude..."

    set +e
    # stderr flows through for real-time display
    # stdout (only DEPLOYED_URL) captured to variable
    PROCESSOR_STDOUT=$(node processor.js "$TRANSCRIPT_PATH" "$PROJECT_NAME")
    PROCESSOR_EXIT_CODE=$?
    set -e

    if [ "$PROCESSOR_EXIT_CODE" -ne 0 ]; then
        log "error" "Claude processing failed"
        send_failure_notification
        exit 1
    fi

    # Extract deployed URL from stdout (minimal data)
    DEPLOYED_URL=$(echo "$PROCESSOR_STDOUT" | grep -oP 'DEPLOYED_URL=\K[^\s"]+' | head -1)

    if [ -z "$DEPLOYED_URL" ]; then
        log "error" "Failed to extract deployed URL"
        send_failure_notification
        exit 1
    fi

    log "info" "Deployed: $DEPLOYED_URL"

    # Step 4: Send "completed" notification (if configured)
    if [ -n "$LOGIC_APP_URL" ]; then
        log "info" "Sending completed notification..."
        export NOTIFICATION_TYPE="completed"
        export DASHBOARD_URL="$DEPLOYED_URL"
        node send-teams-notification.js >/dev/null || log "warn" "Completed notification failed"
    fi
}

# Check mode
if [ -n "$GRAPH_MEETING_ID" ] && [ -n "$GRAPH_TRANSCRIPT_ID" ] && [ -n "$GRAPH_USER_ID" ]; then
    # Azure mode: full pipeline
    setup_claude_auth
    run_pipeline
else
    # Local mode: direct processor call
    setup_claude_auth
    node processor.js "$@"
fi
