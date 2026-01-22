# 🚀 Quick Start - Local Testing

This guide helps you test the processor locally with your Claude Code subscription.

## Prerequisites

✅ Node.js installed
✅ Claude Code CLI installed (`npm install -g @anthropic-ai/claude-cli`)
✅ Claude Code subscription (logged in)

## Step 1: Verify Claude CLI Login

```bash
claude --version
```

You should see: `2.x.x (Claude Code)`

Test your subscription:
```bash
echo "test" | claude --print "respond with OK"
```

If you see a response, you're authenticated! ✅

## Step 2: Prepare a Test Transcript

1. Create a `dropzone` folder if it doesn't exist:
   ```bash
   mkdir dropzone
   ```

2. Place your `.vtt` transcript file in the dropzone:
   ```
   dropzone/
   └── meeting.vtt
   ```

## Step 3: Run the Processor

**Note:** Surge.sh deployment is **optional**. If you don't set surge credentials, the dashboard will be generated locally in `output/index.html`.

### Option A: Using Test Script (Recommended)

**Windows PowerShell:**
```powershell
.\test-local.ps1 dropzone\meeting.vtt test-project
```

**Windows Command Prompt:**
```cmd
test-local.bat dropzone\meeting.vtt test-project
```

### Option B: Direct Node.js

```bash
node processor.js dropzone/meeting.vtt test-project
```

### Option C: With Surge Deployment (Optional)

If you want to deploy to surge.sh, set credentials first:

```powershell
# Get your surge token from https://surge.sh/
$env:SURGE_LOGIN = "your-email@example.com"
$env:SURGE_TOKEN = "your-surge-token"

node processor.js dropzone/meeting.vtt test-project
```

## What Happens

1. ✅ Processor detects your Claude CLI session
2. ✅ Creates project structure: `projects/test-project/`
3. ✅ Invokes Claude Code CLI with transcript
4. ✅ Claude analyzes with 5 specialized agents (parallel)
5. ✅ Consolidates results
6. ✅ Generates HTML dashboard: `output/index.html`
7. ✅ (Optional) Deploys to surge.sh

## Expected Output

```json
{"timestamp":"2026-01-21T...","level":"INFO","message":"Initializing processor",...}
{"level":"INFO","message":"Using Claude CLI session authentication (logged-in user)"}
{"level":"INFO","message":"Invoking Claude Code CLI"}
...
{"level":"INFO","message":"SUCCESS: Meeting processing completed","dashboardPath":"...","exitCode":0}
```

## Check Results

Dashboard location: `output/index.html`

Open in browser:
```powershell
# PowerShell
start output\index.html

# Command Prompt
start output\index.html

# Or just double-click the file
```

## Troubleshooting

### ❌ "No Claude authentication configured"

**Solution**: You may need to explicitly set your credentials. See "Advanced Setup" below.

### ❌ "Claude Code CLI failed with exit code"

**Check**:
- Is Claude CLI logged in? Run `claude --version`
- Check `error.log` for details
- Make sure transcript file is valid `.vtt` format

### ❌ "Transcript file not found"

**Check**: Path is correct and file exists:
```bash
ls dropzone/meeting.vtt
```

## Advanced Setup (Optional)

If the automatic session detection doesn't work, you can set explicit credentials:

### For Subscription Users:

The Claude CLI stores credentials in `~/.claude.json`, but you may need to set them explicitly for the processor:

```bash
# If you need to use explicit subscription token
# (Contact Anthropic support for how to extract this)
set CLAUDE_SUBSCRIPTION_TOKEN=your-token-here
node processor.js dropzone/meeting.vtt test-project
```

### For API Key Users:

```bash
set ANTHROPIC_API_KEY=sk-ant-api03-...
node processor.js dropzone/meeting.vtt test-project
```

## Production Deployment

For automated Azure deployment, see [TIGER.md](TIGER.md).

For production, always use explicit credentials stored in Azure Key Vault (not relying on CLI session).

## Next Steps

- ✅ Test with a real meeting transcript
- 📖 Read [CLAUDE.md](CLAUDE.md) to understand the analysis workflow
- 🐯 Deploy to Azure using [TIGER.md](TIGER.md)
- 🎨 Customize the dashboard template in `templates/`

---

**Need Help?**
- Check `error.log` for detailed error messages
- Review processor output (JSON logs)
- Verify Claude CLI is working: `echo "test" | claude --print "say OK"`
