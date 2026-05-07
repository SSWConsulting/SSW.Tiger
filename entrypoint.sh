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

# Background cancellation checker
# Polls CHECK_CANCELLATION_URL every 15 seconds and exits if cancelled
CANCEL_CHECKER_PID=""
CANCELLED_FILE="/tmp/tiger-cancelled"
CANCELLED_NOTIFIED_FILE="/tmp/tiger-cancelled-notified"

send_cancelled_notification() {
    if [ -f "$CANCELLED_NOTIFIED_FILE" ]; then
        return
    fi

    if [ -z "$LOGIC_APP_URL" ] || [ -z "$PARTICIPANTS_JSON" ]; then
        return
    fi

    touch "$CANCELLED_NOTIFIED_FILE"
    NOTIFICATION_TYPE="cancelled" node processor/sendNotification.js >/dev/null || true
}

is_user_cancelled() {
    if [ -f "$CANCELLED_FILE" ]; then
        echo "true"
        return
    fi

    if [ -z "$CHECK_CANCELLATION_URL" ]; then
        echo "false"
        return
    fi

    local cancel_check
    cancel_check=$(curl -s --max-time 3 "$CHECK_CANCELLATION_URL" 2>/dev/null || echo '{"cancelled":false}')
    echo "$cancel_check" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).cancelled" 2>/dev/null || echo "false"
}

handle_termination() {
    local signal_name="$1"
    local exit_code="$2"

    if [ "$signal_name" = "TERM" ] && [ "$(is_user_cancelled)" = "true" ]; then
        log "info" "Cancellation signal received, exiting successfully"
        send_cancelled_notification
        exit 0
    fi

    log "warn" "$signal_name signal received"
    exit "$exit_code"
}

start_cancel_checker() {
    if [ -z "$CHECK_CANCELLATION_URL" ]; then
        return
    fi

    (
        while true; do
            sleep 15
            CANCEL_CHECK=$(curl -s --max-time 3 "$CHECK_CANCELLATION_URL" 2>/dev/null || echo '{"cancelled":false}')
            IS_CANCELLED=$(echo "$CANCEL_CHECK" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).cancelled" 2>/dev/null || echo "false")
            if [ "$IS_CANCELLED" = "true" ]; then
                log "info" "Job cancelled by user, terminating..."
                touch "$CANCELLED_FILE"
                # Kill the current process group so any foreground Node/Claude child exits too.
                # The main shell traps this and exits 0 for user-requested cancellation.
                kill -TERM 0 2>/dev/null || true
                exit 0
            fi
        done
    ) &
    CANCEL_CHECKER_PID=$!
}

stop_cancel_checker() {
    if [ -n "$CANCEL_CHECKER_PID" ]; then
        kill $CANCEL_CHECKER_PID 2>/dev/null || true
    fi
}

# Cleanup on exit
trap stop_cancel_checker EXIT
trap 'handle_termination TERM 143' TERM
trap 'handle_termination INT 130' INT

# Setup Claude CLI authentication
setup_claude_auth() {
    mkdir -p ~/.claude ~/.config/claude

    if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
        # OAuth token authentication - the CLI reads CLAUDE_CODE_OAUTH_TOKEN env var directly
        log "info" "Using OAuth token authentication"
        cat > ~/.claude.json <<EOF
{
  "hasCompletedOnboarding": true,
  "defaultModel": "claude-opus-4-5-20251101"
}
EOF

    elif [ -n "$ANTHROPIC_API_KEY" ]; then
        # API key authentication - the CLI reads ANTHROPIC_API_KEY env var directly
        log "info" "Using API key authentication"
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
        node processor/sendNotification.js >/dev/null || true
    fi
}

# Main pipeline
run_pipeline() {
    # Start background cancellation checker (polls every 15s)
    start_cancel_checker

    # Step 1: Download transcript
    # stderr flows through for real-time logs, stdout captured (JSON result)
    set +e
    DOWNLOAD_RESULT=$(node processor/downloadTranscript.js)
    DOWNLOAD_EXIT_CODE=$?
    set -e

    if [ "$DOWNLOAD_EXIT_CODE" -ne 0 ]; then
        # Try to extract error message from JSON output
        ERROR_MSG=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).message" 2>/dev/null || echo "Unknown error")
        # Log with meeting identifiers for debugging
        log "error" "Failed to download transcript [user=$GRAPH_USER_ID, meeting=$GRAPH_MEETING_ID]: $ERROR_MSG"
        exit 1
    fi

    # Check if skipped
    if echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).skipped" 2>/dev/null | grep -q "true"; then
        REASON=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).reason")
        SKIP_REASON=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).skipReason || ''" 2>/dev/null || echo "")
        log "info" "Skipped: $REASON"

        # If skipped due to subject filter, send a "skipped" notification so users can trigger manually
        if [ "$SKIP_REASON" = "subjectFilter" ] && [ -n "$LOGIC_APP_URL" ]; then
            MEETING_SUBJECT=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).meetingSubject || ''" 2>/dev/null)
            PARTICIPANTS_JSON=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.stringify(JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).participants || [])" 2>/dev/null)
            JOIN_WEB_URL=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).joinWebUrl || ''" 2>/dev/null)
            MEETING_DURATION=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).meetingDuration || ''" 2>/dev/null)

            # Build trigger URL from the cancel URL base (same Azure Function host)
            TRIGGER_URL=""
            if [ -n "$CANCEL_URL" ] && [ -n "$JOIN_WEB_URL" ]; then
                FUNCTION_HOST=$(echo "$CANCEL_URL" | sed 's|/api/.*||')
                ENCODED_JOIN_URL=$(node -pe "encodeURIComponent('$JOIN_WEB_URL')" 2>/dev/null || echo "")
                if [ -n "$ENCODED_JOIN_URL" ]; then
                    TRIGGER_URL="${FUNCTION_HOST}/api/TriggerProcessing?joinUrl=${ENCODED_JOIN_URL}"
                fi
            fi

            export MEETING_SUBJECT="$MEETING_SUBJECT"
            export PARTICIPANTS_JSON="$PARTICIPANTS_JSON"
            export NOTIFICATION_TYPE="skipped"
            export TRIGGER_URL="$TRIGGER_URL"
            export MEETING_DURATION="$MEETING_DURATION"
            node processor/sendNotification.js >/dev/null || log "warn" "Skipped notification failed"
        fi

        exit 0
    fi

    # Extract values from download result
    TRANSCRIPT_PATH=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).transcriptPath")
    PROJECT_SLUG=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).projectName")
    PROJECT_NAME=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).displayName")
    MEETING_SUBJECT=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).meetingSubject")
    PARTICIPANTS_JSON=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.stringify(JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).participants || [])")
    MEETING_DURATION=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).meetingDuration || ''")
    INVITEES_JSON=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.stringify(JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).invitees || [])")
    VTT_INFO_JSON=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.stringify(JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).vttInfo || {})")

    # Export variables for notifications
    export PROJECT_NAME="$PROJECT_NAME"
    export MEETING_SUBJECT="$MEETING_SUBJECT"
    export PARTICIPANTS_JSON="$PARTICIPANTS_JSON"
    export MEETING_DURATION="$MEETING_DURATION"
    export INVITEES_JSON="$INVITEES_JSON"
    export VTT_INFO_JSON="$VTT_INFO_JSON"

    # Step 2: Send "started" notification (if configured)
    # Includes cancel URL if available, allowing users to cancel processing
    if [ -n "$LOGIC_APP_URL" ]; then
        export NOTIFICATION_TYPE="started"
        # CANCEL_URL and JOB_EXECUTION_ID are passed from Azure Function
        # They will be included in the notification payload for the Cancel button
        node processor/sendNotification.js >/dev/null || log "warn" "Started notification failed"
    fi

    # Step 3: Process transcript
    # stderr = logs (real-time), stdout = machine output (captured)
    log "info" "Processing transcript with Claude..."

    set +e
    # stderr flows through for real-time display
    # stdout (only DEPLOYED_URL) captured to variable
    PROCESSOR_STDOUT=$(node processor/index.js "$TRANSCRIPT_PATH" "$PROJECT_SLUG")
    PROCESSOR_EXIT_CODE=$?
    set -e

    if [ "$PROCESSOR_EXIT_CODE" -ne 0 ]; then
        # Include project/meeting info and any output from processor in error log
        if [ -n "$PROCESSOR_STDOUT" ]; then
            log "error" "Claude processing failed [project=$PROJECT_NAME, meeting=$MEETING_SUBJECT]: $PROCESSOR_STDOUT"
        else
            log "error" "Claude processing failed [project=$PROJECT_NAME, meeting=$MEETING_SUBJECT] (no output)"
        fi
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
        node processor/sendNotification.js >/dev/null || log "warn" "Completed notification failed"
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
    node processor/index.js "$@"
fi
