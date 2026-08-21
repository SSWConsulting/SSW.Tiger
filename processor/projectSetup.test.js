const test = require("node:test");
const assert = require("node:assert/strict");
const { validateTranscriptFilename } = require("./projectSetup");

test("accepts legacy and collision-resistant transcript filenames", () => {
  assert.deepEqual(validateTranscriptFilename("2026-07-17-110203.vtt"), {
    meetingId: "2026-07-17-110203",
    meetingDate: "2026-07-17",
    meetingTime: "110203",
  });
  assert.deepEqual(validateTranscriptFilename("2026-07-17-110203-a1b2c3d4.vtt"), {
    meetingId: "2026-07-17-110203-a1b2c3d4",
    meetingDate: "2026-07-17",
    meetingTime: "110203",
  });
});
