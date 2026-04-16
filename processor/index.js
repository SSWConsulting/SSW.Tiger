#!/usr/bin/env node

/**
 * Meeting Transcript Processor - Orchestrator
 *
 * Coordinates the pipeline: setup → Claude analysis → deploy → persist.
 *
 * Usage:
 *   node processor/index.js <transcript-file-path> <project-name>
 *
 * Example:
 *   node processor/index.js ./dropzone/2026-01-22-094557.vtt yakshaver
 *
 * Exit Codes: 0 = success, 1 = error
 */

const fs = require("fs").promises;
const path = require("path");
const { log } = require("../lib/logger");
const { validateTranscriptFilename, setupProjectStructure } = require("./projectSetup");
const { validateCredentials, invokeClaude } = require("./claudeRunner");
const { checkOutputExists, copyToOutputDirectory, deployDashboard, persistToCosmos } = require("./deployer");

const ROOT_DIR = path.join(__dirname, "..");
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(ROOT_DIR, "output");

async function processTranscript(transcriptPath, projectSlug) {
  // Validate credentials first (fail fast)
  validateCredentials();

  // Validate transcript file exists
  try {
    await fs.access(transcriptPath);
  } catch (error) {
    throw new Error(`Transcript file not found: ${transcriptPath}`);
  }

  // Parse meeting info from filename
  const resolvedPath = path.resolve(transcriptPath);
  const { meetingId, meetingDate, meetingTime } = validateTranscriptFilename(resolvedPath);
  // Display name for Claude prompt / notifications (from env, set by entrypoint.sh)
  const displayName = process.env.PROJECT_NAME || projectSlug;
  const projectPath = path.join(ROOT_DIR, "projects", projectSlug);
  const meetingPath = path.join(projectPath, meetingId);

  log("debug", "Initialized", { meetingId, meetingDate, meetingTime });

  // Setup project structure
  await setupProjectStructure({ meetingPath, transcriptPath: resolvedPath });

  // Invoke Claude Code CLI (uses display name for human-readable prompt)
  await invokeClaude({
    projectName: displayName,
    projectSlug,
    meetingId,
    meetingDate,
    meetingPath,
    outputDir: OUTPUT_DIR,
    rootDir: ROOT_DIR,
  });

  // Check output exists
  const canonicalPath = await checkOutputExists({
    meetingPath,
    outputDir: OUTPUT_DIR,
    projectName: projectSlug,
    meetingId,
  });

  // Deploy to Azure Blob Storage
  const { deployedUrl, dashboardPath: storagePath } = await deployDashboard({
    dashboardPath: canonicalPath,
    projectName: projectSlug,
    meetingId,
  });

  // Persist to Cosmos DB (non-fatal)
  if (process.env.COSMOS_ENDPOINT) {
    try {
      await persistToCosmos({
        projectName: projectSlug,
        meetingId,
        meetingDate,
        dashboardPath: storagePath,
        meetingPath,
      });
    } catch (err) {
      log("error", "Failed to persist to Cosmos DB (non-fatal)", {
        error: err.message,
      });
    }
  } else {
    log("warn", "COSMOS_ENDPOINT not set, skipping Cosmos DB persistence");
  }

  // Copy to output directory for convenience
  const outputCopyPath = await copyToOutputDirectory({
    sourcePath: canonicalPath,
    outputDir: OUTPUT_DIR,
    projectName: projectSlug,
    meetingId,
  });

  return {
    success: true,
    meetingId,
    meetingDate,
    dashboardPath: canonicalPath,
    outputCopyPath,
    deployedUrl,
  };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error(
      "Usage: node processor/index.js <transcript-file-path> <project-name>",
    );
    console.error(
      "Example: node processor/index.js ./transcripts/2026-01-22-094557.vtt yakshaver",
    );
    console.error(
      "\nNote: For Azure/Graph API mode, use entrypoint.sh which handles transcript download",
    );
    process.exit(1);
  }

  const [transcriptPath, projectName] = args;

  try {
    const result = await processTranscript(transcriptPath, projectName);
    console.error(
      JSON.stringify({
        level: "info",
        message: "Processing completed",
        meetingId: result.meetingId,
      }),
    );
    if (result.deployedUrl) {
      console.log(`DEPLOYED_URL=${result.deployedUrl}`);
    }
    process.exit(0);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Processing failed",
        error: error.message,
      }),
    );
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { processTranscript };
