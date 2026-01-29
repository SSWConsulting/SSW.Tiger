#!/bin/bash
# Entrypoint script for T.I.G.E.R. container
# Sets up Claude CLI authentication and runs the pipeline

set -e

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
        echo "✓ Claude CLI configured with OAuth token"

    elif [ -n "$ANTHROPIC_API_KEY" ]; then
        # API key authentication
        cat > ~/.claude.json <<EOF
{
  "hasCompletedOnboarding": true,
  "defaultModel": "claude-sonnet-4-20250514"
}
EOF
        echo "✓ Claude CLI configured with API key"

    else
        echo "❌ ERROR: No Claude authentication configured"
        echo "   Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY"
        exit 1
    fi
}

# Main pipeline
run_pipeline() {
    # Step 1: Download transcript
    echo "Step 1: Downloading transcript..."
    DOWNLOAD_RESULT=$(node download-transcript.js)

    # Check if skipped
    if echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).skipped" 2>/dev/null | grep -q "true"; then
        REASON=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).reason")
        echo "⏭️  Skipped: $REASON"
        exit 0
    fi

    # Extract values from download result
    TRANSCRIPT_PATH=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).transcriptPath")
    PROJECT_NAME=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).projectName")
    MEETING_SUBJECT=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).meetingSubject")
    PARTICIPANTS_JSON=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.stringify(JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).participants || [])")

    echo "✅ Downloaded: $PROJECT_NAME"

    # Step 2: Process transcript
    echo "Step 2: Processing transcript..."
    PROCESSOR_OUTPUT=$(node processor.js "$TRANSCRIPT_PATH" "$PROJECT_NAME" 2>&1)
    echo "$PROCESSOR_OUTPUT"

    # Extract deployed URL
    DEPLOYED_URL=$(echo "$PROCESSOR_OUTPUT" | grep -oP 'DEPLOYED_URL=\K[^\s"]+' | head -1)

    if [ -z "$DEPLOYED_URL" ]; then
        echo "❌ Failed to extract deployed URL"
        exit 1
    fi

    echo "✅ Deployed: $DEPLOYED_URL"

    # Step 3: Send notification (if configured)
    if [ -n "$LOGIC_APP_URL" ]; then
        echo "Step 3: Sending notification..."

        export DASHBOARD_URL="$DEPLOYED_URL"
        export PROJECT_NAME="$PROJECT_NAME"
        export MEETING_SUBJECT="$MEETING_SUBJECT"
        export PARTICIPANTS_JSON="$PARTICIPANTS_JSON"

        if node send-teams-notification.js; then
            echo "✅ Notification sent"
        else
            echo "⚠️  Notification failed (non-fatal)"
        fi
    else
        echo "ℹ️  Notification skipped (LOGIC_APP_URL not set)"
    fi

    echo "✅ Pipeline completed"
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
