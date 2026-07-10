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
 *   COSMOS_SECURITY_CONTAINER - security config container name (default: "security")
 */

// Polyfill globalThis.crypto for @azure/identity in Node.js environments
// where the Web Crypto API isn't globally available
if (!globalThis.crypto) {
  globalThis.crypto = require("crypto");
}

const { CosmosClient } = require("@azure/cosmos");
const { DefaultAzureCredential } = require("@azure/identity");

const { sanitizeId } = require("./sanitize");
const { meetingSecurityId, createMeetingSecurityDocument } = require("./meetingSecurity");

const DB_NAME = process.env.COSMOS_DATABASE || "tiger";
const CONTAINER_NAME = process.env.COSMOS_CONTAINER || "meetings";
const SECURITY_CONTAINER_NAME =
  process.env.COSMOS_SECURITY_CONTAINER || "security";

let _client = null;
let _container = null;
let _securityContainer = null;

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

  _client = new CosmosClient({
    endpoint,
    aadCredentials: new DefaultAzureCredential(),
  });

  _container = _client.database(DB_NAME).container(CONTAINER_NAME);
  return _container;
}

function getSecurityContainer() {
  if (_securityContainer) return _securityContainer;
  if (!_client) getContainer();
  _securityContainer = _client.database(DB_NAME).container(SECURITY_CONTAINER_NAME);
  return _securityContainer;
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

async function getProjectPolicy(projectName) {
  const container = getSecurityContainer();
  const sanitizedProject = sanitizeId(projectName) || "general";

  try {
    const { resource } = await container
      .item(projectPolicyId(sanitizedProject), sanitizedProject)
      .read();
    return resource;
  } catch (err) {
    if (err.code === 404) return null;
    throw err;
  }
}

async function upsertProjectPolicy({
  projectName,
  passwordProtectionEnabled = false,
  projectAdmins = [],
  updatedBy = "",
}) {
  const container = getSecurityContainer();
  const sanitizedProject = sanitizeId(projectName) || "general";
  const normalizedAdmins = [...new Set(
    (projectAdmins || [])
      .map((email) => String(email || "").trim().toLowerCase())
      .filter(Boolean),
  )];

  const document = {
    id: projectPolicyId(sanitizedProject),
    type: "projectPolicy",
    projectName: sanitizedProject,
    passwordProtectionEnabled: !!passwordProtectionEnabled,
    projectAdmins: normalizedAdmins,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };

  const { resource } = await container.items.upsert(document);
  return resource;
}

async function listProjectPolicies() {
  const container = getSecurityContainer();
  const { resources } = await container.items
    .query("SELECT * FROM c WHERE c.type = 'projectPolicy'")
    .fetchAll();
  return resources;
}

async function getMeetingSecurity(projectName, meetingId) {
  const container = getSecurityContainer();
  const sanitizedProject = sanitizeId(projectName) || "general";

  try {
    const { resource } = await container
      .item(meetingSecurityId(sanitizedProject, meetingId), sanitizedProject)
      .read();
    return resource;
  } catch (err) {
    if (err.code === 404) return null;
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

  const container = getSecurityContainer();
  const { resource } = await container.items.upsert(document);
  return resource;
}

async function listMeetingSecurityByProject(projectName) {
  const container = getSecurityContainer();
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
  getSecurityContainer,
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
};
