# ==============================================================================
# TIGER Meeting Processor - Local Test Script (PowerShell)
# ==============================================================================

param(
    [Parameter(Mandatory=$true, HelpMessage="Path to transcript file (.vtt)")]
    [string]$TranscriptPath,

    [Parameter(Mandatory=$true, HelpMessage="Project name")]
    [string]$ProjectName
)

Write-Host ""
Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host "TIGER Meeting Processor - Local Test" -ForegroundColor Cyan
Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host ""

# Check if Node.js is installed
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] Node.js is not installed." -ForegroundColor Red
    Write-Host "Download from: https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

# Check if Claude CLI is installed
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] Claude CLI is not installed." -ForegroundColor Red
    Write-Host "Install with: npm install -g @anthropic-ai/claude-cli" -ForegroundColor Yellow
    exit 1
}

# Check if transcript file exists
if (-not (Test-Path $TranscriptPath)) {
    Write-Host "[ERROR] Transcript file not found: $TranscriptPath" -ForegroundColor Red
    exit 1
}

# Check Claude CLI login status
Write-Host "[INFO] Checking Claude CLI login status..." -ForegroundColor Yellow
$claudeVersion = claude --version
Write-Host "  Claude CLI Version: $claudeVersion" -ForegroundColor Gray

# The Claude CLI uses your logged-in session automatically
# No need to extract or set CLAUDE_SUBSCRIPTION_TOKEN explicitly
Write-Host "[INFO] Using Claude Code subscription from your logged-in session" -ForegroundColor Green
Write-Host ""

# Set output directory
$env:OUTPUT_DIR = Join-Path $PSScriptRoot "output"

Write-Host "[INFO] Configuration:" -ForegroundColor Yellow
Write-Host "  - Transcript: $TranscriptPath" -ForegroundColor Gray
Write-Host "  - Project: $ProjectName" -ForegroundColor Gray
Write-Host "  - Output: $($env:OUTPUT_DIR)" -ForegroundColor Gray
Write-Host "  - Auth: Claude Code Subscription (auto-detected)" -ForegroundColor Gray
Write-Host ""
Write-Host "[INFO] Starting processing..." -ForegroundColor Yellow
Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host ""

# Run the processor
$fullTranscriptPath = Resolve-Path $TranscriptPath
node processor.js $fullTranscriptPath $ProjectName

$exitCode = $LASTEXITCODE

Write-Host ""
Write-Host "============================================================================" -ForegroundColor Cyan
if ($exitCode -eq 0) {
    Write-Host "[SUCCESS] Processing completed!" -ForegroundColor Green
    Write-Host "Check the output directory: $($env:OUTPUT_DIR)" -ForegroundColor Gray

    # Look for the dashboard
    $indexPath = Join-Path $env:OUTPUT_DIR "index.html"
    if (Test-Path $indexPath) {
        Write-Host ""
        Write-Host "Dashboard generated at: $indexPath" -ForegroundColor Green
        $openDashboard = Read-Host "Open dashboard in browser? (Y/N)"
        if ($openDashboard -eq "Y" -or $openDashboard -eq "y") {
            Start-Process $indexPath
        }
    }
} else {
    Write-Host "[ERROR] Processing failed with exit code $exitCode" -ForegroundColor Red
    Write-Host "Check error.log for details" -ForegroundColor Yellow
}
Write-Host "============================================================================" -ForegroundColor Cyan
Write-Host ""

exit $exitCode
