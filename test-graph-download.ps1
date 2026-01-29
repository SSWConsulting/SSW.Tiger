# Test Graph API Transcript Download (Non-Mock Mode)
# Tests all functions in download-transcript.js with real Graph API
#
# Usage: .\test-graph-download.ps1 -UserId <user-id> -MeetingId <meeting-id> -TranscriptId <transcript-id>
#
# Prerequisites:
# - .env file with GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, GRAPH_TENANT_ID
# - Application Access Policy configured by Teams Admin

param(
    [Parameter(Mandatory=$true)]
    [string]$UserId,

    [Parameter(Mandatory=$true)]
    [string]$MeetingId,

    [Parameter(Mandatory=$true)]
    [string]$TranscriptId
)

$ErrorActionPreference = "Continue"

Write-Host "=== Graph API Transcript Download Test (Non-Mock) ===" -ForegroundColor Cyan
Write-Host ""

# Load .env file
$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path $envFile) {
    Write-Host "Loading .env file..." -ForegroundColor Gray
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
            $name = $matches[1].Trim()
            $value = $matches[2].Trim() -replace '^["'']|["'']$', ''
            [Environment]::SetEnvironmentVariable($name, $value)
        }
    }
    Write-Host "OK .env loaded" -ForegroundColor Green
} else {
    Write-Host "X .env file not found at $envFile" -ForegroundColor Red
    exit 1
}

# Check required Graph API env vars
$required = @("GRAPH_CLIENT_ID", "GRAPH_CLIENT_SECRET", "GRAPH_TENANT_ID")
$missing = $required | Where-Object { -not [Environment]::GetEnvironmentVariable($_) }
if ($missing) {
    Write-Host "X Missing required environment variables in .env:" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}

# Set the Graph API parameters for download-transcript.js
$env:GRAPH_USER_ID = $UserId
$env:GRAPH_MEETING_ID = $MeetingId
$env:GRAPH_TRANSCRIPT_ID = $TranscriptId

# Ensure mock mode is OFF
$env:USE_MOCK_TRANSCRIPT = ""

Write-Host ""
Write-Host "Configuration:" -ForegroundColor Green
Write-Host "  GRAPH_CLIENT_ID: $($env:GRAPH_CLIENT_ID.Substring(0, 8))..."
Write-Host "  GRAPH_TENANT_ID: $($env:GRAPH_TENANT_ID.Substring(0, 8))..."
Write-Host "  GRAPH_USER_ID: $UserId"
Write-Host "  GRAPH_MEETING_ID: $($MeetingId.Substring(0, [Math]::Min(30, $MeetingId.Length)))..."
Write-Host "  GRAPH_TRANSCRIPT_ID: $($TranscriptId.Substring(0, [Math]::Min(30, $TranscriptId.Length)))..."
Write-Host ""

# Run download-transcript.js (non-mock mode)
# This will test: getGraphToken, fetchMeeting, downloadTranscript, parseSubject,
#                 extractProjectName, generateFilename, matchesMeetingFilter, saveTranscript
Write-Host "Running download-transcript.js (non-mock mode)..." -ForegroundColor Cyan
Write-Host "Testing: getGraphToken, fetchMeeting, downloadTranscript, parseSubject," -ForegroundColor Gray
Write-Host "         extractProjectName, generateFilename, matchesMeetingFilter, saveTranscript" -ForegroundColor Gray
Write-Host ""

# Run with stderr going to console, stdout captured
$pinfo = New-Object System.Diagnostics.ProcessStartInfo
$pinfo.FileName = "node"
$pinfo.Arguments = "download-transcript.js"
$pinfo.RedirectStandardOutput = $true
$pinfo.RedirectStandardError = $true
$pinfo.UseShellExecute = $false
$pinfo.WorkingDirectory = $PWD

$process = New-Object System.Diagnostics.Process
$process.StartInfo = $pinfo
$process.Start() | Out-Null

# Read stderr and display in real-time (logs)
$stderr = $process.StandardError.ReadToEnd()
$stdout = $process.StandardOutput.ReadToEnd()
$process.WaitForExit()
$exitCode = $process.ExitCode

# Show logs
if ($stderr) {
    Write-Host $stderr -ForegroundColor Gray
}

$output = $stdout

Write-Host ""

if ($exitCode -eq 0) {
    # Parse the JSON result from stdout
    $jsonLine = $output.Trim()

    if ($jsonLine) {
        $result = $jsonLine | ConvertFrom-Json

        if ($result.skipped) {
            Write-Host "========================================" -ForegroundColor Yellow
            Write-Host "  Meeting skipped (filter not matched)" -ForegroundColor Yellow
            Write-Host "  Reason: $($result.reason)" -ForegroundColor Yellow
            Write-Host "========================================" -ForegroundColor Yellow
        } else {
            Write-Host "========================================" -ForegroundColor Green
            Write-Host "  SUCCESS! All functions working." -ForegroundColor Green
            Write-Host "========================================" -ForegroundColor Green
            Write-Host ""
            Write-Host "Results:" -ForegroundColor Cyan
            Write-Host "  Transcript Path: $($result.transcriptPath)"
            Write-Host "  Project Name: $($result.projectName)"
            Write-Host "  Meeting Date: $($result.meetingDate)"
            Write-Host "  Filename: $($result.filename)"
            Write-Host "  Meeting Subject: $($result.meetingSubject)"
            Write-Host "  Participants: $($result.participants.Count)"
        }
    }
} else {
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "  FAILED (exit code: $exitCode)" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "Check the output above for error details." -ForegroundColor Yellow
    Write-Host "Common issues:" -ForegroundColor Yellow
    Write-Host "  - Application Access Policy not configured" -ForegroundColor Gray
    Write-Host "  - Invalid meeting/transcript IDs" -ForegroundColor Gray
    Write-Host "  - Graph API credentials incorrect" -ForegroundColor Gray
}

# Cleanup env vars
$env:GRAPH_USER_ID = ""
$env:GRAPH_MEETING_ID = ""
$env:GRAPH_TRANSCRIPT_ID = ""
