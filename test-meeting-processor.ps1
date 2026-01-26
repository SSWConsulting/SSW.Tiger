param(
  [string]$Transcript = "2026-01-21.vtt",
  [string]$Project = "yakshaver"
)

$ErrorActionPreference = "Stop"

Write-Host "=== Docker Environment Check ==="
docker --version
docker-compose --version

Write-Host "=== Checking .env ==="
if (!(Test-Path ".env")) {
  Write-Error ".env file not found. Please create one with Claude & Surge credentials."
  exit 1
}

Write-Host "=== Checking dropzone ==="
if (!(Test-Path "./dropzone/$Transcript")) {
  Write-Error "Transcript not found: ./dropzone/$Transcript"
  exit 1
}

Write-Host "=== Building Image ==="
docker-compose build --no-cache

Write-Host "=== CLI Sanity Check (override entrypoint) ==="
docker-compose run --rm --entrypoint node meeting-processor -v
docker-compose run --rm --entrypoint claude meeting-processor --version
docker-compose run --rm --entrypoint surge meeting-processor --version

Write-Host "=== Environment Variables Inside Container ==="
docker-compose run --rm --entrypoint env meeting-processor `
  | findstr /R "NODE_ENV CLAUDE ANTHROPIC SURGE"

Write-Host "=== Running End-to-End Meeting Processing ==="
docker-compose run --rm meeting-processor `
  "/app/dropzone/$Transcript" `
  $Project

Write-Host "=== SUCCESS ==="