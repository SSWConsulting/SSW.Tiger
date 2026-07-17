const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const { parseJoinUrl, downloadFromMeetingLink } = require("./downloadFromMeetingLink");

const joinUrl = `https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=${encodeURIComponent(
  JSON.stringify({ Tid: "tenant-1", Oid: "organizer-1" }),
)}`;

const baseEnv = {
  MEETING_JOIN_URL: joinUrl,
  MEETING_ORGANIZER_ID: "organizer-1",
  UPLOAD_REQUEST_ID: "r1",
  UPLOAD_PROJECT_NAME: "Tiger Portal",
  UPLOAD_PROJECT_SLUG: "tiger-portal",
  GRAPH_TENANT_ID: "tenant-1",
  GRAPH_CLIENT_ID: "client-1",
  GRAPH_CLIENT_SECRET: "secret-1",
};

test("parses organizer + tenant from a Teams join URL, and reports link problems", () => {
  assert.deepEqual(parseJoinUrl(joinUrl), { userId: "organizer-1", tenantId: "tenant-1" });
  assert.match(parseJoinUrl("https://example.com").error, /Teams meeting link/);
  assert.match(parseJoinUrl("https://teams.microsoft.com/l/meetup-join/19:x/0").error, /missing meeting info/);
});

test("resolves the latest transcript and returns a Graph-compatible shape", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tiger-link-"));
  const graph = {
    token: async () => "tok",
    findMeeting: async () => ({ id: "meeting-9", subject: "Sprint Review" }),
    latestTranscript: async () => ({ id: "t2", createdDateTime: "2026-07-10T04:05:06Z" }),
    content: async () => "WEBVTT\n\n00:00.000 --> 00:01.000\n<v Willow Lyu>Hello",
  };
  const result = await downloadFromMeetingLink({ env: { ...baseEnv, OUTPUT_PATH: path.join(dir, "out.vtt") }, graph });
  assert.equal(result.projectName, "tiger-portal");
  assert.equal(result.meetingDate, "2026-07-10");
  assert.match(result.filename, /^2026-07-10-\d{6}-[a-f0-9]{8}\.vtt$/);
  assert.match(result.meetingSubject, /Sprint Review/);
  assert.deepEqual(result.vttInfo, { hasSpeakerLabels: true, taggedSpeakerCount: 1, taggedSpeakers: ["Willow Lyu"] });
  assert.equal((await fs.readFile(result.transcriptPath, "utf8")).startsWith("WEBVTT"), true);
});

test("surfaces a clear error when no transcript exists yet", async () => {
  const graph = {
    token: async () => "tok",
    findMeeting: async () => ({ id: "meeting-9" }),
    latestTranscript: async () => null,
    content: async () => {
      throw new Error("should not be called");
    },
  };
  await assert.rejects(downloadFromMeetingLink({ env: baseEnv, graph }), /No transcript is available/);
});
