const test = require("node:test");
const assert = require("node:assert/strict");
const { createSubmissionService } = require("./submissionService");

const validBytes = Buffer.from("WEBVTT\n\n00:00.000 --> 00:01.000\nHello");

// The shape every caller now passes: a resolved, signed-in SWA user. submit()
// rejects anything without a subject, so tests must use a realistic actor.
const actor = { type: "user", subject: "u-1", email: "willow@ssw.com.au" };

test("uploads one private source and publishes one v2 message", async () => {
  const uploaded = [];
  const messages = [];
  const service = createSubmissionService({
    accountName: "satiger",
    storage: { upload: async (...args) => uploaded.push(args), deleteIfExists: async () => {} },
    queue: { publish: async (message) => messages.push(message) },
    now: () => new Date("2026-07-17T01:02:03Z"),
    randomUUID: () => "request-123",
  });

  assert.deepEqual(
    await service.submit({
      projectName: "Tiger Portal",
      fileName: "raw meeting.vtt",
      bytes: validBytes,
      actor: { type: "test", subject: "tester" },
    }),
    {
      requestId: "request-123",
      status: "accepted",
    },
  );
  assert.equal(uploaded.length, 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].sourceType, "uploadedTranscript");
  assert.deepEqual(messages[0].actor, { type: "test", subject: "tester" });
  assert.match(messages[0].source.blobName, /^submissions\/request-123\/2026-07-17-110203-[a-f0-9]{8}\.vtt$/);
  assert.deepEqual(messages[0].project, { displayName: "Tiger Portal", slug: "tiger-portal" });
});

test("does not write when validation fails", async () => {
  let writes = 0;
  const service = createSubmissionService({
    storage: { upload: async () => writes++, deleteIfExists: async () => {} },
    queue: { publish: async () => writes++ },
  });
  await assert.rejects(
    service.submit({ projectName: "Tiger", fileName: "bad.txt", bytes: validBytes, actor }),
    /Only \.vtt/,
  );
  assert.equal(writes, 0);
});

test("rejects a submission with no authenticated actor", async () => {
  let writes = 0;
  const service = createSubmissionService({
    storage: { upload: async () => writes++, deleteIfExists: async () => {} },
    queue: { publish: async () => writes++ },
  });
  await assert.rejects(
    service.submit({ projectName: "Tiger", fileName: "meeting.vtt", bytes: validBytes }),
    /authenticated actor is required/,
  );
  assert.equal(writes, 0);
});

test("cleans up the new blob when queue publish fails", async () => {
  const deleted = [];
  const service = createSubmissionService({
    accountName: "satiger",
    storage: { upload: async () => {}, deleteIfExists: async (name) => deleted.push(name) },
    queue: {
      publish: async () => {
        throw new Error("queue unavailable");
      },
    },
    now: () => new Date("2026-07-17T01:02:03Z"),
    randomUUID: () => "request-123",
  });
  await assert.rejects(
    service.submit({ projectName: "Tiger", fileName: "meeting.vtt", bytes: validBytes, actor }),
    /queue unavailable/,
  );
  assert.equal(deleted.length, 1);
  assert.match(deleted[0], /^submissions\/request-123\/2026-07-17-110203-[a-f0-9]{8}\.vtt$/);
});

test("writes an owned history record when a store is configured", async () => {
  const created = [];
  const service = createSubmissionService({
    accountName: "satiger",
    storage: { upload: async () => {}, deleteIfExists: async () => {} },
    queue: { publish: async () => {} },
    store: { create: async (record) => created.push(record), deleteIfExists: async () => {} },
    now: () => new Date("2026-07-17T01:02:03Z"),
    randomUUID: () => "request-123",
  });
  await service.submit({ projectName: "Tiger Portal", fileName: "m.vtt", bytes: validBytes, actor });
  assert.equal(created.length, 1);
  assert.deepEqual(created[0], {
    id: "request-123",
    type: "submission",
    projectName: "tiger-portal",
    requestId: "request-123",
    displayName: "Tiger Portal",
    userSubject: "u-1",
    userEmail: "willow@ssw.com.au",
    status: "accepted",
    dashboardUrl: null,
    submittedAt: "2026-07-17T01:02:03.000Z",
    updatedAt: "2026-07-17T01:02:03.000Z",
  });
});

test("rolls back the history record when queue publish fails", async () => {
  const removed = [];
  const service = createSubmissionService({
    accountName: "satiger",
    storage: { upload: async () => {}, deleteIfExists: async () => {} },
    queue: {
      publish: async () => {
        throw new Error("queue unavailable");
      },
    },
    store: { create: async () => {}, deleteIfExists: async (id, pk) => removed.push([id, pk]) },
    now: () => new Date("2026-07-17T01:02:03Z"),
    randomUUID: () => "request-123",
  });
  await assert.rejects(
    service.submit({ projectName: "Tiger", fileName: "m.vtt", bytes: validBytes, actor }),
    /queue unavailable/,
  );
  assert.deepEqual(removed, [["request-123", "tiger"]]);
});
