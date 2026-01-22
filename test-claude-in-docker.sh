#!/bin/sh
# Test script to check Claude CLI authentication in Docker

echo "=== Claude Config Files ==="
ls -la ~/.claude/
echo ""

echo "=== Claude Config Content ==="
cat ~/.claude.json 2>&1 || echo "No .claude.json"
echo ""

echo "=== Claude Session Content ==="
cat ~/.claude/session 2>&1 || echo "No session file"
echo ""

echo "=== Testing Claude CLI ==="
echo "Say: AUTH_WORKS" | claude 2>&1
