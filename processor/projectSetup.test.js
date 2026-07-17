const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");

const { validateTranscriptFilename, setupProjectStructure } = require("./projectSetup");

describe("validateTranscriptFilename", () => {
  it("parses a well-formed transcript filename", () => {
    const result = validateTranscriptFilename("/some/dir/2026-01-22-094557.vtt");
    assert.deepEqual(result, {
      meetingId: "2026-01-22-094557",
      meetingDate: "2026-01-22",
      meetingTime: "094557",
    });
  });

  it("throws for a filename that doesn't match the date-time pattern", () => {
    assert.throws(() => validateTranscriptFilename("/some/dir/standup.vtt"), /Invalid transcript filename/);
  });

  it("throws for a non-.vtt extension", () => {
    assert.throws(
      () => validateTranscriptFilename("/some/dir/2026-01-22-094557.txt"),
      /Invalid transcript filename|Invalid transcript file extension/,
    );
  });
});

describe("setupProjectStructure", () => {
  let tmpRoot;
  let meetingPath;
  let transcriptPath;

  before(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tiger-project-setup-test-"));
    meetingPath = path.join(tmpRoot, "projects", "yakshaver", "2026-01-22-094557");
    transcriptPath = path.join(tmpRoot, "source-transcript.vtt");
    await fs.writeFile(transcriptPath, "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello");
  });

  after(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("creates analysis, dashboard, and dashboard-parts directories, and copies the transcript", async () => {
    await setupProjectStructure({ meetingPath, transcriptPath });

    const dirs = ["analysis", "dashboard", "dashboard-parts"];
    for (const dir of dirs) {
      const stat = await fs.stat(path.join(meetingPath, dir));
      assert.ok(stat.isDirectory(), `${dir} should be a directory`);
    }

    const copied = await fs.readFile(path.join(meetingPath, "transcript.vtt"), "utf-8");
    assert.match(copied, /WEBVTT/);
  });

  it("clears stale dashboard-parts fragments left over from a prior run on the next setup call", async () => {
    // Simulate leftover fragments from a previous generation of the same meeting ID.
    const dashboardPartsDir = path.join(meetingPath, "dashboard-parts");
    await fs.writeFile(path.join(dashboardPartsDir, "SUMMARY.html"), "<li>stale summary</li>");
    await fs.writeFile(path.join(dashboardPartsDir, "HARD_TRUTHS.html"), "<p>stale</p>");
    await fs.writeFile(path.join(dashboardPartsDir, ".gitkeep"), "");

    await setupProjectStructure({ meetingPath, transcriptPath });

    const remaining = await fs.readdir(dashboardPartsDir);
    assert.deepEqual(remaining.filter((f) => f.endsWith(".html")), [], "all stale .html fragments must be removed");
    assert.ok(remaining.includes(".gitkeep"), "non-.html files must not be touched");
  });

  it("clears stale analysis JSON left over from a prior run on the next setup call", async () => {
    const analysisDir = path.join(meetingPath, "analysis");
    await fs.writeFile(path.join(analysisDir, "timeline.json"), "{}");

    await setupProjectStructure({ meetingPath, transcriptPath });

    const remaining = await fs.readdir(analysisDir);
    assert.deepEqual(remaining.filter((f) => f.endsWith(".json")), []);
  });

  it("does not throw when dashboard-parts does not exist yet (first-ever run)", async () => {
    const freshMeetingPath = path.join(tmpRoot, "projects", "yakshaver", "2026-02-01-100000");
    await assert.doesNotReject(() => setupProjectStructure({ meetingPath: freshMeetingPath, transcriptPath }));
    const stat = await fs.stat(path.join(freshMeetingPath, "dashboard-parts"));
    assert.ok(stat.isDirectory());
  });
});
