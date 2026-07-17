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

test("rejects malformed or unsupported messages", () => {
  assert.throws(() => normalizeQueueMessage("not-json"), /Invalid JSON/);
  assert.throws(() => normalizeQueueMessage({ sourceType: "uploadedTranscript" }), /Invalid uploaded/);
  assert.throws(() => normalizeQueueMessage({ sourceType: "email" }), /Unsupported/);
});
