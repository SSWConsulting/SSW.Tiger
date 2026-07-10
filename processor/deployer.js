/**
 * Dashboard Deployment (Programmatic)
 *
 * Deployment is handled by code (not by Claude) for reliability:
 * - Deterministic: same code, same result, every time
 * - Fast: direct Node.js, no LLM round-trip
 * - Atomic: blob upload + Cosmos DB persist in one sequence
 * - Observable: structured JSON logs, clear errors, exit codes
 *
 * Azure pipeline:  processor/index.js → deployer.js (automatic)
 * Local scripted:  processor/deploy-local.js → deployer.js (one command)
 * Local interactive: deploy-dashboard skill → deploy-local.js → deployer.js
 *
 * Obfuscated-URL security model (per-project obfuscateUrls setting):
 * - A GUID URL is an UNGUESSABLE / undiscoverable link, not access control. The
 *   GUID is effectively a bearer token: anyone it reaches (via a forwarded link,
 *   Referer header, link-unfurl preview, or browser history) can open the
 *   dashboard. This is the confidentiality level issue #72 asked for; it is not
 *   authentication. Do not describe an obfuscated dashboard as "private" in the
 *   auth sense.
 * - It also assumes the $web static-website container does NOT permit anonymous
 *   blob LISTING (Azure default: container public-access = off; blobs are served
 *   by GET via the web endpoint but cannot be enumerated). If a container were
 *   ever set to public "Container" access, every GUID could be listed and the
 *   feature defeated. See infra/modules/dashboardStorage.bicep.
 */

const crypto = require("crypto");
const fs = require("fs").promises;
const os = require("os");
const path = require("path");
const { log } = require("../lib/logger");
const {
  upsertMeeting,
  queryMeetings,
  getMeeting,
  getProjectSettings,
} = require("../lib/cosmosClient");
const { mergeCurrentMeeting, renderProjectIndex } = require("./projectIndex");

// Matches a v4-style UUID, used to detect an already-obfuscated storage path
// so re-processing a meeting keeps the same non-guessable URL.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pure decision: which path segment does a meeting deploy under?
 *
 * Human-readable (default): the meetingId (e.g. "2026-04-03").
 * Obfuscated: a GUID. To keep the URL stable across re-processing / restarts,
 * a prior GUID is reused if the meeting's existing dashboardPath already ends
 * in one; otherwise a fresh GUID is generated.
 *
 * @param {Object} params
 * @param {boolean} params.obfuscateUrls
 * @param {string}  params.meetingId
 * @param {string} [params.priorDashboardPath] - e.g. "crm/<guid>" from Cosmos
 * @returns {{ slug: string, obfuscated: boolean }}
 */
function chooseSlug({ obfuscateUrls, meetingId, priorDashboardPath }) {
  if (!obfuscateUrls) {
    return { slug: meetingId, obfuscated: false };
  }

  const priorSlug = priorDashboardPath ? priorDashboardPath.split("/").pop() : null;
  if (priorSlug && UUID_RE.test(priorSlug)) {
    return { slug: priorSlug, obfuscated: true };
  }

  return { slug: crypto.randomUUID(), obfuscated: true };
}

/**
 * Resolve the deploy slug, reading the project setting and any prior GUID from
 * Cosmos. Wraps the pure chooseSlug() with the I/O.
 *
 * The settings read is intentionally NOT wrapped in a try/catch: getProjectSettings
 * fails closed (throws) on an ambiguous Cosmos error, and that propagates here to
 * abort the deploy rather than silently downgrade an obfuscated project to a
 * guessable URL. The prior-GUID lookup, by contrast, IS best-effort - if it fails
 * we just mint a fresh GUID, which is still obfuscated (safe direction).
 *
 * @param {Object} params
 * @param {string} params.projectName
 * @param {string} params.meetingId
 * @param {Object} [deps] - injectable Cosmos accessors (for testing)
 * @returns {Promise<{ slug: string, obfuscated: boolean }>}
 */
async function resolveDeploySlug(
  { projectName, meetingId },
  { getProjectSettings: getSettings = getProjectSettings, getMeeting: getMtg = getMeeting } = {},
) {
  const { obfuscateUrls } = await getSettings(projectName);

  let priorDashboardPath = null;
  if (obfuscateUrls && process.env.COSMOS_ENDPOINT) {
    try {
      const existing = await getMtg(projectName, meetingId);
      priorDashboardPath = existing?.dashboardPath || null;
    } catch (err) {
      log("warn", "Could not look up existing meeting for stable GUID, generating new", {
        error: err.message,
      });
    }
  }

  return chooseSlug({ obfuscateUrls, meetingId, priorDashboardPath });
}

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

  const dashboardDir = path.dirname(dashboardPath);

  // Choose the path segment: meetingId (human-readable) or a GUID (obfuscated,
  // per the project's obfuscateUrls setting).
  const { slug, obfuscated } = await resolveDeploySlug({ projectName, meetingId });

  const blobDestination = `$web/${projectName}/${slug}`;

  log("info", "Deploying dashboard to blob storage", {
    storageAccount,
    destination: blobDestination,
    obfuscated,
  });

  const { execFileSync } = require("child_process");
  const isWindows = process.platform === "win32";
  const azureClientId = process.env.AZURE_CLIENT_ID;

  // Login with managed identity
  if (azureClientId) {
    log("info", "Logging in with managed identity", { clientId: azureClientId });
    try {
      execFileSync("az", ["login", "--identity", "--client-id", azureClientId], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        shell: isWindows,
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
    execFileSync("az", [
      "storage", "blob", "upload-batch",
      "--source", dashboardDir,
      "--destination", blobDestination,
      "--account-name", storageAccount,
      "--auth-mode", "login",
      "--overwrite",
    ], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], shell: isWindows });
  } catch (err) {
    log("error", "Blob upload failed", { stderr: err.stderr });
    throw err;
  }

  // Build the dashboard URL
  let host = process.env.DASHBOARD_BASE_URL;
  if (!host) {
    try {
      host = execFileSync("az", [
        "storage", "account", "show",
        "--name", storageAccount,
        "--query", "primaryEndpoints.web",
        "-o", "tsv",
      ], { encoding: "utf-8", shell: isWindows }).trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
    } catch {
      host = `${storageAccount}.z8.web.core.windows.net`;
      log("warn", "Could not query storage account, using fallback hostname", { host });
    }
  }

  const storagePath = `${projectName}/${slug}`;
  const deployedUrl = `https://${host}/${storagePath}`;
  log("info", "Dashboard deployed", { url: deployedUrl, obfuscated });
  return { deployedUrl, dashboardPath: storagePath, obfuscated };
}

/**
 * Persist meeting metadata and consolidated JSON to Cosmos DB.
 */
async function persistToCosmos({ projectName, meetingId, meetingDate, dashboardPath, meetingPath }) {
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
    dashboardPath,
    consolidated,
    metadata,
  });

  log("info", "Persisted meeting to Cosmos DB", { id: result.id });
  return result;
}

/**
 * Delete any existing public index page for a project ({project}/index.html in
 * the $web static-website container). Used when a project is obfuscated, so a
 * page published before opt-in (e.g. by the per-project index feature) stops
 * being reachable and can no longer list historical meetings.
 *
 * Idempotent: a missing blob is treated as success. Best-effort - a failure is
 * logged, not thrown, since the caller already treats index maintenance as
 * non-fatal, and every subsequent obfuscated deploy retries the delete.
 */
async function removeProjectIndex({ projectName, storageAccount }) {
  const blobName = `${projectName}/index.html`;
  const { execFileSync } = require("child_process");
  const isWindows = process.platform === "win32";
  try {
    execFileSync("az", [
      "storage", "blob", "delete",
      "--container-name", "$web",
      "--name", blobName,
      "--account-name", storageAccount,
      "--auth-mode", "login",
    ], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], shell: isWindows });
    log("info", "Removed existing project index for obfuscated project", { blobName });
  } catch (err) {
    const stderr = String(err.stderr || "");
    if (/BlobNotFound|does not exist/i.test(stderr)) {
      log("info", "No existing project index to remove for obfuscated project", { blobName });
    } else {
      log("warn", "Could not remove existing project index (non-fatal)", { blobName, stderr });
    }
  }
}

/**
 * Generate and deploy the per-project index page listing all meeting
 * dashboards, so https://{host}/{project}/ shows a landing page.
 *
 * Meeting list comes from Cosmos DB; the just-deployed meeting is merged
 * in so the index is complete even if persistence failed or was skipped.
 *
 * Must run after deployDashboard in the same process — it reuses the
 * az CLI session established there (no separate login).
 *
 * For obfuscated projects the index is not just skipped, it is actively
 * removed: any existing {project}/index.html (e.g. one published before the
 * project was opted in) is deleted, because a stale public list of every prior
 * meeting and its guessable URL would defeat the setting. Then null is returned.
 * The caller may pass `obfuscate` explicitly; if omitted it is looked up from
 * the project's settings so the guard holds either way.
 *
 * @returns {string|null} deployed index URL (null when suppressed)
 */
async function deployProjectIndex({ projectName, displayName, currentMeeting, obfuscate }) {
  const storageAccount = process.env.DASHBOARD_STORAGE_ACCOUNT;
  if (!storageAccount) {
    throw new Error("DASHBOARD_STORAGE_ACCOUNT not set");
  }

  const isObfuscated =
    obfuscate !== undefined
      ? obfuscate
      : (await getProjectSettings(projectName)).obfuscateUrls;
  if (isObfuscated) {
    await removeProjectIndex({ projectName, storageAccount });
    return null;
  }

  // Gather the project's meetings
  let meetings = [];
  if (process.env.COSMOS_ENDPOINT) {
    try {
      meetings = await queryMeetings({ projectName, excludeConsolidated: true });
    } catch (err) {
      log("warn", "Could not query meetings for project index, using current meeting only", {
        error: err.message,
      });
    }
  }
  meetings = mergeCurrentMeeting(meetings, currentMeeting);

  // Render from template
  const templatePath = path.join(__dirname, "..", "templates", "project-index.html");
  const template = await fs.readFile(templatePath, "utf-8");
  const html = renderProjectIndex({
    template,
    displayName: displayName || projectName,
    meetings,
    generatedAt: new Date().toISOString(),
  });

  const localPath = path.join(os.tmpdir(), `tiger-project-index-${projectName}.html`);
  await fs.writeFile(localPath, html, "utf-8");

  // Upload as {project}/index.html in the static website container
  const blobName = `${projectName}/index.html`;
  log("info", "Deploying project index to blob storage", {
    storageAccount,
    blobName,
    meetingCount: meetings.length,
  });

  const { execFileSync } = require("child_process");
  const isWindows = process.platform === "win32";
  try {
    execFileSync("az", [
      "storage", "blob", "upload",
      "--file", localPath,
      "--container-name", "$web",
      "--name", blobName,
      "--account-name", storageAccount,
      "--auth-mode", "login",
      "--content-type", "text/html; charset=utf-8",
      "--overwrite",
    ], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], shell: isWindows });
  } catch (err) {
    log("error", "Project index upload failed", { stderr: err.stderr });
    throw err;
  }

  const host = process.env.DASHBOARD_BASE_URL;
  const indexUrl = host ? `https://${host.replace(/^https?:\/\//, "").replace(/\/$/, "")}/${projectName}/` : `/${projectName}/`;
  log("info", "Project index deployed", { url: indexUrl });
  return indexUrl;
}

module.exports = {
  checkOutputExists,
  copyToOutputDirectory,
  deployDashboard,
  persistToCosmos,
  deployProjectIndex,
  chooseSlug,
  resolveDeploySlug,
  UUID_RE,
};
