const fs = require("fs").promises;
const path = require("path");
const { log } = require("../lib/logger");
const { upsertMeeting } = require("../lib/cosmosClient");

/**
 * Check that the dashboard HTML exists at the canonical location.
 * Falls back to output directory.
 *
 * @returns {string} path to the dashboard HTML
 */
async function checkOutputExists({ meetingPath, outputDir, projectName, meetingId }) {
  const primaryPath = path.join(meetingPath, "dashboard", "index.html");
  const fallbackPath = path.join(outputDir, `${projectName}-${meetingId}.html`);

  try {
    await fs.access(primaryPath);
    return primaryPath;
  } catch (error) {
    try {
      await fs.access(fallbackPath);
      log("warn", "Dashboard not in canonical location, using fallback");
      return fallbackPath;
    } catch (fallbackError) {
      throw new Error(`Dashboard not found: ${primaryPath}`);
    }
  }
}

/**
 * Copy dashboard to the output directory for convenience.
 */
async function copyToOutputDirectory({ sourcePath, outputDir, projectName, meetingId }) {
  if (!outputDir) return null;

  try {
    await fs.mkdir(outputDir, { recursive: true });
    const outputFilename = `${projectName}-${meetingId}.html`;
    const outputPath = path.join(outputDir, outputFilename);
    await fs.copyFile(sourcePath, outputPath);
    return outputPath;
  } catch (error) {
    return null;
  }
}

/**
 * Deploy dashboard to Azure Blob Storage.
 *
 * @returns {string} deployed URL
 */
async function deployDashboard({ dashboardPath, projectName, meetingId }) {
  const storageAccount = process.env.DASHBOARD_STORAGE_ACCOUNT;
  if (!storageAccount) {
    throw new Error("DASHBOARD_STORAGE_ACCOUNT not set");
  }

  const blobDestination = `'$web/${projectName}/${meetingId}'`;
  const dashboardDir = path.dirname(dashboardPath);

  log("info", "Deploying dashboard to blob storage", {
    storageAccount,
    destination: blobDestination,
  });

  const { execSync } = require("child_process");
  const azureClientId = process.env.AZURE_CLIENT_ID;

  // Login with managed identity
  if (azureClientId) {
    log("info", "Logging in with managed identity", { clientId: azureClientId });
    try {
      execSync(`az login --identity --client-id ${azureClientId}`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      log("error", "az login --identity failed", { stderr: err.stderr });
      throw new Error(`az login --identity failed: ${err.stderr}`);
    }
  } else {
    log("warn", "AZURE_CLIENT_ID not set, assuming az is already logged in");
  }

  // Upload dashboard files
  try {
    execSync(
      `az storage blob upload-batch --source "${dashboardDir}" --destination ${blobDestination} --account-name ${storageAccount} --auth-mode login --overwrite`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch (err) {
    log("error", "Blob upload failed", { stderr: err.stderr });
    throw err;
  }

  // Build the dashboard URL
  let host = process.env.DASHBOARD_BASE_URL;
  if (!host) {
    try {
      host = execSync(
        `az storage account show --name ${storageAccount} --query "primaryEndpoints.web" -o tsv`,
        { encoding: "utf-8" },
      ).trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
    } catch {
      host = `${storageAccount}.z8.web.core.windows.net`;
      log("warn", "Could not query storage account, using fallback hostname", { host });
    }
  }

  const deployedUrl = `https://${host}/${projectName}/${meetingId}`;
  log("info", "Dashboard deployed", { url: deployedUrl });
  return deployedUrl;
}

/**
 * Persist meeting metadata and consolidated JSON to Cosmos DB.
 */
async function persistToCosmos({ projectName, meetingId, meetingDate, deployedUrl, meetingPath }) {
  const consolidatedPath = path.join(meetingPath, "analysis", "consolidated.json");

  let consolidated = null;
  try {
    const raw = await fs.readFile(consolidatedPath, "utf-8");
    consolidated = JSON.parse(raw);
  } catch (err) {
    log("warn", "Could not read consolidated.json, persisting without it", {
      error: err.message,
    });
  }

  const metadata = {};
  if (consolidated) {
    metadata.participantCount = consolidated.participants?.length ?? null;
    metadata.totalDurationMinutes = consolidated.meetingDuration?.totalMinutes ?? null;
    metadata.topicsCount = consolidated.topics?.length ?? null;
    metadata.actionItemsCount = consolidated.actionItems?.length ?? null;
  }

  const result = await upsertMeeting({
    projectName,
    meetingId,
    meetingDate,
    dashboardUrl: deployedUrl,
    consolidated,
    metadata,
  });

  log("info", "Persisted meeting to Cosmos DB", { id: result.id });
  return result;
}

module.exports = { checkOutputExists, copyToOutputDirectory, deployDashboard, persistToCosmos };
