# Using Claude Subscriptions in Docker - Complete Guide

## Quick Answer

**❌ No**, Claude Code OAuth tokens (`sk-ant-oat01-...`) **cannot** be used in Docker, even with subscriptions.

**✅ Yes**, you **can** use your subscription benefits in Docker by creating API keys from your subscription account.

---

## The Problem

When you run `claude login`, you get an OAuth token like:
```
sk-ant-oat01-AzF9kc50CH_h_PtYEoTCCzF4Uli8h9DL1vWf6aM72PN5...
```

This token:
- ✅ Works on your local machine with Claude Code CLI
- ❌ **Does NOT work in Docker containers**
- ❌ **Cannot be used for automated flows**
- ❌ **Requires browser-based authentication**

## The Solution: API Keys from Your Subscription Account

If you have a **Claude Pro** or **Claude Code subscription**, follow these steps:

### Step 1: Create an API Key from Your Subscription Account

1. Go to [https://console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
2. **Make sure you're logged in with the SAME account that has your subscription**
3. Click "Create Key"
4. Name it (e.g., "TIGER Pipeline - Production")
5. Copy the key (starts with `sk-ant-api03-...`)

### Step 2: Verify Your API Key Has Subscription Benefits

API keys created under a subscription account automatically get:
- ✅ **Higher rate limits** (10x more requests)
- ✅ **Priority access** during peak times
- ✅ **Lower per-token costs** (~30-40% reduction)
- ✅ **Access to latest models** first
- ✅ **Dedicated support**

### Step 3: Update Your .env File

```bash
# Replace the OAuth token with your API key
ANTHROPIC_API_KEY=sk-ant-api03-YOUR-ACTUAL-KEY-HERE

# Remove or comment out the OAuth token line
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...

# Keep your other credentials
SURGE_EMAIL=your-email@example.com
SURGE_TOKEN=your-surge-token
```

### Step 4: Test Locally First

```powershell
# Rebuild Docker image
docker-compose build

# Test authentication
docker-compose run --rm --entrypoint sh meeting-processor -c "echo 'test' | claude"

# Should see Claude's response, not an auth error
```

### Step 5: Deploy to Azure with Subscription Benefits

```bash
# Store your subscription API key in Azure Key Vault
az keyvault secret set \
  --vault-name kv-tiger \
  --name anthropic-api-key \
  --value sk-ant-api03-YOUR-KEY-HERE

# Configure Container App
az containerapp job update \
  --name job-tiger-processor \
  --resource-group rg-tiger \
  --set-env-vars "ANTHROPIC_API_KEY=secretref:anthropic-api-key"
```

---

## Why OAuth Tokens Don't Work in Docker

| Aspect | OAuth Token | API Key |
|--------|-------------|---------|
| **Authentication Type** | Browser session | Direct credentials |
| **Requires User Interaction?** | ✅ Yes (browser login) | ❌ No |
| **Works in Docker?** | ❌ No | ✅ Yes |
| **Works in Azure?** | ❌ No | ✅ Yes |
| **Works for TIGER Pipeline?** | ❌ No | ✅ Yes |
| **Automated flows?** | ❌ No | ✅ Yes |
| **Can inherit subscription?** | N/A | ✅ Yes |

### Technical Explanation

1. **OAuth tokens are session-based**: They represent a logged-in web session, not API credentials
2. **Docker containers are isolated**: They can't open browsers or access your local session
3. **Claude CLI uses different auth flows**: Local CLI can use browser, Docker cannot
4. **Anthropic SDK requires API keys**: The underlying SDK doesn't support OAuth tokens

---

## Cost Comparison

### With Subscription API Key (Recommended for TIGER)

**Monthly Cost**:
- Subscription: $20/month (Claude Pro) or $40/month (Claude Code)
- Per-meeting cost: ~$0.20-$0.30 (with subscription discounts)

**Benefits**:
- Fixed monthly cost + reduced per-token rates
- Higher rate limits (can process more meetings simultaneously)
- Priority access (no slowdowns during peak times)
- Ideal for production use

**Break-even**: ~40-60 meetings per month

### Without Subscription (Pay-as-you-go)

**Monthly Cost**:
- No subscription fee
- Per-meeting cost: ~$0.30-$0.50 (standard rates)

**Benefits**:
- No fixed costs
- Good for testing/low volume
- No commitment

**Best for**: Development, testing, < 40 meetings/month

---

## Verification Checklist

Before deploying to production, verify:

### Local Testing
- [ ] `.env` file has `ANTHROPIC_API_KEY=sk-ant-api03-...`
- [ ] No `CLAUDE_CODE_OAUTH_TOKEN` line (or it's commented out)
- [ ] `docker-compose build` completes without errors
- [ ] `docker-compose run --rm --entrypoint sh meeting-processor -c "echo 'test' | claude"` returns Claude response
- [ ] `.\test-meeting-processor.ps1` processes a test transcript successfully

### Azure Deployment
- [ ] API key stored in Azure Key Vault
- [ ] Container App has `ANTHROPIC_API_KEY` environment variable configured
- [ ] Test execution: `az containerapp job start --name job-tiger-processor --resource-group rg-tiger`
- [ ] Check logs show successful authentication
- [ ] Dashboard deploys to Surge
- [ ] Teams notification posted (if configured)

---

## Troubleshooting

### Error: "OAuth token detected in ANTHROPIC_API_KEY"

**Cause**: You're using an OAuth token instead of an API key

**Solution**:
1. Go to [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
2. Create a new API key (starts with `sk-ant-api03-`)
3. Replace the OAuth token in your `.env` file
4. Rebuild: `docker-compose build`

### Error: "Invalid API key"

**Cause**: API key is wrong, expired, or not set

**Solution**:
1. Verify key starts with `sk-ant-api03-` (not `sk-ant-oat01-`)
2. Check it's correctly set in `.env` file
3. Regenerate key if needed from [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
4. Rebuild container

### Error: "Rate limit exceeded" (but you have a subscription)

**Cause**: API key not created under subscription account

**Solution**:
1. Log out of console.anthropic.com
2. Log back in with your **subscription account** email
3. Create a NEW API key from that account
4. Replace the old key in `.env` and Azure Key Vault
5. The new key will have subscription rate limits

### How to verify subscription benefits are active?

Check the rate limit headers in responses:
```bash
# If using subscription API key, you'll see higher limits:
X-RateLimit-Limit: 50000  # vs 5000 for non-subscription
X-RateLimit-Remaining: 49950
```

Or contact Anthropic support with your API key to confirm it's linked to your subscription.

---

## Alternative: Manual Workflow (Not Recommended)

If you absolutely cannot use API keys, you would need to:

1. **Manually run Claude Code locally** (not in Docker)
2. **Process meetings on your local machine** (with OAuth token)
3. **Manually deploy dashboards** to Surge
4. **Manually post links** to Teams

This defeats the purpose of the TIGER automated pipeline.

---

## Summary

**For TIGER Pipeline Automation**:
1. ✅ Create API key from your subscription account at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
2. ✅ Use `ANTHROPIC_API_KEY` in `.env` and Azure
3. ✅ Subscription benefits automatically apply
4. ✅ Fully automated flow works
5. ❌ Do NOT use OAuth tokens (`sk-ant-oat01-...`)

**Result**: Automated TIGER pipeline with subscription benefits! 🐯

---

## References

- [Anthropic API Keys Console](https://console.anthropic.com/settings/keys)
- [Anthropic API Documentation](https://docs.anthropic.com/en/api/getting-started)
- [DOCKER-AUTH.md](./DOCKER-AUTH.md) - Detailed Docker authentication guide
- [TIGER.md](./TIGER.md) - Full TIGER pipeline deployment guide
