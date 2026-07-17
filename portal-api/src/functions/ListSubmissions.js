const { app } = require("@azure/functions");
const { createSubmissionStore } = require("../services/submissionStore");
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

// Memoize the handler + its Cosmos client/credential at module scope (see
// SubmitTranscript for the rationale).
let _handler = null;
function getHandler() {
  if (!_handler) _handler = createListSubmissionsHandler({ store: createSubmissionStore() });
  return _handler;
}

app.http("ListSubmissions", {
  methods: ["GET"],
  route: "v1/submissions",
  authLevel: "anonymous",
  handler: (request, context) => getHandler()(request, context),
});

module.exports = { createListSubmissionsHandler };
