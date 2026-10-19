const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs").promises;
const os = require("os");
const path = require("path");

const cosmos = require("../lib/cosmosClient");
const { writeMeetingHistory } = require("./meetingHistory");

const CURRENT = "2026-10-13-130104";

describe("writeMeetingHistory", () => {
  let meetingPath;
  const original = {
    queryMeetings: cosmos.queryMeetings,
    getProjectPolicy: cosmos.getProjectPolicy,
    listMeetingSecurityByProject: cosmos.listMeetingSecurityByProject,
    endpoint: process.env.COSMOS_ENDPOINT,
  };

  const readJson = async (name) =>
    JSON.parse(await fs.readFile(path.join(meetingPath, "history", name), "utf-8"));
  const run = () => writeMeetingHistory({ projectName: "tina", meetingId: CURRENT, meetingPath });

  beforeEach(async () => {
    meetingPath = await fs.mkdtemp(path.join(os.tmpdir(), "history-"));
    process.env.COSMOS_ENDPOINT = "https://example.documents.azure.com:443/";
    cosmos.getProjectPolicy = async () => null;
    cosmos.listMeetingSecurityByProject = async () => [];
  });

  afterEach(async () => {
    cosmos.queryMeetings = original.queryMeetings;
    cosmos.getProjectPolicy = original.getProjectPolicy;
    cosmos.listMeetingSecurityByProject = original.listMeetingSecurityByProject;
    if (original.endpoint === undefined) delete process.env.COSMOS_ENDPOINT;
    else process.env.COSMOS_ENDPOINT = original.endpoint;
    await fs.rm(meetingPath, { recursive: true, force: true });
  });

  it("writes earlier analysed meetings, trimmed to the audited fields, and a loaded status", async () => {
    let queryArgs;
    cosmos.queryMeetings = async (args) => {
      queryArgs = args;
      return [
        { meetingId: "2026-10-13-101845", meetingDate: "2026-10-13", consolidated: { nextSteps: ["a"], timeline: ["big"] } },
        { meetingId: "2026-09-29-100000", meetingDate: "2026-09-29", consolidated: { nextSteps: ["b"] } },
      ];
    };

    await run();

    assert.equal(queryArgs.beforeMeetingId, CURRENT);
    assert.equal(queryArgs.requireConsolidated, true);
    assert.deepEqual(await readJson("status.json"), {
      status: "loaded",
      meetingIds: ["2026-10-13-101845", "2026-09-29-100000"],
    });
    const record = await readJson("2026-10-13-101845.json");
    assert.deepEqual(record.consolidated, { nextSteps: ["a"] });
  });

  it("excludes individually protected meetings when the project is public", async () => {
    cosmos.listMeetingSecurityByProject = async () => [
      { meetingId: "2026-09-29-100000", passwordEnabled: true },
      { meetingId: "2026-09-15-100000", passwordEnabled: false },
    ];
    let queryArgs;
    cosmos.queryMeetings = async (args) => {
      queryArgs = args;
      return [];
    };

    await run();

    assert.deepEqual(queryArgs.excludeMeetingIds, ["2026-09-29-100000"]);
  });

  it("keeps protected meetings when the whole project is protected, and flags the run", async () => {
    cosmos.getProjectPolicy = async () => ({ passwordProtectionEnabled: true });
    cosmos.listMeetingSecurityByProject = async () => [{ meetingId: "2026-09-29-100000", passwordEnabled: true }];
    let queryArgs;
    cosmos.queryMeetings = async (args) => {
      queryArgs = args;
      return [{ meetingId: "2026-09-29-100000", meetingDate: "2026-09-29", consolidated: { nextSteps: ["b"] } }];
    };

    const result = await run();

    assert.deepEqual(queryArgs.excludeMeetingIds, []);
    assert.equal(result.includesProtectedMeetings, true);
  });

  it("writes a none status and clears stale files when there are no earlier meetings", async () => {
    await fs.mkdir(path.join(meetingPath, "history"));
    await fs.writeFile(path.join(meetingPath, "history", "stale.json"), "{}");
    cosmos.queryMeetings = async () => [];

    await run();

    assert.deepEqual(await fs.readdir(path.join(meetingPath, "history")), ["status.json"]);
    assert.deepEqual(await readJson("status.json"), { status: "none" });
  });

  it("writes an unavailable status without querying when Cosmos isn't configured", async () => {
    delete process.env.COSMOS_ENDPOINT;
    let queried = false;
    cosmos.queryMeetings = async () => {
      queried = true;
      return [];
    };

    await run();

    assert.equal((await readJson("status.json")).status, "unavailable");
    assert.equal(queried, false);
  });

  it("removes partly written history when a write fails, so protected data can't linger", async () => {
    cosmos.getProjectPolicy = async () => ({ passwordProtectionEnabled: true });
    cosmos.queryMeetings = async () => [
      { meetingId: "2026-10-06-100000", meetingDate: "2026-10-06", consolidated: { nextSteps: ["a"] } },
      // BigInt can't be serialised, so writing the second file throws
      { meetingId: "2026-09-29-100000", meetingDate: "2026-09-29", consolidated: { nextSteps: [1n] } },
    ];

    const result = await run();

    assert.equal(result.status, "unavailable");
    assert.equal(result.includesProtectedMeetings, undefined);
    await assert.rejects(fs.access(path.join(meetingPath, "history", "2026-10-06-100000.json")));
  });

  it("writes an unavailable status instead of throwing when Cosmos fails", async () => {
    cosmos.queryMeetings = async () => {
      throw new Error("boom");
    };

    const result = await run();

    assert.equal(result.status, "unavailable");
    assert.equal((await readJson("status.json")).status, "unavailable");
  });
});
