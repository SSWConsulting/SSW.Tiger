const { app } = require("@azure/functions");
const { getSharedSubmissionStore } = require("../services/submissionStore");
const { createSubmissionActorResolver } = require("../services/submissionActor");
const { json } = require("../http");

function createListSubmissionsHandler({ store, actorResolver = createSubmissionActorResolver() } = {}) {
  return async function listSubmissions(request, context) {
    const actor = await actorResolver.resolve(request);
    // Only a real signed-in user has a history. The service-identity fallback
    // (no SWA principal header) must never enumerate submissions.
    if (actor?.type !== "user" || !actor.subject) {
      return json(401, { error: { code: "unauthenticated", message: "Sign in to view your dashboards." } });
    }

    try {
      const rows = await store.listByUser(actor.subject);
      const submissions = rows.map((row) => ({
        requestId: row.requestId,
        displayName: row.displayName,
        projectSlug: row.projectName,
        status: row.status,
        dashboardUrl: row.dashboardUrl ?? null,
        submittedAt: row.submittedAt,
        // Last status write. On a completed/failed row that is the finish time,
        // which is what the list turns into a duration.
        updatedAt: row.updatedAt ?? null,
        // Why a failed run failed, written by the Job. Already a user-facing
        // sentence and length-capped at the write side.
        failureReason: row.failureReason ?? null,
        // Password-protected dashboards surface the password here (owner-scoped list)
        // because portal submissions get no Teams notification carrying it.
        passwordProtected: !!row.passwordProtected,
        dashboardPassword: row.dashboardPassword ?? null,
      }));
      return json(200, { submissions });
    } catch (error) {
      context?.error?.(`[TIGER] List submissions failed: ${error.message}`);
      return json(503, {
        error: { code: "list_unavailable", message: "Could not load your dashboards. Please try again." },
      });
    }
  };
}

// Memoize the handler at module scope (see SubmitTranscript for the rationale).
// The store itself is the process-wide shared one, so the KeepWarm timer and this
// handler prime and use the SAME Cosmos client and credential.
let _handler = null;
function getHandler() {
  if (!_handler) _handler = createListSubmissionsHandler({ store: getSharedSubmissionStore() });
  return _handler;
}

// Pay the AAD token exchange and the Cosmos client's first-request setup NOW,
// while the host is still starting up, rather than inside whichever user request
// happens to land on a cold instance. Measured warm: 64 ms — so on a Y1
// Consumption plan with no always-ready instance, that setup WAS the wait.
//
// Guarded on COSMOS_ENDPOINT so `node --test` (which loads this module to reach
// createListSubmissionsHandler) never opens a Cosmos client. Failures are
// swallowed on purpose: warming is an optimisation, and a real problem will
// surface through the request path with proper error handling.
if (process.env.COSMOS_ENDPOINT) {
  void getSharedSubmissionStore()
    .warm()
    .catch(() => {});
}

app.http("ListSubmissions", {
  methods: ["GET"],
  route: "v1/submissions",
  authLevel: "anonymous",
  handler: (request, context) => getHandler()(request, context),
});

module.exports = { createListSubmissionsHandler };
