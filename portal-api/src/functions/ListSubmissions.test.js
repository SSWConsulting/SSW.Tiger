const test = require("node:test");
const assert = require("node:assert/strict");
const { createListSubmissionsHandler } = require("./ListSubmissions");

const userActor = { type: "user", subject: "u-1", email: "willow@ssw.com.au" };

function requestFor() {
  return { headers: { get: () => null } };
}

test("401s when the caller is not an authenticated user", async () => {
  const handler = createListSubmissionsHandler({
    store: {
      listByUser: async () => {
        throw new Error("should not be called");
      },
    },
    actorResolver: { resolve: async () => ({ type: "service", subject: "function-key" }) },
  });
  const response = await handler(requestFor(), {});
  assert.equal(response.status, 401);
  assert.equal(response.jsonBody.error.code, "unauthenticated");
});

test("returns the caller's submissions mapped to the client contract", async () => {
  let queriedSubject = null;
  const handler = createListSubmissionsHandler({
    actorResolver: { resolve: async () => userActor },
    store: {
      listByUser: async (subject) => {
        queriedSubject = subject;
        return [
          {
            requestId: "r1",
            displayName: "Tiger Portal",
            projectName: "tiger-portal",
            status: "completed",
            dashboardUrl: "https://x/y",
            submittedAt: "2026-07-17T01:02:03.000Z",
          },
          {
            requestId: "r2",
            displayName: "Acme",
            projectName: "acme",
            status: "accepted",
            dashboardUrl: null,
            submittedAt: "2026-07-16T00:00:00.000Z",
          },
        ];
      },
    },
  });
  const response = await handler(requestFor(), {});
  assert.equal(queriedSubject, "u-1");
  assert.equal(response.status, 200);
  assert.deepEqual(response.jsonBody.submissions[0], {
    requestId: "r1",
    displayName: "Tiger Portal",
    projectSlug: "tiger-portal",
    status: "completed",
    dashboardUrl: "https://x/y",
    submittedAt: "2026-07-17T01:02:03.000Z",
  });
  assert.equal(response.jsonBody.submissions[1].dashboardUrl, null);
});

test("503s when the store query fails", async () => {
  const handler = createListSubmissionsHandler({
    actorResolver: { resolve: async () => userActor },
    store: {
      listByUser: async () => {
        throw new Error("cosmos down");
      },
    },
  });
  const response = await handler(requestFor(), { error: () => {} });
  assert.equal(response.status, 503);
  assert.equal(response.jsonBody.error.code, "list_unavailable");
});
