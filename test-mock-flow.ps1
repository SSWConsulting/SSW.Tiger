# Test Mock Flow - Full pipeline test without Graph API
# Usage: .\test-mock-flow.ps1
#
# Required: Set these environment variables before running:
#   $env:LOGIC_APP_URL = "https://prod-xx.xxx.logic.azure.com:443/workflows/..."
#   $env:MOCK_USER_ID = "your-aad-user-id"  # Get with: az ad signed-in-user show --query id -o tsv
#
# Optional:
#   $env:MOCK_USER_NAME = "Your Name"
#   $env:SKIP_PROCESSOR = "true"  # Skip Claude processing (quick test)

param(
    [switch]$SkipProcessor,
    [string]$TranscriptPath = ".\dropzone\YakShaver - 2026-01-27.vtt",
    [string]$MeetingSubject = "[TestProject] Sprint Review"
)

# Don't stop on stderr (Node.js logs use stderr)
$ErrorActionPreference = "Continue"

# Load .env file if it exists
$envFile = Join-Path $PSScriptRoot ".env"
Write-Host "Looking for .env at: $envFile" -ForegroundColor Gray
if (Test-Path $envFile) {
    Write-Host "Found .env file, loading..." -ForegroundColor Gray
    $loadedCount = 0
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
            $name = $matches[1].Trim()
            $value = $matches[2].Trim()
            # Remove surrounding quotes if present
            $value = $value -replace '^["'']|["'']$', ''
            # Only set if not already set (allow override from command line)
            if (-not [Environment]::GetEnvironmentVariable($name)) {
                [Environment]::SetEnvironmentVariable($name, $value)
                $preview = if ($value.Length -gt 30) { $value.Substring(0, 30) + "..." } else { $value }
                Write-Host "  Set $name = $preview" -ForegroundColor DarkGray
                $loadedCount++
            } else {
                Write-Host "  Skip $name (already set)" -ForegroundColor DarkGray
            }
        }
    }
    Write-Host "Loaded $loadedCount variables from .env" -ForegroundColor Gray
} else {
    Write-Host ".env file not found" -ForegroundColor Yellow
}

Write-Host "=== Mock Flow Test ===" -ForegroundColor Cyan
Write-Host ""

# Check required environment variables
if (-not $env:LOGIC_APP_URL) {
    Write-Host "X LOGIC_APP_URL is required" -ForegroundColor Red
    Write-Host "  Set it with: `$env:LOGIC_APP_URL = '<your-url>'" -ForegroundColor Yellow
    exit 1
}

if (-not $env:MOCK_USER_ID) {
    Write-Host "X MOCK_USER_ID is required (your AAD user ID)" -ForegroundColor Red
    Write-Host "  Get it with: az ad signed-in-user show --query id -o tsv" -ForegroundColor Yellow
    Write-Host "  Set it with: `$env:MOCK_USER_ID = '<your-aad-user-id>'" -ForegroundColor Yellow
    exit 1
}

# Find a transcript file if not specified
if (-not $TranscriptPath) {
    $vttFiles = Get-ChildItem -Path ".\dropzone" -Filter "*.vtt" -ErrorAction SilentlyContinue
    if ($vttFiles) {
        $TranscriptPath = $vttFiles[0].FullName
    } else {
        $vttFiles = Get-ChildItem -Path ".\projects" -Filter "*.vtt" -Recurse -ErrorAction SilentlyContinue
        if ($vttFiles) {
            $TranscriptPath = $vttFiles[0].FullName
        } else {
            Write-Host "X No .vtt files found. Specify -TranscriptPath" -ForegroundColor Red
            exit 1
        }
    }
}

# Convert to absolute path if relative
if (-not [System.IO.Path]::IsPathRooted($TranscriptPath)) {
    $TranscriptPath = Join-Path $PWD $TranscriptPath
}

# Check if file exists
if (-not (Test-Path $TranscriptPath)) {
    Write-Host "X Transcript file not found: $TranscriptPath" -ForegroundColor Red
    exit 1
}

# Set mock environment variables
$env:USE_MOCK_TRANSCRIPT = "true"
$env:MOCK_TRANSCRIPT_PATH = $TranscriptPath
$env:MOCK_MEETING_SUBJECT = $MeetingSubject
$env:MOCK_MEETING_DATE = (Get-Date).ToString("yyyy-MM-dd")
$userName = if ($env:MOCK_USER_NAME) { $env:MOCK_USER_NAME } else { "Test User" }
$env:MOCK_PARTICIPANTS = "[{`"userId`":`"$($env:MOCK_USER_ID)`",`"displayName`":`"$userName`"}]"

Write-Host "Configuration:" -ForegroundColor Green
Write-Host "  Transcript: $TranscriptPath"
Write-Host "  Subject: $MeetingSubject"
Write-Host "  Date: $($env:MOCK_MEETING_DATE)"
Write-Host "  User: $userName ($($env:MOCK_USER_ID.Substring(0, 8))...)"
Write-Host "  Logic App: $($env:LOGIC_APP_URL.Substring(0, 50))..."
Write-Host ""

# Step 1: Download (mock)
Write-Host "Step 1: Testing download-transcript.js (mock mode)..." -ForegroundColor Cyan

# Run node and capture stdout/stderr separately
$pinfo = New-Object System.Diagnostics.ProcessStartInfo
$pinfo.FileName = "node"
$pinfo.Arguments = "download-transcript.js"
$pinfo.RedirectStandardOutput = $true
$pinfo.RedirectStandardError = $true
$pinfo.UseShellExecute = $false
$pinfo.WorkingDirectory = $PWD

$p = New-Object System.Diagnostics.Process
$p.StartInfo = $pinfo
$p.Start() | Out-Null
$stdout = $p.StandardOutput.ReadToEnd()
$stderr = $p.StandardError.ReadToEnd()
$p.WaitForExit()

# Show logs (stderr)
if ($stderr) {
    Write-Host $stderr -ForegroundColor Gray
}

# Parse stdout as JSON
$jsonLine = $stdout.Trim()

if (-not $jsonLine) {
    Write-Host "X Failed to get download result" -ForegroundColor Red
    exit 1
}

$download = $jsonLine | ConvertFrom-Json

if ($download.error) {
    Write-Host "X Download failed: $($download.message)" -ForegroundColor Red
    exit 1
}

if ($download.skipped) {
    Write-Host "! Skipped: $($download.reason)" -ForegroundColor Yellow
    exit 0
}

Write-Host "OK Download successful" -ForegroundColor Green
Write-Host "  Project: $($download.projectName)"
Write-Host "  File: $($download.filename)"
Write-Host "  Participants: $($download.participants.Count)"
Write-Host ""

# Step 2: Processor
if ($SkipProcessor -or $env:SKIP_PROCESSOR -eq "true") {
    Write-Host "Step 2: Skipping processor (quick test mode)" -ForegroundColor Yellow
    $deployedUrl = "https://test-mock-$($download.projectName).surge.sh"
    Write-Host "  Using mock URL: $deployedUrl"
} else {
    Write-Host "Step 2: Running processor.js (this may take several minutes)..." -ForegroundColor Cyan
    Write-Host ""

    # Run processor directly - output streams in real-time
    # Use Tee-Object to both display and capture output
    $tempFile = [System.IO.Path]::GetTempFileName()

    & node processor.js $download.transcriptPath $download.projectName 2>&1 | Tee-Object -FilePath $tempFile
    $processorExitCode = $LASTEXITCODE

    # Read captured output for URL extraction
    $allOutput = Get-Content $tempFile -Raw
    Remove-Item $tempFile -ErrorAction SilentlyContinue

    Write-Host ""

    if ($processorExitCode -ne 0) {
        Write-Host "X Processor failed with exit code $processorExitCode" -ForegroundColor Red
        exit 1
    }

    # Extract deployed URL
    if ($allOutput -match 'DEPLOYED_URL=([^\s"]+)') {
        $deployedUrl = $matches[1]
        Write-Host "OK Dashboard deployed: $deployedUrl" -ForegroundColor Green
    } else {
        Write-Host "X Failed to extract deployed URL from processor output" -ForegroundColor Red
        exit 1
    }
}
Write-Host ""

# Step 3: Send notification
Write-Host "Step 3: Testing send-teams-notification.js..." -ForegroundColor Cyan

$env:DASHBOARD_URL = $deployedUrl
$env:PROJECT_NAME = $download.projectName
$env:MEETING_SUBJECT = $download.meetingSubject
$env:PARTICIPANTS_JSON = ($download.participants | ConvertTo-Json -Compress)

# Run notification script
$pinfo3 = New-Object System.Diagnostics.ProcessStartInfo
$pinfo3.FileName = "node"
$pinfo3.Arguments = "send-teams-notification.js"
$pinfo3.RedirectStandardOutput = $true
$pinfo3.RedirectStandardError = $true
$pinfo3.UseShellExecute = $false
$pinfo3.WorkingDirectory = $PWD

$p3 = New-Object System.Diagnostics.Process
$p3.StartInfo = $pinfo3
$p3.Start() | Out-Null
$notifStdout = $p3.StandardOutput.ReadToEnd()
$notifStderr = $p3.StandardError.ReadToEnd()
$p3.WaitForExit()

# Show logs
if ($notifStderr) {
    Write-Host $notifStderr -ForegroundColor Gray
}

# Check result
if ($notifStdout) {
    $notification = $notifStdout.Trim() | ConvertFrom-Json
    if ($notification.success) {
        Write-Host ""
        Write-Host "========================================" -ForegroundColor Green
        Write-Host "  Full mock flow completed successfully!" -ForegroundColor Green
        Write-Host "  Recipients: $($notification.recipientCount)" -ForegroundColor Green
        Write-Host "  Check your Teams for the notification." -ForegroundColor Green
        Write-Host "========================================" -ForegroundColor Green
    } else {
        Write-Host "! Notification failed: $($notification.message)" -ForegroundColor Yellow
    }
}

# Cleanup mock env vars
Remove-Item Env:USE_MOCK_TRANSCRIPT -ErrorAction SilentlyContinue
Remove-Item Env:MOCK_TRANSCRIPT_PATH -ErrorAction SilentlyContinue
Remove-Item Env:MOCK_MEETING_SUBJECT -ErrorAction SilentlyContinue
Remove-Item Env:MOCK_MEETING_DATE -ErrorAction SilentlyContinue
Remove-Item Env:MOCK_PARTICIPANTS -ErrorAction SilentlyContinue
