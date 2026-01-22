# Docker Authentication Setup

## Critical: OAuth Tokens vs API Keys

**⚠️ IMPORTANT:** Claude Code OAuth tokens (`sk-ant-oat01-...`) **DO NOT WORK** in Docker containers. They only work on your local machine with Claude Code CLI.

### Token Types Explained

| Token Type | Format | Where It Works | How to Get |
|------------|--------|----------------|------------|
| **OAuth Token** | `sk-ant-oat01-...` | ✅ Local Claude Code CLI<br>❌ Docker containers | Automatic when logged in to Claude Code |
| **API Key** | `sk-ant-api03-...` | ✅ Local Claude Code CLI<br>✅ Docker containers<br>✅ Direct API calls | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) |

## Problem

When you run Claude Code CLI (`claude login`), you get an OAuth token that looks like:
```
sk-ant-oat01-AzF9kc50...
```

This token **cannot** be used as an API key in Docker. If you try, you'll see:
```
{"level":"ERROR","message":"Claude CLI error event","data":{"error":"authentication_failed"}}
Invalid API key · Fix external API key
```

## Solution: Use an Anthropic API Key

### Step 1: Get an API Key

1. Go to [https://console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
2. Click "Create Key"
3. Copy the key - it should start with `sk-ant-api03-...`

### Step 2: Update Your .env File

Replace or add the API key to your `.env` file:

```bash
# ❌ This WON'T work in Docker (OAuth token):
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...

# ✅ Use this instead (API key):
ANTHROPIC_API_KEY=sk-ant-api03-YOUR-ACTUAL-KEY-HERE

# Surge credentials (required for deployment)
SURGE_EMAIL=your-email@example.com
SURGE_TOKEN=your-surge-token
```

### Step 3: Rebuild and Test

```powershell
# Rebuild the Docker image
docker-compose build

# Test authentication
docker-compose run --rm --entrypoint sh meeting-processor -c "echo 'test' | claude"
```

## Why OAuth Tokens Don't Work in Docker

1. **OAuth tokens are session-based** - They're tied to your local Claude Code CLI login session
2. **Docker containers are isolated** - They can't access your local Claude Code session
3. **Anthropic SDK requires API credentials** - OAuth tokens are not API keys

The `entrypoint.sh` script now validates this and will reject OAuth tokens with a clear error message.

## Validation

The entrypoint script now checks for:

- ✅ Valid API keys starting with `sk-ant-api03-`
- ❌ OAuth tokens starting with `sk-ant-oat01-` (rejected with error)
- ❌ Missing credentials (rejected with error)

## Verification Steps

### 1. Check Your Token Type

```powershell
# In PowerShell, check what you have in .env
Get-Content .env | Select-String "ANTHROPIC|CLAUDE"
```

If you see `sk-ant-oat01`, you need to replace it with an API key.

### 2. Test in Container

```powershell
# Build the container
docker-compose build

# Verify environment variables
docker-compose run --rm --entrypoint sh meeting-processor -c "env | grep ANTHROPIC"
```

Should show:
```
ANTHROPIC_API_KEY=sk-ant-api03-...
```

### 3. Test Claude CLI

```powershell
# Test Claude CLI works
docker-compose run --rm --entrypoint sh meeting-processor -c "echo 'test' | claude"
```

Should return a Claude response, not an authentication error.

### 4. Run Full Test

```powershell
# Process a meeting
.\test-meeting-processor.ps1 -Transcript your-file.vtt -Project your-project
```

## Troubleshooting

### Error: "OAuth token detected in ANTHROPIC_API_KEY"

**Cause**: You're using an OAuth token (`sk-ant-oat01-...`) instead of an API key

**Solution**:
1. Get an API key from [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
2. Update `.env` file with `ANTHROPIC_API_KEY=sk-ant-api03-...`
3. Remove or comment out `CLAUDE_CODE_OAUTH_TOKEN` line
4. Rebuild: `docker-compose build`

### Error: "Invalid API key"

**Cause**: API key is wrong, expired, or not set correctly

**Solution**:
1. Verify the key starts with `sk-ant-api03-`
2. Check it's set in `.env` file: `cat .env | grep ANTHROPIC_API_KEY`
3. Regenerate key if expired at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
4. Rebuild container: `docker-compose build`

### Error: "No authentication configured"

**Cause**: Neither `ANTHROPIC_API_KEY` is set

**Solution**:
1. Create `.env` file if it doesn't exist
2. Add line: `ANTHROPIC_API_KEY=sk-ant-api03-your-key-here`
3. Rebuild: `docker-compose build`

## Security Notes

### API Key Storage

- **Never commit API keys to git** - The `.env` file is in `.gitignore`
- **Rotate keys periodically** - Generate new keys every 90 days
- **Use separate keys per environment** - Dev, staging, production
- **Limit key permissions** - Create keys with minimal required access

### Docker Security

- Container runs as non-root `nodejs` user
- Resource limits in docker-compose.yml (2GB RAM, 2 CPUs)
- Read-only mounts for templates and configs
- No network access except for Claude API and Surge

## Quick Reference

```powershell
# Check what auth you have
cat .env | grep -E "(ANTHROPIC|CLAUDE)"

# Rebuild after changing .env
docker-compose build

# Test authentication
docker-compose run --rm --entrypoint sh meeting-processor -c "echo 'test' | claude"

# Process a meeting
docker-compose run --rm meeting-processor /app/dropzone/file.vtt project-name

# Debug environment variables
docker-compose run --rm --entrypoint sh meeting-processor -c "env | grep ANTHROPIC"
```

## What Changed

**Before (Incorrect)**:
```yaml
environment:
  - ANTHROPIC_API_KEY=${CLAUDE_CODE_OAUTH_TOKEN:-${ANTHROPIC_API_KEY}}  # ❌ Wrong
```

**After (Correct)**:
```yaml
environment:
  - CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}  # For reference only
  - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}              # ✅ Required
```

The entrypoint now validates that `ANTHROPIC_API_KEY` is a proper API key, not an OAuth token.

## References

- [Anthropic API Keys](https://console.anthropic.com/settings/keys)
- [Anthropic API Documentation](https://docs.anthropic.com/en/api/getting-started)
- [Docker Security Best Practices](https://docs.docker.com/develop/security-best-practices/)
