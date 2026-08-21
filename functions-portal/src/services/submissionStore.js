const { CosmosClient } = require("@azure/cosmos");
const { getDataPlaneCredential } = require("./credential");

const DB_NAME = process.env.COSMOS_DATABASE || "tiger";
const DEFAULT_COSMOS_CONTAINER = "submissions";

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
  containerName = process.env.COSMOS_SUBMISSIONS_CONTAINER || DEFAULT_COSMOS_CONTAINER,
  credential,
  client,
} = {}) {
  let container = null;
  function getContainer() {
    if (container) return container;
    if (!endpoint) throw new Error("COSMOS_ENDPOINT is not configured");
    const cosmos =
      client ||
      new CosmosClient({
        endpoint,
        aadCredentials: credential || getDataPlaneCredential(),
        connectionPolicy: {
          // Both Cosmos accounts are single-region (Australia East, no
          // multi-write), so there is no region list to discover — leaving this
          // on costs an account-metadata round trip before the first query, on a
          // path where the first query is already the slow one.
          // ⚠️ If a second region is ever added, turn this back on so the SDK can
          // follow a failover.
          enableEndpointDiscovery: false,
        },
      });
    container = cosmos.database(DB_NAME).container(containerName);
    return container;
  }

  // A record only reaches a terminal status because the Job wrote one. Two windows
  // leave that write undone: the host dying between store.create() and a successful
  // queue publish (orphan "accepted", no message ever sent), and a hard SIGKILL
  // mid-run (stuck "processing" — SIGTERM is handled by entrypoint.sh).
  //
  // The cutoff must clear the Job's own replicaTimeout (3600s, infra/modules/
  // containerApp.bicep) plus queue latency, or this would fail runs that are merely
  // slow. 90 minutes leaves a wide margin over that 60-minute ceiling.
  const STALE_AFTER_MS = 90 * 60 * 1000;

  async function listStale(nowMs) {
    const cutoff = new Date(nowMs - STALE_AFTER_MS).toISOString();
    const { resources } = await getContainer()
      .items.query({
        query:
          "SELECT c.id, c.projectName FROM c WHERE c.type = 'submission' " +
          "AND c.status IN ('accepted', 'processing') AND c.updatedAt < @cutoff",
        parameters: [{ name: "@cutoff", value: cutoff }],
      })
      .fetchAll();
    return resources;
  }

  async function listByUser(userSubject) {
    const { resources } = await getContainer()
      .items.query({
        query:
          // updatedAt is the last status write, so on a terminal row it is when
          // the run ended — that plus submittedAt is the processing duration,
          // with no extra field to write.
          "SELECT c.requestId, c.displayName, c.projectName, c.status, c.dashboardUrl, c.submittedAt, " +
          "c.updatedAt, c.failureReason, c.passwordProtected, c.dashboardPassword " +
          "FROM c WHERE c.type = 'submission' AND c.userSubject = @sub ORDER BY c.submittedAt DESC",
        parameters: [{ name: "@sub", value: userSubject }],
      })
      .fetchAll();
    return resources;
  }

  return {
    /**
     * Fire-and-forget from module scope so the AAD token exchange and the Cosmos
     * client's first-request setup happen DURING host startup instead of inside
     * the first user request — the same trick as the portal's module-load
     * prefetch. Runs the real query shape (matching no rows) rather than a
     * metadata read, so it warms exactly the path listByUser uses and needs no
     * permission beyond the one that path already has.
     */
    async warm() {
      await listByUser("__warm__");
    },
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
    /**
     * Fail records that can no longer be completed by anything, so a submission
     * cannot sit on "Queued"/"Processing" forever. Returns how many were swept.
     *
     * Patches each row individually rather than in a transactional batch: rows in
     * this set have different partition keys, and a batch is single-partition only.
     * One failed patch must not abandon the rest, so each is isolated — a row that
     * a real Job finished between the query and the patch just 404s or gets
     * overwritten by the Job's own terminal write, both of which are harmless.
     */
    async sweepStale({ now = Date.now() } = {}) {
      const stale = await listStale(now);
      let swept = 0;
      for (const row of stale) {
        try {
          await getContainer()
            .item(row.id, row.projectName)
            .patch([
              { op: "set", path: "/status", value: "failed" },
              { op: "set", path: "/updatedAt", value: new Date(now).toISOString() },
              {
                op: "set",
                path: "/failureReason",
                value: "Processing did not finish in time and was abandoned. Please submit again.",
              },
            ]);
          swept += 1;
        } catch {
          /* Best effort — a row we cannot patch is retried on the next sweep. */
        }
      }
      return swept;
    },
    listByUser,
  };
}

/**
 * One store per worker process, shared by every function that reads submission
 * history (the HTTP list handler and the KeepWarm timer).
 *
 * Sharing is the whole point: a warm-up that primed its OWN CosmosClient would
 * leave the next real request to pay that client's first-request setup anyway.
 * Same instance → the timer's work is the request's head start.
 */
let shared = null;
function getSharedSubmissionStore() {
  if (!shared) shared = createSubmissionStore();
  return shared;
}

module.exports = { DEFAULT_COSMOS_CONTAINER, createSubmissionStore, getSharedSubmissionStore };
