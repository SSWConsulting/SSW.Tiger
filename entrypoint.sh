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

# Update a portal submission's history status (upload path only; best effort).
# $1 = status (processing|completed|failed), $2 = dashboard URL (completed only).
update_submission_status() {
    if [ "$TRANSCRIPT_SOURCE_TYPE" = "uploadedTranscript" ]; then
        SUBMISSION_STATUS="$1" SUBMISSION_DASHBOARD_URL="$2" node processor/updateSubmissionStatus.js || true
    fi
}

# Send failure notification. Uploaded transcripts have no Logic App notification;
# instead their history record is marked "failed" so the portal list reflects it.
send_failure_notification() {
    if [ "$TRANSCRIPT_SOURCE_TYPE" = "uploadedTranscript" ]; then
        update_submission_status "failed"
    elif [ -n "$LOGIC_APP_URL" ] && [ -n "$PARTICIPANTS_JSON" ]; then
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
    if [ "$TRANSCRIPT_SOURCE_TYPE" = "uploadedTranscript" ]; then
        DOWNLOAD_RESULT=$(node processor/downloadUploadedTranscript.js)
    else
        DOWNLOAD_RESULT=$(node processor/downloadTranscript.js)
    fi
    DOWNLOAD_EXIT_CODE=$?
    set -e

    if [ "$DOWNLOAD_EXIT_CODE" -ne 0 ]; then
        # Try to extract error message from JSON output
        ERROR_MSG=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).message" 2>/dev/null || echo "Unknown error")
        # Log with meeting identifiers for debugging
        if [ "$TRANSCRIPT_SOURCE_TYPE" = "uploadedTranscript" ]; then
            log "error" "Failed to download uploaded transcript [request=$UPLOAD_REQUEST_ID]: $ERROR_MSG"
        else
            log "error" "Failed to download transcript [user=$GRAPH_USER_ID, meeting=$GRAPH_MEETING_ID]: $ERROR_MSG"
        fi

        # Best-effort "failed" notification. The download script emits the
        # meeting subject and any participants it managed to fetch before
        # erroring; fall back to notifying the meeting organizer ($GRAPH_USER_ID)
        # so a failure during transcript fetch is never silent.
        FAILED_SUBJECT=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).meetingSubject || ''" 2>/dev/null || echo "")
        FAILED_PARTICIPANTS=$(echo "$DOWNLOAD_RESULT" | node -pe "JSON.stringify(JSON.parse(require('fs').readFileSync('/dev/stdin').toString()).participants || [])" 2>/dev/null || echo "[]")
        if [ "$FAILED_PARTICIPANTS" = "[]" ] && [ -n "$GRAPH_USER_ID" ]; then
            FAILED_PARTICIPANTS="[{\"userId\":\"$GRAPH_USER_ID\"}]"
        fi
        export MEETING_SUBJECT="$FAILED_SUBJECT"
        export PARTICIPANTS_JSON="$FAILED_PARTICIPANTS"
        send_failure_notification

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

    # Portal upload: mark the submission in-progress so its history shows "Processing".
    update_submission_status "processing"

    # Step 2: Send "started" notification (if configured)
    # Includes cancel URL if available, allowing users to cancel processing
    if [ "$TRANSCRIPT_SOURCE_TYPE" != "uploadedTranscript" ] && [ -n "$LOGIC_APP_URL" ]; then
        export NOTIFICATION_TYPE="started"
        # CANCEL_URL and JOB_EXECUTION_ID are passed from Azure Function
        # They will be included in the notification payload for the Cancel button
        node processor/sendNotification.js >/dev/null || log "warn" "Started notification failed"
    fi

    # Step 3: Process transcript
    # stderr = logs (real-time), stdout = machine output (captured)
    log "info" "Processing transcript with Claude..."

    PROCESSOR_RESULT_FILE=$(mktemp /tmp/tiger-processor-result.XXXXXX.json)
    export PROCESSOR_RESULT_PATH="$PROCESSOR_RESULT_FILE"

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

    # Extract deployed URL from stdout and optional security metadata from a private result file.
    DEPLOYED_URL=$(echo "$PROCESSOR_STDOUT" | grep -oP 'DEPLOYED_URL=\K[^\s"]+' | head -1)
    PASSWORD_PROTECTED=""
    DASHBOARD_PASSWORD=""
    if [ ! -s "$PROCESSOR_RESULT_FILE" ]; then
        log "error" "Processor result metadata missing"
        rm -f "$PROCESSOR_RESULT_FILE"
        unset PROCESSOR_RESULT_PATH
        send_failure_notification
        exit 1
    fi
    PASSWORD_PROTECTED=$(node -pe "JSON.parse(require('fs').readFileSync(process.env.PROCESSOR_RESULT_PATH, 'utf8')).passwordProtected ? 'true' : ''" 2>/dev/null || echo "__parse_error__")
    DASHBOARD_PASSWORD=$(node -pe "JSON.parse(require('fs').readFileSync(process.env.PROCESSOR_RESULT_PATH, 'utf8')).dashboardPassword || ''" 2>/dev/null || echo "__parse_error__")
    rm -f "$PROCESSOR_RESULT_FILE"
    unset PROCESSOR_RESULT_PATH
    if [ "$PASSWORD_PROTECTED" = "__parse_error__" ] || [ "$DASHBOARD_PASSWORD" = "__parse_error__" ]; then
        log "error" "Processor result metadata is invalid"
        send_failure_notification
        exit 1
    fi

    if [ -z "$DEPLOYED_URL" ]; then
        log "error" "Failed to extract deployed URL"
        send_failure_notification
        exit 1
    fi

    log "info" "Deployed: $DEPLOYED_URL"

    # Portal upload: record completion + dashboard URL so the history shows "Ready".
    update_submission_status "completed" "$DEPLOYED_URL"

    # Step 4: Send "completed" notification (if configured)
    if [ "$TRANSCRIPT_SOURCE_TYPE" != "uploadedTranscript" ] && [ -n "$LOGIC_APP_URL" ]; then
        log "info" "Sending completed notification..."
        export NOTIFICATION_TYPE="completed"
        export DASHBOARD_URL="$DEPLOYED_URL"
        export PASSWORD_PROTECTED="$PASSWORD_PROTECTED"
        export DASHBOARD_PASSWORD="$DASHBOARD_PASSWORD"
        if [ "$PASSWORD_PROTECTED" = "true" ]; then
            set +e
            node processor/sendNotification.js >/dev/null
            COMPLETED_NOTIFICATION_EXIT_CODE=$?
            set -e
            if [ "$COMPLETED_NOTIFICATION_EXIT_CODE" -ne 0 ]; then
                log "error" "Completed notification failed for password-protected dashboard"
                send_failure_notification
                exit 1
            fi
        else
            node processor/sendNotification.js >/dev/null || log "warn" "Completed notification failed"
        fi
    fi
}

# Check mode
if [ "$TRANSCRIPT_SOURCE_TYPE" = "uploadedTranscript" ] || { [ -n "$GRAPH_MEETING_ID" ] && [ -n "$GRAPH_TRANSCRIPT_ID" ] && [ -n "$GRAPH_USER_ID" ]; }; then
    # Azure mode: full pipeline
    setup_claude_auth
    run_pipeline
else
    # Local mode: direct processor call
    setup_claude_auth
    node processor/index.js "$@"
fi
