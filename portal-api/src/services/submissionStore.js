const { CosmosClient } = require("@azure/cosmos");
const { DefaultAzureCredential } = require("@azure/identity");

// Polyfill globalThis.crypto for @azure/identity where Web Crypto isn't global.
if (!globalThis.crypto) globalThis.crypto = require("crypto");

const DB_NAME = process.env.COSMOS_DATABASE || "tiger";
const DEFAULT_CONTAINER = "submissions";

/**
 * Per-user submission history store.
 *
 * SHARED RECORD CONTRACT (also written/updated by the processor via
 * lib/cosmosClient.js#updateSubmissionStatus — keep both in sync):
 *   {
 *     id: <requestId>, type: "submission",
 *     projectName: <slug>,          // partition key (raw slug, already sanitized)
 *     requestId, displayName,
 *     userSubject, userEmail,        // owner
 *     status: "accepted"|"processing"|"completed"|"failed",
 *     dashboardUrl: <string|null>,
 *     submittedAt, updatedAt         // ISO
 *   }
 *
 * Partitioned by /projectName so future project-admin views stay single-partition;
 * the per-user list is a cross-partition filter on userSubject, cheap at this scale.
 */
function createSubmissionStore({
  endpoint = process.env.COSMOS_ENDPOINT,
  containerName = process.env.COSMOS_SUBMISSIONS_CONTAINER || DEFAULT_CONTAINER,
  credential,
  client,
} = {}) {
  let container = null;
  function getContainer() {
    if (container) return container;
    if (!endpoint) throw new Error("COSMOS_ENDPOINT is not configured");
    const cosmos = client || new CosmosClient({ endpoint, aadCredentials: credential || new DefaultAzureCredential() });
    container = cosmos.database(DB_NAME).container(containerName);
    return container;
  }

  return {
    async create(record) {
      await getContainer().items.create(record);
    },
    async deleteIfExists(id, projectName) {
      try {
        await getContainer().item(id, projectName).delete();
      } catch (error) {
        if (error.code !== 404) throw error;
      }
    },
    async listByUser(userSubject) {
      const { resources } = await getContainer()
        .items.query({
          query:
            "SELECT c.requestId, c.displayName, c.projectName, c.status, c.dashboardUrl, c.submittedAt " +
            "FROM c WHERE c.type = 'submission' AND c.userSubject = @sub ORDER BY c.submittedAt DESC",
          parameters: [{ name: "@sub", value: userSubject }],
        })
        .fetchAll();
      return resources;
    },
  };
}

module.exports = { DEFAULT_SUBMISSIONS_CONTAINER: DEFAULT_CONTAINER, createSubmissionStore };
