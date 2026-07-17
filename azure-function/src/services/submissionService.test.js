const test = require("node:test");
const assert = require("node:assert/strict");
const { createSubmissionService } = require("./submissionService");

const validBytes = Buffer.from("WEBVTT\n\n00:00.000 --> 00:01.000\nHello");

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

  assert.deepEqual(await service.submit({ projectName: "Tiger Portal", fileName: "raw meeting.vtt", bytes: validBytes, actor: { type: "test", subject: "tester" } }), {
    requestId: "request-123",
    status: "accepted",
  });
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
  await assert.rejects(service.submit({ projectName: "Tiger", fileName: "bad.txt", bytes: validBytes }), /Only \.vtt/);
  assert.equal(writes, 0);
});

test("cleans up the new blob when queue publish fails", async () => {
  const deleted = [];
  const service = createSubmissionService({
    accountName: "satiger",
    storage: { upload: async () => {}, deleteIfExists: async (name) => deleted.push(name) },
    queue: { publish: async () => { throw new Error("queue unavailable"); } },
    now: () => new Date("2026-07-17T01:02:03Z"),
    randomUUID: () => "request-123",
  });
  await assert.rejects(service.submit({ projectName: "Tiger", fileName: "meeting.vtt", bytes: validBytes }), /queue unavailable/);
  assert.equal(deleted.length, 1);
  assert.match(deleted[0], /^submissions\/request-123\/2026-07-17-110203-[a-f0-9]{8}\.vtt$/);
});
