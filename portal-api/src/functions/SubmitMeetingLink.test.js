const test = require("node:test");
const assert = require("node:assert/strict");
const { createSubmitMeetingLinkHandler } = require("./SubmitMeetingLink");

const userActor = { type: "user", subject: "u-1", email: "willow@ssw.com.au" };
const validLink = `https://teams.microsoft.com/l/meetup-join/19%3ax/0?context=${encodeURIComponent(
  JSON.stringify({ Tid: "tenant-1", Oid: "organizer-1" }),
)}`;

function requestWith(body) {
  return { headers: { get: () => null }, json: async () => body };
}

test("401s when the caller is not an authenticated user", async () => {
  const handler = createSubmitMeetingLinkHandler({
    queue: {
      publish: async () => {
        throw new Error("should not publish");
      },
    },
    actorResolver: { resolve: async () => ({ type: "service", subject: "function-key" }) },
  });
  const response = await handler(requestWith({ projectName: "Tiger", meetingLink: validLink }), {});
  assert.equal(response.status, 401);
});

test("accepts a valid link: enqueues a meetingLink message and writes a history record", async () => {
  const published = [];
  const created = [];
  const handler = createSubmitMeetingLinkHandler({
    actorResolver: { resolve: async () => userActor },
    queue: { publish: async (m) => published.push(m) },
    store: { create: async (r) => created.push(r), deleteIfExists: async () => {} },
    now: () => new Date("2026-07-17T01:02:03Z"),
    randomUUID: () => "req-1",
  });
  const response = await handler(requestWith({ projectName: "Tiger Portal", meetingLink: validLink }), {});
  assert.equal(response.status, 202);
  assert.deepEqual(response.jsonBody, { requestId: "req-1", status: "accepted" });
  assert.equal(published.length, 1);
  assert.equal(published[0].sourceType, "meetingLink");
  assert.equal(published[0].organizerId, "organizer-1");
  assert.deepEqual(published[0].project, { displayName: "Tiger Portal", slug: "tiger-portal" });
  assert.equal(created[0].userSubject, "u-1");
  assert.equal(created[0].status, "accepted");
});

test("rejects a link that is missing the context/organizer", async () => {
  const handler = createSubmitMeetingLinkHandler({
    actorResolver: { resolve: async () => userActor },
    queue: {
      publish: async () => {
        throw new Error("should not publish");
      },
    },
  });
  const response = await handler(
    requestWith({ projectName: "Tiger", meetingLink: "https://teams.microsoft.com/l/meetup-join/19:x/0" }),
    {},
  );
  assert.equal(response.status, 400);
  assert.equal(response.jsonBody.error.code, "link_missing_context");
});

test("rolls back the history record when publish fails", async () => {
  const removed = [];
  const handler = createSubmitMeetingLinkHandler({
    actorResolver: { resolve: async () => userActor },
    queue: {
      publish: async () => {
        throw new Error("queue down");
      },
    },
    store: { create: async () => {}, deleteIfExists: async (id, pk) => removed.push([id, pk]) },
    randomUUID: () => "req-1",
  });
  const response = await handler(requestWith({ projectName: "Tiger", meetingLink: validLink }), { error: () => {} });
  assert.equal(response.status, 503);
  assert.deepEqual(removed, [["req-1", "tiger"]]);
});
