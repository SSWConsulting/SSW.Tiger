# Test Full Pipeline with Real Graph API
# Tests entire workflow: Download → Process → Deploy → Notify
#
# Usage: .\test-full-pipeline.ps1 -UserId <user-id> -MeetingId <meeting-id> -TranscriptId <transcript-id>
#
# Prerequisites:
# - .env file with all required credentials:
#   - GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, GRAPH_TENANT_ID
#   - CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
#   - SURGE_EMAIL, SURGE_TOKEN
#   - LOGIC_APP_URL
#
# Flow:
#   1. entrypoint.sh (Azure mode)
#   2. → download-transcript.js (Graph API)
#   3. → processor.js (Claude CLI → surge.sh)
#   4. → send-teams-notification.js (Logic App)

param(
    [Parameter(Mandatory=$true)]
    [string]$UserId,

    [Parameter(Mandatory=$true)]
    [string]$MeetingId,

    [Parameter(Mandatory=$true)]
    [string]$TranscriptId,

    [switch]$SkipNotification
)

$ErrorActionPreference = "Continue"

Write-Host "=== Full Pipeline Test (Real Graph API) ===" -ForegroundColor Cyan
Write-Host ""

# Load .env file - use $env: to ensure variables are passed to child processes
$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path $envFile) {
    Write-Host "Loading .env file..." -ForegroundColor Gray
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
            $name = $matches[1].Trim()
            $value = $matches[2].Trim() -replace '^["'']|["'']$', ''
            # Use Set-Item to set env var for current process AND child processes
            Set-Item -Path "Env:$name" -Value $value
        }
    }
    Write-Host "OK .env loaded" -ForegroundColor Green
} else {
    Write-Host "X .env file not found at $envFile" -ForegroundColor Red
    exit 1
}

# Check required env vars
$required = @(
    "GRAPH_CLIENT_ID",
    "GRAPH_CLIENT_SECRET",
    "GRAPH_TENANT_ID",
    "SURGE_EMAIL",
    "SURGE_TOKEN"
)

# Check for Claude credentials (one of these)
$hasClaudeAuth = $env:CLAUDE_CODE_OAUTH_TOKEN -or $env:ANTHROPIC_API_KEY
if (-not $hasClaudeAuth) {
    $required += "CLAUDE_CODE_OAUTH_TOKEN"
}

$missing = $required | Where-Object { -not (Get-Item -Path "Env:$_" -ErrorAction SilentlyContinue) }
if ($missing) {
    Write-Host "X Missing required environment variables in .env:" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}

# Debug: show Claude auth status
if ($env:CLAUDE_CODE_OAUTH_TOKEN) {
    Write-Host "OK Claude OAuth token found" -ForegroundColor Green
} elseif ($env:ANTHROPIC_API_KEY) {
    Write-Host "OK Anthropic API key found" -ForegroundColor Green
}

# Check Logic App URL (optional but warn if missing)
if (-not $env:LOGIC_APP_URL) {
    Write-Host "! LOGIC_APP_URL not set - notification will be skipped" -ForegroundColor Yellow
}

# Set Graph API parameters for entrypoint.sh (Azure mode)
$env:GRAPH_USER_ID = $UserId
$env:GRAPH_MEETING_ID = $MeetingId
$env:GRAPH_TRANSCRIPT_ID = $TranscriptId

# Ensure mock mode is OFF
$env:USE_MOCK_TRANSCRIPT = ""

Write-Host ""
Write-Host "Configuration:" -ForegroundColor Green
Write-Host "  GRAPH_USER_ID: $UserId"
Write-Host "  GRAPH_MEETING_ID: $($MeetingId.Substring(0, [Math]::Min(40, $MeetingId.Length)))..."
Write-Host "  GRAPH_TRANSCRIPT_ID: $($TranscriptId.Substring(0, [Math]::Min(40, $TranscriptId.Length)))..."
Write-Host "  SURGE_EMAIL: $($env:SURGE_EMAIL)"
Write-Host "  LOGIC_APP_URL: $(if ($env:LOGIC_APP_URL) { $env:LOGIC_APP_URL.Substring(0, 50) + '...' } else { '(not set)' })"
Write-Host ""

Write-Host "Pipeline Steps:" -ForegroundColor Cyan
Write-Host "  1. Download transcript from Graph API"
Write-Host "  2. Process with Claude CLI"
Write-Host "  3. Deploy dashboard to surge.sh"
Write-Host "  4. Send Teams notification via Logic App"
Write-Host ""

# Run entrypoint.sh (which orchestrates the entire pipeline)
Write-Host "Starting full pipeline..." -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor DarkGray
Write-Host ""

$startTime = Get-Date
$exitCode = 0

# Step 1: Download transcript
Write-Host "Step 1: Downloading transcript from Graph API..." -ForegroundColor Cyan

# Helper function to run node with current env vars
function Invoke-Node {
    param([string]$Script, [string]$Args = "")

    $pinfo = New-Object System.Diagnostics.ProcessStartInfo
    $pinfo.FileName = "node"
    $pinfo.Arguments = if ($Args) { "$Script $Args" } else { $Script }
    $pinfo.RedirectStandardOutput = $true
    $pinfo.RedirectStandardError = $true
    $pinfo.UseShellExecute = $false
    $pinfo.WorkingDirectory = $PWD

    # Copy all current env vars to the process
    foreach ($key in [Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::Process).Keys) {
        $pinfo.EnvironmentVariables[$key] = [Environment]::GetEnvironmentVariable($key)
    }

    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $pinfo
    $p.Start() | Out-Null
    $stdout = $p.StandardOutput.ReadToEnd()
    $stderr = $p.StandardError.ReadToEnd()
    $p.WaitForExit()

    return @{
        ExitCode = $p.ExitCode
        Stdout = $stdout
        Stderr = $stderr
    }
}

$result1 = Invoke-Node "download-transcript.js"
$stdout1 = $result1.Stdout
$stderr1 = $result1.Stderr

if ($stderr1) { Write-Host $stderr1 -ForegroundColor Gray }

if ($result1.ExitCode -ne 0) {
    Write-Host "X Download failed" -ForegroundColor Red
    $exitCode = 1
} else {
    $downloadResult = $stdout1.Trim() | ConvertFrom-Json

    if ($downloadResult.skipped) {
        Write-Host "! Skipped: $($downloadResult.reason)" -ForegroundColor Yellow
        $exitCode = 0
    } elseif ($downloadResult.error) {
        Write-Host "X Error: $($downloadResult.message)" -ForegroundColor Red
        $exitCode = 1
    } else {
        Write-Host "OK Download successful" -ForegroundColor Green
        Write-Host "   Project: $($downloadResult.projectName)"
        Write-Host "   Date: $($downloadResult.meetingDate)"
        Write-Host "   File: $($downloadResult.filename)"
        Write-Host "   Participants: $($downloadResult.participants.Count)"
        Write-Host ""

        # Step 2: Process transcript
        Write-Host "Step 2: Processing transcript with Claude..." -ForegroundColor Cyan
        Write-Host "   (This may take several minutes)" -ForegroundColor Gray
        Write-Host ""

        $tempFile = [System.IO.Path]::GetTempFileName()
        & node processor.js $downloadResult.transcriptPath $downloadResult.projectName 2>&1 | Tee-Object -FilePath $tempFile
        $processorExitCode = $LASTEXITCODE

        $processorOutput = Get-Content $tempFile -Raw
        Remove-Item $tempFile -ErrorAction SilentlyContinue

        if ($processorExitCode -ne 0) {
            Write-Host ""
            Write-Host "X Processing failed" -ForegroundColor Red
            $exitCode = 1
        } else {
            # Extract deployed URL
            if ($processorOutput -match 'DEPLOYED_URL=([^\s"]+)') {
                $deployedUrl = $matches[1]
                Write-Host ""
                Write-Host "OK Dashboard deployed: $deployedUrl" -ForegroundColor Green
                Write-Host ""

                # Step 3: Send notification
                if ($env:LOGIC_APP_URL -and $downloadResult.participants.Count -gt 0) {
                    Write-Host "Step 3: Sending Teams notification..." -ForegroundColor Cyan

                    # Set notification env vars
                    $env:DASHBOARD_URL = $deployedUrl
                    $env:PROJECT_NAME = $downloadResult.projectName
                    $env:MEETING_SUBJECT = $downloadResult.meetingSubject
                    # Wrap in @() to ensure array (ConvertTo-Json outputs object for single item)
                    $env:PARTICIPANTS_JSON = (ConvertTo-Json @($downloadResult.participants) -Compress)

                    $result3 = Invoke-Node "send-teams-notification.js"

                    if ($result3.Stderr) { Write-Host $result3.Stderr -ForegroundColor Gray }

                    if ($result3.ExitCode -eq 0) {
                        $notifResult = $result3.Stdout.Trim() | ConvertFrom-Json
                        Write-Host "OK Notification sent to $($notifResult.recipientCount) participants" -ForegroundColor Green
                    } else {
                        Write-Host "! Notification failed (non-fatal)" -ForegroundColor Yellow
                    }
                } else {
                    Write-Host "Step 3: Skipping notification (no LOGIC_APP_URL or no participants)" -ForegroundColor Yellow
                }
            } else {
                Write-Host ""
                Write-Host "X Failed to extract deployed URL" -ForegroundColor Red
                $exitCode = 1
            }
        }
    }
}
$duration = (Get-Date) - $startTime

Write-Host ""
Write-Host "=============================================" -ForegroundColor DarkGray
Write-Host ""

if ($exitCode -eq 0) {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  FULL PIPELINE COMPLETED SUCCESSFULLY!" -ForegroundColor Green
    Write-Host "  Duration: $($duration.ToString('mm\:ss'))" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
} else {
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "  PIPELINE FAILED (exit code: $exitCode)" -ForegroundColor Red
    Write-Host "  Duration: $($duration.ToString('mm\:ss'))" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
}

# Cleanup env vars
$env:GRAPH_USER_ID = ""
$env:GRAPH_MEETING_ID = ""
$env:GRAPH_TRANSCRIPT_ID = ""
