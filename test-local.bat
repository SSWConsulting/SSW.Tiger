@echo off
REM ============================================================================
REM Local Testing Script for Meeting Processor
REM ============================================================================

echo.
echo ============================================================================
echo TIGER Meeting Processor - Local Test
echo ============================================================================
echo.

REM Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js is not installed. Please install Node.js first.
    echo Download from: https://nodejs.org/
    pause
    exit /b 1
)

REM Check if Claude CLI is installed
where claude >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Claude CLI is not installed.
    echo Install with: npm install -g @anthropic-ai/claude-cli
    pause
    exit /b 1
)

REM Check if transcript file is provided
if "%~1"=="" (
    echo [ERROR] No transcript file provided.
    echo.
    echo Usage: test-local.bat ^<transcript-file^> ^<project-name^>
    echo Example: test-local.bat dropzone\meeting.vtt yakshaver
    echo.
    pause
    exit /b 1
)

REM Check if project name is provided
if "%~2"=="" (
    echo [ERROR] No project name provided.
    echo.
    echo Usage: test-local.bat ^<transcript-file^> ^<project-name^>
    echo Example: test-local.bat dropzone\meeting.vtt yakshaver
    echo.
    pause
    exit /b 1
)

REM Check if transcript file exists
if not exist "%~1" (
    echo [ERROR] Transcript file not found: %~1
    pause
    exit /b 1
)

REM Set Claude Code subscription (uses your logged-in session)
REM No need to set CLAUDE_SUBSCRIPTION_TOKEN - Claude CLI handles it automatically
echo [INFO] Using Claude Code subscription from your logged-in session
echo.

REM Optional: Set Surge credentials if you want deployment
REM Uncomment and fill in if you want to deploy to surge.sh
REM set SURGE_LOGIN=your-email@example.com
REM set SURGE_TOKEN=your-surge-token

REM Set output directory
set OUTPUT_DIR=%CD%\output

echo [INFO] Configuration:
echo   - Transcript: %~1
echo   - Project: %~2
echo   - Output: %OUTPUT_DIR%
echo   - Auth: Claude Code Subscription (auto-detected)
echo.
echo [INFO] Starting processing...
echo ============================================================================
echo.

REM Run the processor
node processor.js "%~1" "%~2"

set EXIT_CODE=%ERRORLEVEL%

echo.
echo ============================================================================
if %EXIT_CODE% EQU 0 (
    echo [SUCCESS] Processing completed!
    echo Check the output directory: %OUTPUT_DIR%
) else (
    echo [ERROR] Processing failed with exit code %EXIT_CODE%
    echo Check error.log for details
)
echo ============================================================================
echo.

pause
exit /b %EXIT_CODE%
