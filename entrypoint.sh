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

# Execute the main command (processor.js with arguments)
exec node processor.js "$@"
