#!/bin/bash
# Entrypoint script to set up Claude CLI configuration before running processor

# Create Claude config directory
mkdir -p ~/.claude

# Configure Claude CLI authentication
# Priority: CLAUDE_CODE_OAUTH_TOKEN > ANTHROPIC_API_KEY
if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
    # Using Claude Code OAuth token (from claude setup-token)
    # This works with Claude Pro/Max subscriptions

    # Create .claude.json with onboarding flag (required per GitHub issue #8938)
    cat > ~/.claude.json <<EOF
{
  "hasCompletedOnboarding": true,
  "defaultModel": "claude-opus-4-5-20251101"
}
EOF

    # Also create .credentials.json file (may be required for some Claude CLI versions)
    mkdir -p ~/.claude ~/.config/claude
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

    # Copy to alternate location
    cp ~/.claude/.credentials.json ~/.config/claude/.credentials.json 2>/dev/null || true

    echo "✓ Configured Claude CLI with OAuth token (CLAUDE_CODE_OAUTH_TOKEN)"
    echo "  Token format: ${CLAUDE_CODE_OAUTH_TOKEN:0:20}..."
    echo "  Subscription benefits: Rate limits and priority access enabled"
    echo "  Config files created:"
    echo "    - ~/.claude.json (onboarding flag)"
    echo "    - ~/.claude/.credentials.json (OAuth credentials)"

elif [ -n "$ANTHROPIC_API_KEY" ]; then
    # Check if it's an OAuth token misplaced as API key
    case "$ANTHROPIC_API_KEY" in
        sk-ant-oat*)
            echo "❌ ERROR: OAuth token detected in ANTHROPIC_API_KEY"
            echo "   OAuth tokens should be set as CLAUDE_CODE_OAUTH_TOKEN, not ANTHROPIC_API_KEY"
            echo "   Fix: export CLAUDE_CODE_OAUTH_TOKEN=\"$ANTHROPIC_API_KEY\""
            echo "   Then rebuild: docker-compose build"
            exit 1
            ;;
        sk-ant-api*)
            # Valid API key format
            cat > ~/.claude.json <<EOF
{
  "hasCompletedOnboarding": true,
  "defaultModel": "claude-sonnet-4-20250514"
}
EOF
            echo "✓ Configured Claude CLI with API key (ANTHROPIC_API_KEY)"
            echo "  Key format: ${ANTHROPIC_API_KEY:0:15}..."
            ;;
        *)
            echo "⚠ WARNING: Unrecognized ANTHROPIC_API_KEY format"
            cat > ~/.claude.json <<EOF
{
  "hasCompletedOnboarding": true,
  "defaultModel": "claude-sonnet-4-20250514"
}
EOF
            echo "  Attempting to use provided key..."
            ;;
    esac
else
    echo "❌ ERROR: No authentication configured"
    echo ""
    echo "   Set ONE of the following:"
    echo "   1. CLAUDE_CODE_OAUTH_TOKEN (for Claude Pro/Max subscriptions)"
    echo "      Get token: Run 'claude setup-token' on your local machine"
    echo ""
    echo "   2. ANTHROPIC_API_KEY (for API keys)"
    echo "      Get key from: https://console.anthropic.com/settings/keys"
    echo ""
    exit 1
fi

# Check for test mode
if [ "$1" = "--test-auth" ]; then
    echo "=== Testing Claude Code Authentication ==="
    echo
    echo "1. Environment Variables:"
    echo "   CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN:0:25}..."
    echo
    echo "2. Claude Config File:"
    cat ~/.claude.json 2>&1
    echo
    echo "3. Claude Version:"
    claude --version
    echo
    echo "4. Testing non-interactive mode (--print):"
    echo "Say 'AUTH_SUCCESS' in all caps if you can read this" | timeout 30 claude --print --dangerously-skip-permissions
    exitcode=$?
    echo
    echo "Exit code: $exitcode"
    if [ $exitcode -eq 0 ]; then
        echo "✅ SUCCESS: Claude authentication working!"
    else
        echo "❌ FAILED: Claude authentication failed (exit code: $exitcode)"
    fi
    exit $exitcode
fi

# Check if running in Azure mode (Graph API environment variables set)
if [ -n "$GRAPH_MEETING_ID" ] && [ -n "$GRAPH_TRANSCRIPT_ID" ] && [ -n "$GRAPH_USER_ID" ]; then
    echo "=== Azure Mode ==="

    # Step 1: Download transcript from Graph API
    # download-transcript.js outputs JSON with meeting details and file path
    echo "Step 1: Fetching meeting details and downloading transcript..."
    DOWNLOAD_RESULT=$(node download-transcript.js)
    download_exitcode=$?

    if [ $download_exitcode -ne 0 ]; then
        echo "❌ Download failed (exit code: $download_exitcode)"
        echo "Result: $DOWNLOAD_RESULT"
        exit $download_exitcode
    fi

    # Parse JSON result
    # Check if skipped (meeting doesn't contain "sprint")
    SKIPPED=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).skipped || false")
    if [ "$SKIPPED" = "true" ]; then
        REASON=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).reason || 'unknown'")
        echo "⏭️  Skipped: $REASON"
        exit 0
    fi

    # Extract values from JSON (including notification info)
    TRANSCRIPT_PATH=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).transcriptPath")
    PROJECT_NAME=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).projectName")
    MEETING_DATE=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).meetingDate")
    FILENAME=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).filename")
    MEETING_SUBJECT=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).meetingSubject || ''")
    # Extract participants for individual notifications
    PARTICIPANTS_JSON=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.stringify(JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).participants || [])")

    PARTICIPANT_COUNT=$(echo "$PARTICIPANTS_JSON" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).length")

    echo "✅ Meeting matches filter"
    echo "   Project: $PROJECT_NAME"
    echo "   Date: $MEETING_DATE"
    echo "   File: $FILENAME"
    echo "   Path: $TRANSCRIPT_PATH"
    echo "   Participants: $PARTICIPANT_COUNT"

    # Step 2: Run processor with downloaded transcript
    echo "Step 2: Processing transcript..."
    PROCESSOR_OUTPUT=$(node processor.js "$TRANSCRIPT_PATH" "$PROJECT_NAME" 2>&1)
    processor_exitcode=$?

    echo "$PROCESSOR_OUTPUT"

    if [ $processor_exitcode -ne 0 ]; then
        echo "❌ Processing failed (exit code: $processor_exitcode)"
        exit $processor_exitcode
    fi

    # Step 3: Send Teams notification via Logic App (if configured)
    # Extract DEPLOYED_URL from processor output
    DEPLOYED_URL=$(echo "$PROCESSOR_OUTPUT" | grep -oP 'DEPLOYED_URL=\K[^\s"]+' | head -1)

    if [ -n "$DEPLOYED_URL" ] && [ -n "$LOGIC_APP_URL" ]; then
        echo "Step 3: Sending Teams notification via Logic App..."

        # Export notification environment variables
        export DASHBOARD_URL="$DEPLOYED_URL"
        export MEETING_SUBJECT="$MEETING_SUBJECT"
        export PROJECT_NAME="$PROJECT_NAME"
        export PARTICIPANTS_JSON="$PARTICIPANTS_JSON"

        node send-teams-notification.js
        teams_exitcode=$?

        if [ $teams_exitcode -eq 0 ]; then
            echo "✅ Teams notification sent to $PARTICIPANT_COUNT participants"
        else
            echo "⚠️  Teams notification failed (exit code: $teams_exitcode)"
            # Don't fail the whole pipeline for notification failure
        fi
    else
        echo "ℹ️  Teams notification skipped (LOGIC_APP_URL not configured or no deployed URL)"
    fi

    echo "✅ Pipeline completed successfully"
    exit 0
else
    # Local mode: pass arguments directly to processor
    node processor.js "$@"
    exit $?
fi
