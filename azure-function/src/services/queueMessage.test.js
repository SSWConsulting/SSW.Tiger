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

test("rejects malformed or unsupported messages", () => {
  assert.throws(() => normalizeQueueMessage("not-json"), /Invalid JSON/);
  assert.throws(() => normalizeQueueMessage({ sourceType: "uploadedTranscript" }), /Invalid uploaded/);
  assert.throws(() => normalizeQueueMessage({ sourceType: "meetingLink", schemaVersion: 2, requestId: "r", project: { displayName: "T", slug: "t" } }), /Missing meeting link locator/);
  assert.throws(() => normalizeQueueMessage({ sourceType: "email" }), /Unsupported/);
});
