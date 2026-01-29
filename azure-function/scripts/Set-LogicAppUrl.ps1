# Set-LogicAppUrl.ps1
# Saves the Logic App HTTP trigger URL to Key Vault for Function App to use

param(
    [Parameter(Mandatory=$true)]
    [string]$LogicAppUrl,

    [string]$KeyVaultName = "kv-tiger-staging"
)

$ErrorActionPreference = "Stop"

Write-Host "=== Save Logic App URL to Key Vault ===" -ForegroundColor Cyan

try {
    az keyvault secret set --vault-name $KeyVaultName --name "logic-app-url" --value $LogicAppUrl | Out-Null
    Write-Host "Saved to Key Vault: $KeyVaultName/logic-app-url" -ForegroundColor Green
    Write-Host "URL: $LogicAppUrl" -ForegroundColor Gray
} catch {
    Write-Host "Failed to save to Key Vault: $_" -ForegroundColor Red
    exit 1
}
