#!/bin/bash
# Test Claude Code authentication in Docker

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
