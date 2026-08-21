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
            updatedAt: "2026-07-17T01:14:03.000Z",
            passwordProtected: true,
            dashboardPassword: "AB12CD",
          },
          {
            requestId: "r2",
            displayName: "Acme",
            projectName: "acme",
            status: "failed",
            dashboardUrl: null,
            submittedAt: "2026-07-16T00:00:00.000Z",
            failureReason: "No transcript is available for this meeting yet.",
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
    // The pair the list turns into "took 12 min".
    updatedAt: "2026-07-17T01:14:03.000Z",
    // Always present so the client type stays a plain optional-null, never "missing".
    failureReason: null,
    passwordProtected: true,
    dashboardPassword: "AB12CD",
  });
  // A row Cosmos has no updatedAt for must arrive as null, not undefined, so the
  // client renders no duration rather than "took NaN".
  assert.equal(response.jsonBody.submissions[1].updatedAt, null);
  assert.equal(response.jsonBody.submissions[1].dashboardUrl, null);
  assert.equal(response.jsonBody.submissions[1].passwordProtected, false);
  assert.equal(response.jsonBody.submissions[1].dashboardPassword, null);
  // A failed row carries the Job's explanation through to the list.
  assert.equal(
    response.jsonBody.submissions[1].failureReason,
    "No transcript is available for this meeting yet.",
  );
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
