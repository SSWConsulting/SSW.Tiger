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
 *   COSMOS_CONTAINER  - container name (default: "meetings")
 */

const { CosmosClient } = require("@azure/cosmos");
const { DefaultAzureCredential } = require("@azure/identity");

const DB_NAME = process.env.COSMOS_DATABASE || "tiger";
const CONTAINER_NAME = process.env.COSMOS_CONTAINER || "meetings";

let _client = null;
let _container = null;

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

/**
 * Upsert a meeting record to Cosmos DB.
 *
 * @param {Object} params
 * @param {string} params.projectName    - e.g. "yakshaver"
 * @param {string} params.meetingId      - e.g. "2026-01-22-094557"
 * @param {string} params.meetingDate    - e.g. "2026-01-22"
 * @param {string} params.dashboardUrl   - deployed dashboard URL
 * @param {Object} params.consolidated   - full consolidated.json content
 * @param {Object} [params.metadata]     - optional extra metadata
 * @returns {Object} the upserted document
 */
async function upsertMeeting({
  projectName,
  meetingId,
  meetingDate,
  dashboardUrl,
  consolidated,
  metadata = {},
}) {
  const missing = [
    !projectName && "projectName",
    !meetingId && "meetingId",
    !meetingDate && "meetingDate",
    !dashboardUrl && "dashboardUrl",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(`upsertMeeting: missing required fields: ${missing.join(", ")}`);
  }

  const container = getContainer();

  const document = {
    id: `${projectName}-${meetingId}`,
    projectName,
    meetingId,
    meetingDate,
    dashboardUrl,
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
    ? "c.id, c.projectName, c.meetingId, c.meetingDate, c.dashboardUrl, c.metadata, c.updatedAt"
    : "*";

  let query = `SELECT ${selectFields} FROM c WHERE c.projectName = @projectName`;
  const parameters = [{ name: "@projectName", value: projectName }];

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
  const id = `${projectName}-${meetingId}`;

  try {
    const { resource } = await container
      .item(id, projectName)
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
  upsertMeeting,
  queryMeetings,
  getMeeting,
  listProjects,
};
