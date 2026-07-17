const test = require("node:test");
const assert = require("node:assert/strict");
const { createSubmitTranscriptHandler } = require("./SubmitTranscript");
const { SubmissionValidationError } = require("../services/submissionValidation");

function requestWith(fields, contentLength = 100) {
  return {
    headers: { get: (name) => name === "content-length" ? String(contentLength) : name === "content-type" ? "multipart/form-data; boundary=test" : null },
    formData: async () => ({ get: (name) => fields[name] }),
  };
}

const file = {
  name: "meeting.vtt",
  arrayBuffer: async () => Buffer.from("WEBVTT\n\n00:00.000 --> 00:01.000\nHello"),
};

test("returns 202 with the stable submission response", async () => {
  const service = { submit: async () => ({ requestId: "request-123", status: "accepted" }) };
  const response = await createSubmitTranscriptHandler({ service })(
    requestWith({ projectName: "Tiger", file }),
    { log() {}, error() {} },
  );
  assert.equal(response.status, 202);
  assert.deepEqual(response.jsonBody, { requestId: "request-123", status: "accepted" });
  assert.equal(response.headers["Cache-Control"], "no-store");
});

test("maps validation failures without calling downstream infrastructure", async () => {
  const service = { submit: async () => { throw new SubmissionValidationError("Bad VTT", 400, "invalid_vtt"); } };
  const response = await createSubmitTranscriptHandler({ service })(
    requestWith({ projectName: "Tiger", file }),
    { log() {}, error() {} },
  );
  assert.equal(response.status, 400);
  assert.equal(response.jsonBody.error.code, "invalid_vtt");
});

test("rejects oversized requests before parsing multipart content", async () => {
  let parsed = false;
  const request = requestWith({}, 12 * 1024 * 1024);
  request.formData = async () => { parsed = true; };
  const response = await createSubmitTranscriptHandler({ service: {} })(request, {});
  assert.equal(response.status, 413);
  assert.equal(parsed, false);
});

test("returns 400 for a malformed multipart body", async () => {
  const request = requestWith({});
  request.formData = async () => { throw new TypeError("bad boundary"); };
  const response = await createSubmitTranscriptHandler({ service: {} })(request, {});
  assert.equal(response.status, 400);
  assert.equal(response.jsonBody.error.code, "invalid_multipart");
});

test("returns 400 when multipart content type is missing", async () => {
  const request = requestWith({});
  request.headers.get = (name) => name === "content-length" ? "100" : null;
  const response = await createSubmitTranscriptHandler({ service: {} })(request, {});
  assert.equal(response.status, 400);
  assert.equal(response.jsonBody.error.code, "invalid_multipart");
});
