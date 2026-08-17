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
const { validateCredentials, invokeClaude, hasConsolidatedAnalysis } = require("./claudeRunner");
const { checkOutputExists, copyToOutputDirectory, deployDashboard, persistToCosmos, deployProjectIndex } = require("./deployer");
const { validateAndRepairDashboard } = require("./dashboardValidator");
const { publishTranscript } = require("./transcriptHubPublisher");

const ROOT_DIR = path.join(__dirname, "..");
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(ROOT_DIR, "output");

// Failure causes worth one automatic in-process retry. These are recoverable
// because the analysis artefacts survive on disk in the same replica, so the
// retry only has to redo dashboard generation (see GitHub issue #149).
// A Container App Job-level retry cannot do this - it starts a fresh replica
// with an empty filesystem and would re-run all 5 analysis agents from scratch.
const RETRYABLE_FAILURES = new Set(["output_token_limit", "api_retry_stall"]);

/**
 * Run Claude, and on a recoverable failure retry once. The retry skips the
 * analysis phase when consolidated.json already exists on disk.
 */
async function invokeClaudeWithRetry(params) {
  try {
    return await invokeClaude(params);
  } catch (error) {
    if (!RETRYABLE_FAILURES.has(error.failureReason)) throw error;

    const canResume = await hasConsolidatedAnalysis(params.meetingPath);

    log("warn", "Claude CLI failed with a recoverable error, retrying once", {
      meetingId: params.meetingId,
      failureReason: error.failureReason,
      stage: error.stage,
      // Without consolidated.json the retry has to redo the analysis agents too
      resumeDashboardOnly: canResume,
    });

    // No backoff: the cause is structural, not transient, so waiting changes
    // nothing. The retry differs by prompt, not by timing.
    return await invokeClaude({ ...params, resumeDashboardOnly: canResume });
  }
}

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

  // Archive the raw transcript to the hub repo (non-fatal, opt-in).
  // Runs before analysis so the .vtt survives even if the pipeline dies.
  try {
    const hubResult = await publishTranscript({
      transcriptPath: resolvedPath,
      projectSlug,
      meetingId,
    });
    if (hubResult.published) {
      log("info", "Raw transcript published to hub", { path: hubResult.path });
    } else if (hubResult.reason !== "disabled") {
      log("info", "Transcript hub publish skipped", { reason: hubResult.reason });
    }
  } catch (err) {
    log("error", "Failed to publish transcript to hub (non-fatal)", {
      error: err.message,
    });
  }

  // Invoke Claude Code CLI (uses display name for human-readable prompt)
  await invokeClaudeWithRetry({
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

  // Guard against syntax errors in inline <script> blocks (mainly the
  // tailwind.config block, which the model has been observed to corrupt
  // in rare regenerations - see GitHub issue #98).
  try {
    await validateAndRepairDashboard(
      canonicalPath,
      path.join(ROOT_DIR, "templates", "dashboard.html"),
    );
  } catch (err) {
    log("warn", "Dashboard validation step failed (non-fatal)", { error: err.message });
  }

  // Deploy to Azure Blob Storage
  const {
    deployedUrl,
    dashboardPath: storagePath,
    passwordProtected,
    dashboardPassword,
  } = await deployDashboard({
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

  // Update the per-project index page (non-fatal)
  try {
    await deployProjectIndex({
      projectName: projectSlug,
      displayName,
      currentMeeting: { meetingId, meetingDate },
    });
  } catch (err) {
    log("error", "Failed to deploy project index (non-fatal)", {
      error: err.message,
    });
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
    passwordProtected,
    dashboardPassword,
  };
}

async function writeProcessorResult(result) {
  if (!process.env.PROCESSOR_RESULT_PATH) return;

  const payload = {
    passwordProtected: !!result.passwordProtected,
    dashboardPassword: result.dashboardPassword || "",
  };

  await fs.writeFile(
    process.env.PROCESSOR_RESULT_PATH,
    JSON.stringify(payload),
    "utf-8",
  );
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
    await writeProcessorResult(result);
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
