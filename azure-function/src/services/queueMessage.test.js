const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeQueueMessage, buildDedupKey, buildJobEnvironment } = require("./queueMessage");

test("treats a legacy message without sourceType as Graph v1", () => {
  const normalized = normalizeQueueMessage({ userId: "u", meetingId: "m", transcriptId: "t" });
  assert.equal(normalized.sourceType, "graphTranscript");
  assert.equal(buildDedupKey(normalized), "m-t");
  const env = buildJobEnvironment(normalized, {});
  assert.equal(env.find((item) => item.name === "GRAPH_MEETING_ID").value, "m");
  assert.equal(env.find((item) => item.name === "TRANSCRIPT_SOURCE_TYPE").value, "graphTranscript");
});

test("normalizes v2 upload and deduplicates by requestId", () => {
  const normalized = normalizeQueueMessage({
    schemaVersion: 2,
    requestId: "r1",
    sourceType: "uploadedTranscript",
    project: { displayName: "Tiger", slug: "tiger" },
    source: { storageAccount: "sa", containerName: "private", blobName: "path/file.vtt", fileName: "2026-01-01-010203.vtt" },
  });
  assert.equal(buildDedupKey(normalized), "upload-r1");
  const env = buildJobEnvironment(normalized, {});
  assert.equal(env.find((item) => item.name === "TRANSCRIPT_BLOB_NAME").value, "path/file.vtt");
  assert.equal(env.some((item) => item.name === "GRAPH_MEETING_ID"), false);
});

test("normalizes v2 meeting link and builds join-url job env", () => {
  const normalized = normalizeQueueMessage({
    schemaVersion: 2,
    sourceType: "meetingLink",
    requestId: "r2",
    project: { displayName: "Tiger", slug: "tiger" },
    joinUrl: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=%7b%22Oid%22%3a%22org-1%22%7d",
    organizerId: "org-1",
  });
  assert.equal(buildDedupKey(normalized), "meeting-r2");
  const env = buildJobEnvironment(normalized, {});
  assert.equal(env.find((item) => item.name === "TRANSCRIPT_SOURCE_TYPE").value, "meetingLink");
  assert.equal(env.find((item) => item.name === "MEETING_ORGANIZER_ID").value, "org-1");
  assert.equal(env.find((item) => item.name === "UPLOAD_PROJECT_SLUG").value, "tiger");
  assert.equal(env.some((item) => item.name === "GRAPH_MEETING_ID"), false);
});

test("normalizes v2 meeting link by Meeting ID and builds resolver job env", () => {
  const normalized = normalizeQueueMessage({
    schemaVersion: 2,
    sourceType: "meetingLink",
    requestId: "r5",
    project: { displayName: "Tiger", slug: "tiger" },
    joinMeetingId: "47769649877490",
    resolverUserIds: ["me@ssw.com.au", "bob@ssw.com.au"],
  });
  assert.equal(buildDedupKey(normalized), "meeting-r5");
  const env = buildJobEnvironment(normalized, {});
  assert.equal(env.find((item) => item.name === "MEETING_JOIN_MEETING_ID").value, "47769649877490");
  assert.equal(env.find((item) => item.name === "MEETING_RESOLVER_USER_IDS").value, "me@ssw.com.au,bob@ssw.com.au");
  assert.equal(env.some((item) => item.name === "MEETING_JOIN_URL"), false);
});

test("carries the submitter through to the job as an audit label", () => {
  const normalized = normalizeQueueMessage({
    schemaVersion: 2,
    sourceType: "meetingLink",
    requestId: "r6",
    project: { displayName: "", slug: "meeting-abc12345" },
    joinMeetingId: "47769649877490",
    resolverUserIds: ["me@ssw.com.au"],
    actor: { type: "user", subject: "sid-1", email: "me@ssw.com.au", roles: [] },
  });

  // Only the two identity fields survive — roles and type would invite someone to
  // make an authorization decision on a value that arrived over a queue.
  assert.deepEqual(normalized.actor, { email: "me@ssw.com.au", subject: "sid-1" });
  const env = buildJobEnvironment(normalized, {});
  assert.equal(env.find((item) => item.name === "SUBMITTED_BY").value, "me@ssw.com.au");
});

test("falls back to the subject, then to blank, when no submitter email is known", () => {
  const base = {
    schemaVersion: 2,
    sourceType: "uploadedTranscript",
    requestId: "r7",
    project: { displayName: "Tiger", slug: "tiger" },
    source: { storageAccount: "sa", containerName: "c", blobName: "b.vtt", fileName: "2026-01-01-010203.vtt" },
  };
  const noEmail = normalizeQueueMessage({ ...base, actor: { subject: "sid-2", email: null } });
  assert.equal(buildJobEnvironment(noEmail, {}).find((i) => i.name === "SUBMITTED_BY").value, "sid-2");

  // A message with no actor at all must still be processable — the audit label is
  // for humans reading logs, never a gate on the submission.
  const noActor = normalizeQueueMessage(base);
  assert.equal(noActor.actor, null);
  assert.equal(buildJobEnvironment(noActor, {}).find((i) => i.name === "SUBMITTED_BY").value, "");
});

test("rejects malformed or unsupported messages", () => {
  assert.throws(() => normalizeQueueMessage("not-json"), /Invalid JSON/);
  assert.throws(() => normalizeQueueMessage({ sourceType: "uploadedTranscript" }), /Invalid uploaded/);
  assert.throws(() => normalizeQueueMessage({ sourceType: "meetingLink", schemaVersion: 2, requestId: "r", project: { displayName: "T", slug: "t" } }), /Missing meeting link locator/);
  assert.throws(() => normalizeQueueMessage({ sourceType: "email" }), /Unsupported/);
});
