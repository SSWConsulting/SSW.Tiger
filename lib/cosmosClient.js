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
 *   COSMOS_DATABASE   - database name (default: "tiger")
 *   COSMOS_CONTAINER  - meeting container name (default: "meetings")
 *   COSMOS_PROJECT_POLICIES_CONTAINER - project policy container name (default: "projectPolicies")
 *   COSMOS_MEETING_SECURITY_CONTAINER - meeting password container name (default: "meetingSecurity")
 */

// Polyfill globalThis.crypto for @azure/identity in Node.js environments
// where the Web Crypto API isn't globally available
if (!globalThis.crypto) {
  globalThis.crypto = require("node:crypto");
}

const { sanitizeId } = require("./sanitize");
const { meetingSecurityId, createMeetingSecurityDocument } = require("./meetingSecurity");
const { log } = require("./logger");

const DB_NAME = process.env.COSMOS_DATABASE || "tiger";
const CONTAINER_NAME = process.env.COSMOS_CONTAINER || "meetings";
const PROJECT_POLICIES_CONTAINER_NAME =
  process.env.COSMOS_PROJECT_POLICIES_CONTAINER || "projectPolicies";
const MEETING_SECURITY_CONTAINER_NAME =
  process.env.COSMOS_MEETING_SECURITY_CONTAINER || "meetingSecurity";
const SUBMISSIONS_CONTAINER_NAME =
  process.env.COSMOS_SUBMISSIONS_CONTAINER || "submissions";

let _client = null;
let _container = null;
let _projectPoliciesContainer = null;
let _meetingSecurityContainer = null;
let _submissionsContainer = null;

function loadAzureCosmosDependencies() {
  try {
    const { CosmosClient } = require("@azure/cosmos");
    const { DefaultAzureCredential } = require("@azure/identity");
    return { CosmosClient, DefaultAzureCredential };
  } catch {
    throw new Error(
      "Missing Azure Cosmos dependencies. Install @azure/cosmos and @azure/identity.",
    );
  }
}

/**
 * Get the Cosmos DB container (lazy singleton).
 * Database and container are created by Bicep — this just connects.
 */
function getContainer() {
  if (_container) return _container;

  const endpoint = process.env.COSMOS_ENDPOINT;

  if (!endpoint) {
    throw new Error(
      "COSMOS_ENDPOINT is required. Set it to your Cosmos DB account endpoint.",
    );
  }

  const { CosmosClient, DefaultAzureCredential } = loadAzureCosmosDependencies();
  _client = new CosmosClient({
    endpoint,
    aadCredentials: new DefaultAzureCredential(),
  });

  _container = _client.database(DB_NAME).container(CONTAINER_NAME);
  return _container;
}

function getProjectPoliciesContainer() {
  if (_projectPoliciesContainer) return _projectPoliciesContainer;
  if (!_client) getContainer();
  _projectPoliciesContainer = _client.database(DB_NAME).container(PROJECT_POLICIES_CONTAINER_NAME);
  return _projectPoliciesContainer;
}

function getMeetingSecurityContainer() {
  if (_meetingSecurityContainer) return _meetingSecurityContainer;
  if (!_client) getContainer();
  _meetingSecurityContainer = _client.database(DB_NAME).container(MEETING_SECURITY_CONTAINER_NAME);
  return _meetingSecurityContainer;
}

function getSubmissionsContainer() {
  if (_submissionsContainer) return _submissionsContainer;
  if (!_client) getContainer();
  _submissionsContainer = _client.database(DB_NAME).container(SUBMISSIONS_CONTAINER_NAME);
  return _submissionsContainer;
}

/**
 * Update a portal submission's status/dashboardUrl after the processor runs.
 * The record is CREATED by the Portal API (functions-portal/src/services/submissionStore.js)
 * at upload time; here we only patch the outcome so owner/submittedAt are preserved.
 *
 * @param {Object} params
 * @param {string} params.requestId    - submission id (Cosmos item id)
 * @param {string} params.projectName  - raw slug (partition key), exactly as the Portal API wrote it
 * @param {string} params.status       - "processing" | "completed" | "failed"
 * @param {string} [params.dashboardUrl] - set on completion
 * @param {string} [params.displayName]  - resolved title (e.g. the meeting subject) when the
 *                                          submitter left the project name blank; ignored if empty
 * @param {boolean} [params.passwordProtected] - true when the dashboard is password-protected
 * @param {string} [params.dashboardPassword]  - the dashboard password, so the portal can show it to
 *                                          the owner (portal submissions get no Teams notification).
 *                                          Owner-scoped: only the submitter can read their own record.
 * @returns {Object|null} the patched record, or null if no record exists
 */
async function updateSubmissionStatus({
  requestId,
  projectName,
  status,
  dashboardUrl,
  displayName,
  passwordProtected,
  dashboardPassword,
}) {
  const container = getSubmissionsContainer();
  const operations = [
    { op: "set", path: "/status", value: status },
    { op: "set", path: "/updatedAt", value: new Date().toISOString() },
  ];
  if (dashboardUrl !== undefined && dashboardUrl !== null) {
    operations.push({ op: "set", path: "/dashboardUrl", value: dashboardUrl });
  }
  if (displayName) {
    operations.push({ op: "set", path: "/displayName", value: displayName });
  }
  if (passwordProtected) {
    operations.push({ op: "set", path: "/passwordProtected", value: true });
  }
  if (dashboardPassword) {
    operations.push({ op: "set", path: "/dashboardPassword", value: dashboardPassword });
  }
  try {
    const { resource } = await container.item(requestId, projectName).patch(operations);
    return resource;
  } catch (err) {
    // Record may not exist (e.g. Graph-path meetings have no submission record).
    if (err.code === 404) return null;
    throw err;
  }
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
    type: "meeting",
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

function projectPolicyId(projectName) {
  const sanitizedProject = sanitizeId(projectName) || "general";
  return `projectPolicy-${sanitizedProject}`;
}

async function getProjectPolicy(projectName, options = {}) {
  const container = getProjectPoliciesContainer();
  const sanitizedProject = sanitizeId(projectName) || "general";
  const policyId = projectPolicyId(sanitizedProject);

  log("info", "Reading project security policy", {
    container: PROJECT_POLICIES_CONTAINER_NAME,
    projectName,
    sanitizedProject,
    policyId,
    partitionKey: sanitizedProject,
  });

  try {
    if (options.requireContainer) {
      await container.read();
    }
    const { resource } = await container
      .item(policyId, sanitizedProject)
      .read();
    log("info", "Project security policy read result", {
      container: PROJECT_POLICIES_CONTAINER_NAME,
      projectName,
      sanitizedProject,
      policyId,
      partitionKey: sanitizedProject,
      found: !!resource,
      passwordProtectionEnabled: !!resource?.passwordProtectionEnabled,
    });
    return resource;
  } catch (err) {
    if (err.code === 404 && !isCosmosInfrastructureNotFound(err)) {
      log("info", "Project security policy not found", {
        container: PROJECT_POLICIES_CONTAINER_NAME,
        projectName,
        sanitizedProject,
        policyId,
        partitionKey: sanitizedProject,
      });
      return null;
    }
    throw err;
  }
}

function isCosmosInfrastructureNotFound(err) {
  const message = String(err?.message || "");
  const body = String(err?.body || "");
  return [
    "Owner resource does not exist",
    "Database",
    "database",
    "Collection",
    "collection",
    "Container",
    "container",
  ].some((needle) => message.includes(needle) || body.includes(needle));
}

async function upsertProjectPolicy({
  projectName,
  passwordProtectionEnabled = false,
  projectAdmins = [],
  updatedBy = "",
}) {
  const container = getProjectPoliciesContainer();
  const sanitizedProject = sanitizeId(projectName) || "general";
  const policyId = projectPolicyId(sanitizedProject);
  const normalizedAdmins = [...new Set(
    (projectAdmins || [])
      .map((email) => String(email || "").trim().toLowerCase())
      .filter(Boolean),
  )];

  const document = {
    id: policyId,
    type: "projectPolicy",
    projectName: sanitizedProject,
    passwordProtectionEnabled: !!passwordProtectionEnabled,
    projectAdmins: normalizedAdmins,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };

  log("info", "Upserting project security policy", {
    container: PROJECT_POLICIES_CONTAINER_NAME,
    projectName,
    sanitizedProject,
    policyId,
    partitionKey: sanitizedProject,
    passwordProtectionEnabled: document.passwordProtectionEnabled,
    projectAdminCount: normalizedAdmins.length,
    updatedBy,
  });

  const { resource } = await container.items.upsert(document);
  return resource;
}

async function listProjectPolicies() {
  const container = getProjectPoliciesContainer();
  const { resources } = await container.items
    .query("SELECT * FROM c WHERE c.type = 'projectPolicy'")
    .fetchAll();
  return resources;
}

async function getMeetingSecurity(projectName, meetingId) {
  const container = getMeetingSecurityContainer();
  const sanitizedProject = sanitizeId(projectName) || "general";
  const id = meetingSecurityId(sanitizedProject, meetingId);

  try {
    const { resource } = await container
      .item(id, sanitizedProject)
      .read();
    return resource;
  } catch (err) {
    if (err.code === 404 && !isCosmosInfrastructureNotFound(err)) return null;
    throw err;
  }
}

async function upsertMeetingSecurity({
  projectName,
  meetingId,
  passwordEnabled,
  passwordEncryption,
  encryptedAt,
  updatedBy = "system",
}) {
  const document = createMeetingSecurityDocument({
    projectName,
    meetingId,
    passwordEnabled,
    passwordEncryption,
    encryptedAt,
    updatedBy,
  });

  const container = getMeetingSecurityContainer();
  const { resource } = await container.items.upsert(document);
  return resource;
}

async function listMeetingSecurityByProject(projectName) {
  const container = getMeetingSecurityContainer();
  const sanitizedProject = sanitizeId(projectName) || "general";
  const { resources } = await container.items
    .query({
      query: "SELECT * FROM c WHERE c.projectName = @projectName AND c.type = 'meetingSecurity'",
      parameters: [{ name: "@projectName", value: sanitizedProject }],
    })
    .fetchAll();
  return resources;
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
  let query = `SELECT ${selectFields} FROM c WHERE c.projectName = @projectName AND (NOT IS_DEFINED(c.type) OR c.type = 'meeting')`;
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

module.exports = {
  getContainer,
  getProjectPoliciesContainer,
  getMeetingSecurityContainer,
  getSubmissionsContainer,
  updateSubmissionStatus,
  upsertMeeting,
  queryMeetings,
  getMeeting,
  listProjects,
  getProjectPolicy,
  upsertProjectPolicy,
  listProjectPolicies,
  getMeetingSecurity,
  upsertMeetingSecurity,
  listMeetingSecurityByProject,
  isCosmosInfrastructureNotFound,
};
