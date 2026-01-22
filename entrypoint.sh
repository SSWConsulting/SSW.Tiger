#!/bin/sh
# Entrypoint script to set up Claude CLI configuration before running processor

# Create Claude config directory
mkdir -p ~/.claude

# Configure Claude CLI authentication
if [ -n "$ANTHROPIC_API_KEY" ]; then
    # Check if it's an OAuth token (starts with sk-ant-oat)
    case "$ANTHROPIC_API_KEY" in
        sk-ant-oat*)
            echo "❌ ERROR: OAuth token detected in ANTHROPIC_API_KEY"
            echo "   OAuth tokens (sk-ant-oat...) cannot be used as API keys in Docker"
            echo "   Please use a proper Anthropic API key (sk-ant-api...)"
            echo "   Get one from: https://console.anthropic.com/settings/keys"
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
            echo "✓ Configured Claude CLI with API key"
            ;;
        *)
            echo "⚠ WARNING: Unrecognized API key format"
            cat > ~/.claude.json <<EOF
{
  "hasCompletedOnboarding": true,
  "defaultModel": "claude-sonnet-4-20250514"
}
EOF
            ;;
    esac
elif [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
    echo "ℹ️  OAuth token detected (CLAUDE_CODE_OAUTH_TOKEN)"
    echo "   Note: OAuth tokens work on your local machine but not in Docker"
    echo "   For Docker usage, set ANTHROPIC_API_KEY with a proper API key"
    echo "   Get one from: https://console.anthropic.com/settings/keys"
    exit 1
else
    echo "❌ ERROR: No authentication configured"
    echo "   Set ANTHROPIC_API_KEY with an Anthropic API key (sk-ant-api...)"
    echo "   Get one from: https://console.anthropic.com/settings/keys"
    exit 1
fi

# Execute the main command (processor.js with arguments)
exec node processor.js "$@"
