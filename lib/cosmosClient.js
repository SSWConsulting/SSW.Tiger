/**
 * Cosmos DB Client for Tiger Meeting Dashboards
 *
 * Persists meeting metadata and consolidated analysis to Cosmos DB.
 * Uses Serverless throughput (pay-per-request) for cost efficiency.
 *
 * Auth: Uses DefaultAzureCredential (managed identity in Azure, az login locally).
 *
 * Required env vars:
 *   COSMOS_ENDPOINT  - e.g. https://tiger-cosmos.documents.azure.com:443/
 *
 * Optional env vars:
 *   COSMOS_DATABASE           - database name (default: "tiger")
 *   COSMOS_CONTAINER          - container name (default: "meetings")
 *   COSMOS_PROJECTS_CONTAINER - per-project settings container (default: "projects")
 */

// Polyfill globalThis.crypto for @azure/identity in Node.js environments
// where the Web Crypto API isn't globally available
if (!globalThis.crypto) {
  globalThis.crypto = require("crypto");
}

const { CosmosClient } = require("@azure/cosmos");
const { DefaultAzureCredential } = require("@azure/identity");

const { sanitizeId } = require("./sanitize");

const DB_NAME = process.env.COSMOS_DATABASE || "tiger";
const CONTAINER_NAME = process.env.COSMOS_CONTAINER || "meetings";
const PROJECTS_CONTAINER_NAME = process.env.COSMOS_PROJECTS_CONTAINER || "projects";

// Default per-project settings, used when Cosmos is unavailable or the
// project has no settings document yet. Human-readable URLs stay the default,
// so behaviour is unchanged unless a project is explicitly opted in.
const DEFAULT_PROJECT_SETTINGS = { obfuscateUrls: false };

let _client = null;
let _container = null;
let _projectsContainer = null;

/**
 * Get the shared Cosmos DB client (lazy singleton).
 * Database and containers are created by the post-deploy script (setup-cosmos.sh) —
 * this just connects.
 */
function getClient() {
  if (_client) return _client;

  const endpoint = process.env.COSMOS_ENDPOINT;

  if (!endpoint) {
    throw new Error(
      "COSMOS_ENDPOINT is required. Set it to your Cosmos DB account endpoint.",
    );
  }

  _client = new CosmosClient({
    endpoint,
    aadCredentials: new DefaultAzureCredential(),
  });

  return _client;
}

/**
 * Get the meetings container (lazy singleton).
 */
function getContainer() {
  if (_container) return _container;
  _container = getClient().database(DB_NAME).container(CONTAINER_NAME);
  return _container;
}

/**
 * Get the per-project settings container (lazy singleton).
 */
function getProjectsContainer() {
  if (_projectsContainer) return _projectsContainer;
  _projectsContainer = getClient().database(DB_NAME).container(PROJECTS_CONTAINER_NAME);
  return _projectsContainer;
}

/**
 * Upsert a meeting record to Cosmos DB.
 *
 * @param {Object} params
 * @param {string} params.projectName    - e.g. "yakshaver"
 * @param {string} params.meetingId      - e.g. "2026-01-22-094557"
 * @param {string} params.meetingDate    - e.g. "2026-01-22"
 * @param {string} params.dashboardPath  - path relative to storage root (e.g. "general/2026-01-22")
 * @param {Object} params.consolidated   - full consolidated.json content
 * @param {Object} [params.metadata]     - optional extra metadata
 * @returns {Object} the upserted document
 */
async function upsertMeeting({
  projectName,
  meetingId,
  meetingDate,
  dashboardPath,
  consolidated,
  metadata = {},
}) {
  const missing = [
    !projectName && "projectName",
    !meetingId && "meetingId",
    !meetingDate && "meetingDate",
    !dashboardPath && "dashboardPath",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(`upsertMeeting: missing required fields: ${missing.join(", ")}`);
  }

  const container = getContainer();

  const sanitizedProject = sanitizeId(projectName) || "general";
  const sanitizedMeetingId = sanitizeId(meetingId);

  const document = {
    id: `${sanitizedProject}-${sanitizedMeetingId}`,
    projectName: sanitizedProject,
    meetingId,
    meetingDate,
    dashboardPath,
    consolidated,
    metadata,
    updatedAt: new Date().toISOString(),
  };

  const { resource } = await container.items.upsert(document);
  return resource;
}

/**
 * Query meetings by project and optional date range.
 *
 * @param {Object} params
 * @param {string} params.projectName       - project to query
 * @param {string} [params.startDate]       - inclusive start date (YYYY-MM-DD)
 * @param {string} [params.endDate]         - inclusive end date (YYYY-MM-DD)
 * @param {boolean} [params.excludeConsolidated] - if true, omit the large consolidated field
 * @returns {Object[]} matching meeting records
 */
async function queryMeetings({
  projectName,
  startDate,
  endDate,
  excludeConsolidated = false,
}) {
  const container = getContainer();

  const selectFields = excludeConsolidated
    ? "c.id, c.projectName, c.meetingId, c.meetingDate, c.dashboardPath, c.metadata, c.updatedAt"
    : "*";

  const sanitizedProject = sanitizeId(projectName) || "general";
  let query = `SELECT ${selectFields} FROM c WHERE c.projectName = @projectName`;
  const parameters = [{ name: "@projectName", value: sanitizedProject }];

  if (startDate) {
    query += " AND c.meetingDate >= @startDate";
    parameters.push({ name: "@startDate", value: startDate });
  }
  if (endDate) {
    query += " AND c.meetingDate <= @endDate";
    parameters.push({ name: "@endDate", value: endDate });
  }

  query += " ORDER BY c.meetingDate DESC";

  const { resources } = await container.items
    .query({ query, parameters })
    .fetchAll();

  return resources;
}

/**
 * Get a single meeting record.
 *
 * @param {string} projectName
 * @param {string} meetingId
 * @returns {Object|null} the meeting record or null
 */
async function getMeeting(projectName, meetingId) {
  const container = getContainer();
  const sanitizedProject = sanitizeId(projectName) || "general";
  const id = `${sanitizedProject}-${sanitizeId(meetingId)}`;

  try {
    const { resource } = await container
      .item(id, sanitizedProject)
      .read();
    return resource;
  } catch (err) {
    if (err.code === 404) return null;
    throw err;
  }
}

/**
 * List all projects (distinct project names).
 *
 * @returns {string[]} array of project names
 */
async function listProjects() {
  const container = getContainer();

  const { resources } = await container.items
    .query("SELECT DISTINCT VALUE c.projectName FROM c")
    .fetchAll();

  return resources;
}

/**
 * Read a project's settings (currently just the URL-obfuscation flag).
 *
 * Default-safe: never throws. If Cosmos is not configured (no COSMOS_ENDPOINT),
 * the project has no settings document yet (404), or the read fails for any
 * reason, this returns the defaults ({ obfuscateUrls: false }). Deployment must
 * not break just because the settings store is missing or unreachable.
 *
 * @param {string} projectName - project slug (e.g. "crm")
 * @returns {Promise<{obfuscateUrls: boolean}>}
 */
async function getProjectSettings(projectName) {
  if (!process.env.COSMOS_ENDPOINT) {
    return { ...DEFAULT_PROJECT_SETTINGS };
  }

  const id = sanitizeId(projectName) || "general";

  try {
    const container = getProjectsContainer();
    const { resource } = await container.item(id, id).read();
    if (!resource) return { ...DEFAULT_PROJECT_SETTINGS };
    return {
      ...DEFAULT_PROJECT_SETTINGS,
      obfuscateUrls: resource.obfuscateUrls === true,
    };
  } catch (err) {
    if (err.code === 404) return { ...DEFAULT_PROJECT_SETTINGS };
    // Any other failure (network, auth, missing container) must not block a
    // deploy — fall back to the safe default.
    return { ...DEFAULT_PROJECT_SETTINGS };
  }
}

/**
 * Create or update a project's settings document.
 *
 * Unlike getProjectSettings, this DOES throw on failure — it is only called
 * from the admin toggle script, where the operator needs to know it worked.
 * The id and partition key are both the sanitized project slug.
 *
 * @param {Object} params
 * @param {string} params.projectName    - project slug
 * @param {boolean} params.obfuscateUrls - whether new dashboards use GUID URLs
 * @returns {Promise<Object>} the upserted document
 */
async function upsertProjectSettings({ projectName, obfuscateUrls }) {
  if (!projectName) {
    throw new Error("upsertProjectSettings: projectName is required");
  }

  const container = getProjectsContainer();
  const id = sanitizeId(projectName) || "general";

  const document = {
    id,
    projectName: id,
    obfuscateUrls: obfuscateUrls === true,
    updatedAt: new Date().toISOString(),
  };

  const { resource } = await container.items.upsert(document);
  return resource;
}

module.exports = {
  getContainer,
  getProjectsContainer,
  upsertMeeting,
  queryMeetings,
  getMeeting,
  listProjects,
  getProjectSettings,
  upsertProjectSettings,
};
