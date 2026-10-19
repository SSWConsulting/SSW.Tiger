const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs").promises;
const os = require("os");
const path = require("path");

const cosmos = require("../lib/cosmosClient");
const { writeMeetingHistory } = require("./meetingHistory");

describe("writeMeetingHistory", () => {
  let meetingPath;
  const originalQuery = cosmos.queryMeetings;
  const originalEndpoint = process.env.COSMOS_ENDPOINT;

  beforeEach(async () => {
    meetingPath = await fs.mkdtemp(path.join(os.tmpdir(), "history-"));
    process.env.COSMOS_ENDPOINT = "https://example.documents.azure.com:443/";
  });

  afterEach(async () => {
    cosmos.queryMeetings = originalQuery;
    if (originalEndpoint === undefined) delete process.env.COSMOS_ENDPOINT;
    else process.env.COSMOS_ENDPOINT = originalEndpoint;
    await fs.rm(meetingPath, { recursive: true, force: true });
  });

  it("asks only for earlier analysed meetings and writes one file per meeting", async () => {
    let queryArgs;
    cosmos.queryMeetings = async (args) => {
      queryArgs = args;
      return [
        { meetingId: "2026-10-13-101845", meetingDate: "2026-10-13", consolidated: { nextSteps: ["a"] } },
        { meetingId: "2026-09-29-100000", meetingDate: "2026-09-29", consolidated: { nextSteps: ["b"] } },
      ];
    };

    const result = await writeMeetingHistory({ projectName: "tina", meetingId: "2026-10-13-130104", meetingPath });

    assert.equal(queryArgs.beforeMeetingId, "2026-10-13-130104");
    assert.equal(queryArgs.requireConsolidated, true);
    assert.deepEqual(result, { status: "loaded", meetingIds: ["2026-10-13-101845", "2026-09-29-100000"] });
    const files = (await fs.readdir(path.join(meetingPath, "history"))).sort();
    assert.deepEqual(files, ["2026-09-29-100000.json", "2026-10-13-101845.json"]);
    const record = JSON.parse(await fs.readFile(path.join(meetingPath, "history", "2026-09-29-100000.json"), "utf-8"));
    assert.deepEqual(record.consolidated, { nextSteps: ["b"] });
  });

  it("reports none and clears stale files when the project has no earlier meetings", async () => {
    await fs.mkdir(path.join(meetingPath, "history"));
    await fs.writeFile(path.join(meetingPath, "history", "stale.json"), "{}");
    cosmos.queryMeetings = async () => [];

    const result = await writeMeetingHistory({ projectName: "tina", meetingId: "2026-10-13-130104", meetingPath });

    assert.deepEqual(result, { status: "none" });
    await assert.rejects(fs.access(path.join(meetingPath, "history")));
  });

  it("reports unavailable without querying when Cosmos isn't configured", async () => {
    delete process.env.COSMOS_ENDPOINT;
    let queried = false;
    cosmos.queryMeetings = async () => {
      queried = true;
      return [];
    };

    const result = await writeMeetingHistory({ projectName: "tina", meetingId: "2026-10-13-130104", meetingPath });

    assert.deepEqual(result, { status: "unavailable" });
    assert.equal(queried, false);
  });

  it("reports unavailable instead of throwing when Cosmos fails", async () => {
    cosmos.queryMeetings = async () => {
      throw new Error("boom");
    };

    const result = await writeMeetingHistory({ projectName: "tina", meetingId: "2026-10-13-130104", meetingPath });

    assert.deepEqual(result, { status: "unavailable" });
  });
});
