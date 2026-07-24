const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_TRANSCRIPT_BYTES,
  slugifyProjectName,
  decodeAndValidateVtt,
  createCanonicalFileName,
} = require("./submissionValidation");

test("normalizes a project name and accepts a valid VTT", () => {
  assert.deepEqual(slugifyProjectName("  Tiger Portal  "), { displayName: "Tiger Portal", slug: "tiger-portal" });
  assert.equal(
    decodeAndValidateVtt(Buffer.from("WEBVTT\n\n00:00.000 --> 00:01.000\nHello"), "meeting.vtt").startsWith("WEBVTT"),
    true,
  );
});

test("rejects invalid extension, encoding, header, and oversize input", () => {
  assert.throws(() => decodeAndValidateVtt(Buffer.from("WEBVTT"), "meeting.txt"), /Only \.vtt/);
  assert.throws(() => decodeAndValidateVtt(Buffer.from([0xc3, 0x28]), "meeting.vtt"), /UTF-8/);
  assert.throws(() => decodeAndValidateVtt(Buffer.from("hello"), "meeting.vtt"), /WEBVTT/);
  assert.throws(() => decodeAndValidateVtt(Buffer.from("WEBVTT\n\nMeeting notes only"), "meeting.vtt"), /cue/);
  assert.throws(() => decodeAndValidateVtt(Buffer.alloc(MAX_TRANSCRIPT_BYTES + 1, 65), "meeting.vtt"), /10 MB/);
});

test("creates the processor filename contract in Sydney time", () => {
  const first = createCanonicalFileName(new Date("2026-07-17T01:02:03Z"), "request-123");
  const second = createCanonicalFileName(new Date("2026-07-17T01:02:03Z"), "request-456");
  assert.match(first, /^2026-07-17-110203-[a-f0-9]{8}\.vtt$/);
  assert.notEqual(first, second);
  assert.equal(createCanonicalFileName(new Date("2026-07-17T01:02:03Z")), "2026-07-17-110203.vtt");
});
