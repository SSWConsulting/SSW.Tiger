#\!/bin/sh
/app/entrypoint.sh echo "Entrypoint completed"
ls -la ~/.claude/
echo "=== Config file ===" 
cat ~/.claude.json
echo "=== Session file ===" 
cat ~/.claude/session
echo "=== Test Claude ===" 
echo "test" | claude

