# Create-GraphSubscription.ps1
# Creates a Microsoft Graph subscription for transcript notifications using App-only authentication

param(
    [Parameter(Mandatory=$true)]
    [string]$TenantId,

    [Parameter(Mandatory=$true)]
    [string]$ClientId,

    [Parameter(Mandatory=$true)]
    [string]$ClientSecret,

    [Parameter(Mandatory=$true)]
    [string]$FunctionKey,

    [string]$FunctionAppName = "func-tiger-staging",
    [string]$KeyVaultName = "kv-tiger-staging",
    [string]$ClientState = "tiger-secret-state",
    [int]$ExpirationDays = 3
)

$ErrorActionPreference = "Stop"

Write-Host "=== Graph Subscription Creator ===" -ForegroundColor Cyan

# Step 1: Get App Token
Write-Host "`n[1/3] Getting app access token..." -ForegroundColor Yellow

$tokenBody = @{
    client_id     = $ClientId
    client_secret = $ClientSecret
    scope         = "https://graph.microsoft.com/.default"
    grant_type    = "client_credentials"
}

try {
    $tokenResponse = Invoke-RestMethod -Method POST `
        -Uri "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token" `
        -ContentType "application/x-www-form-urlencoded" `
        -Body $tokenBody

    $accessToken = $tokenResponse.access_token
    Write-Host "  Access token obtained successfully" -ForegroundColor Green
} catch {
    Write-Host "  Failed to get access token: $_" -ForegroundColor Red
    exit 1
}

# Step 2: Warm up Function (to avoid cold start timeout)
Write-Host "`n[2/3] Warming up Function App..." -ForegroundColor Yellow

$functionUrl = "https://$FunctionAppName.azurewebsites.net/api/TranscriptWebhook"

1..3 | ForEach-Object {
    try {
        $warmupResponse = Invoke-WebRequest "$functionUrl`?code=$FunctionKey&validationToken=warmup$_" -TimeoutSec 30  -UseBasicParsing
        Write-Host "  Warmup $_ : $($warmupResponse.StatusCode)" -ForegroundColor Green
    } catch {
        Write-Host "  Warmup $_ failed: $_" -ForegroundColor Yellow
    }
}

# Step 3: Create Subscription
Write-Host "`n[3/4] Creating Graph subscription..." -ForegroundColor Yellow

$expirationDateTime = (Get-Date).AddDays($ExpirationDays).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

$headers = @{
    "Authorization" = "Bearer $accessToken"
    "Content-Type"  = "application/json"
}

$subscriptionBody = @{
    changeType               = "created"
    notificationUrl          = "$functionUrl`?code=$FunctionKey"
    lifecycleNotificationUrl = "$functionUrl`?code=$FunctionKey"
    resource                 = "communications/onlineMeetings/getAllTranscripts"
    expirationDateTime       = $expirationDateTime
    clientState              = $ClientState
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Method POST `
        -Uri "https://graph.microsoft.com/v1.0/subscriptions" `
        -Headers $headers `
        -Body $subscriptionBody

    Write-Host "`n=== Subscription Created Successfully ===" -ForegroundColor Green
    Write-Host "  Subscription ID : $($response.id)"
    Write-Host "  Resource        : $($response.resource)"
    Write-Host "  Expires         : $($response.expirationDateTime)"

    # Save subscription ID to Key Vault
    Write-Host "`n[4/4] Saving subscription ID to Key Vault..." -ForegroundColor Yellow
    try {
        az keyvault secret set --vault-name $KeyVaultName --name "graph-subscription-id" --value $response.id | Out-Null
        Write-Host "  Saved to Key Vault: $KeyVaultName/graph-subscription-id" -ForegroundColor Green
    } catch {
        Write-Host "  Warning: Failed to save to Key Vault: $_" -ForegroundColor Yellow
        Write-Host "  Manually run: az keyvault secret set --vault-name $KeyVaultName --name graph-subscription-id --value $($response.id)" -ForegroundColor Yellow
    }

    # Output subscription ID for scripting
    return $response
} catch {
    $errorDetails = $_.ErrorDetails.Message | ConvertFrom-Json -ErrorAction SilentlyContinue
    if ($errorDetails) {
        Write-Host "`nFailed to create subscription:" -ForegroundColor Red
        Write-Host "  Code    : $($errorDetails.error.code)" -ForegroundColor Red
        Write-Host "  Message : $($errorDetails.error.message)" -ForegroundColor Red
    } else {
        Write-Host "`nFailed to create subscription: $_" -ForegroundColor Red
    }
    exit 1
}
