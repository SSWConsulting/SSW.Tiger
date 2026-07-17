const { app } = require("@azure/functions");
const { createSubmissionStore } = require("../services/submissionStore");
const { createSubmissionActorResolver } = require("../services/submissionActor");

function json(status, body) {
  return {
    status,
    jsonBody: body,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  };
}

function createListSubmissionsHandler({ store, actorResolver = createSubmissionActorResolver() } = {}) {
  return async function listSubmissions(request, context) {
    const actor = await actorResolver.resolve(request);
    // Only a real signed-in user has a history. The service-identity fallback
    // (no SWA principal header) must never enumerate submissions.
    if (!actor || actor.type !== "user" || !actor.subject) {
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

app.http("ListSubmissions", {
  methods: ["GET"],
  route: "v1/submissions",
  authLevel: "anonymous",
  handler: async (request, context) =>
    createListSubmissionsHandler({ store: createSubmissionStore() })(request, context),
});

module.exports = { createListSubmissionsHandler };
