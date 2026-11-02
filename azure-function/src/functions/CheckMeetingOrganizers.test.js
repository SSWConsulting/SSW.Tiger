const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// Capture the timer handler instead of registering it with the Functions host
const functions = require("@azure/functions");
let handler;
functions.app.timer = (_name, options) => {
  handler = options.handler;
};

// Fake Cosmos container: serves `meetings` and records patches
let meetings;
let patches;
const cosmosPath = require.resolve("@azure/cosmos");
require.cache[cosmosPath] = {
  id: cosmosPath,
  filename: cosmosPath,
  loaded: true,
  exports: {
    CosmosClient: class {
      database() {
        return {
          container: () => ({
            items: { query: () => ({ fetchAll: async () => ({ resources: meetings }) }) },
            item: (id, partitionKey) => ({
              patch: async (ops) => patches.push({ id, partitionKey, ops }),
            }),
          }),
        };
      }
    },
  },
};

require("./CheckMeetingOrganizers");

const context = { log() {}, warn() {}, error() {} };
const originalFetch = global.fetch;
let logicAppPosts;
let users;

function teamsMeeting(organizerUserId, onlineMeetingId) {
  return {
    organizerUserId,
    onlineMeetingId,
    subject: `${onlineMeetingId} subject`,
    participantUserIds: [organizerUserId, "isaac"],
  };
}

beforeEach(() => {
  process.env.COSMOS_ENDPOINT = "https://cosmos.test";
  process.env.LOGIC_APP_URL = "https://logic.test/run";
  process.env.GRAPH_TENANT_ID = "tenant";
  process.env.GRAPH_CLIENT_ID = "client";
  process.env.GRAPH_CLIENT_SECRET = "secret";
  meetings = [];
  patches = [];
  logicAppPosts = [];
  users = {};

  global.fetch = async (url, options = {}) => {
    if (url.includes("/oauth2/v2.0/token")) {
      return Response.json({ access_token: "token" });
    }
    if (url.startsWith("https://graph.microsoft.com/v1.0/users/")) {
      const id = decodeURIComponent(url.split("/users/")[1].split("?")[0]);
      return id in users ? Response.json(users[id]) : new Response("", { status: 404 });
    }
    if (url === process.env.LOGIC_APP_URL) {
      logicAppPosts.push(JSON.parse(options.body));
      return new Response("", { status: 202 });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("CheckMeetingOrganizers", () => {
  it("alerts once for a series whose organizer is disabled and marks it", async () => {
    users.uly = { accountEnabled: false, displayName: "Ulysses Maclaren [SSW]" };
    users.isaac = { accountEnabled: true, displayName: "Isaac Lombard [SSW]" };
    meetings = [
      { id: "design-1", projectName: "ssw-design", meetingDate: "2026-10-09", teamsMeeting: teamsMeeting("uly", "design") },
      { id: "design-2", projectName: "ssw-design", meetingDate: "2026-10-16", teamsMeeting: teamsMeeting("uly", "design") },
      { id: "crm-1", projectName: "crm", meetingDate: "2026-10-23", teamsMeeting: teamsMeeting("isaac", "crm") },
    ];

    await handler({}, context);

    assert.equal(logicAppPosts.length, 1);
    assert.equal(logicAppPosts[0].notificationType, "organizer-disabled");
    assert.equal(logicAppPosts[0].organizerName, "Ulysses Maclaren [SSW]");
    assert.deepEqual(logicAppPosts[0].participants, [{ userId: "isaac" }]);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].id, "design-2");
    assert.equal(patches[0].partitionKey, "ssw-design");
    assert.equal(patches[0].ops[0].path, "/organizerAlertSentAt");
  });

  it("treats a deleted organizer (404) as gone", async () => {
    meetings = [{ id: "m", projectName: "p", meetingDate: "2026-10-16", teamsMeeting: teamsMeeting("deleted", "s") }];

    await handler({}, context);

    assert.equal(logicAppPosts.length, 1);
  });

  it("does not mark the series when the Logic App fails, so tomorrow retries", async () => {
    users.uly = { accountEnabled: false, displayName: "Uly" };
    meetings = [{ id: "m", projectName: "p", meetingDate: "2026-10-16", teamsMeeting: teamsMeeting("uly", "s") }];
    const fetchWithFailingLogicApp = global.fetch;
    global.fetch = async (url, options) =>
      url === process.env.LOGIC_APP_URL ? new Response("boom", { status: 500 }) : fetchWithFailingLogicApp(url, options);

    await handler({}, context);

    assert.deepEqual(patches, []);
  });

  it("does nothing when Cosmos or the Logic App are not configured", async () => {
    delete process.env.LOGIC_APP_URL;
    meetings = [{ id: "m", projectName: "p", meetingDate: "2026-10-16", teamsMeeting: teamsMeeting("gone", "s") }];

    await handler({}, context);

    assert.deepEqual(patches, []);
  });
});
