const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// Capture the HTTP handler instead of registering it with the Functions host
const functions = require("@azure/functions");
let handler;
functions.app.http = (_name, options) => {
  handler = options.handler;
};
require("./TriggerProcessing");

const ORGANIZER = "c5d711a1-8a57-4384-b4f3-aa20462296c4";
const JOIN_URL =
  "https://teams.microsoft.com/l/meetup-join/19%3a881bf4b4ec6d41a1aeebf5b2d174fa44%40thread.skype/1694564692495" +
  `?context=${encodeURIComponent(JSON.stringify({ Tid: "tenant", Oid: ORGANIZER }))}`;
const MEETING_ID =
  "MSpjNWQ3MTFhMS04YTU3LTQzODQtYjRmMy1hYTIwNDYyMjk2YzQqMTY5NDU2NDY5MjQ5NSoqMTk6ODgxYmY0YjRlYzZkNDFhMWFlZWJmNWIyZDE3NGZhNDRAdGhyZWFkLnNreXBl";

const originalFetch = global.fetch;
let graphCalls;
let queued;
let context;

function postRequest(body = {}) {
  return {
    method: "POST",
    query: new URLSearchParams(),
    headers: new Headers({ accept: "application/json" }),
    json: async () => ({ joinUrl: JOIN_URL, ...body }),
  };
}

beforeEach(() => {
  process.env.GRAPH_TENANT_ID = "tenant";
  process.env.GRAPH_CLIENT_ID = "client";
  process.env.GRAPH_CLIENT_SECRET = "secret";
  graphCalls = [];
  queued = null;
  context = {
    log() {},
    warn() {},
    error() {},
    extraOutputs: { set: (_output, messages) => (queued = messages) },
  };

  // A departed organizer: the JoinWebUrl filter 404s, lookups by ID still work
  global.fetch = async (url) => {
    if (url.includes("/oauth2/v2.0/token")) return Response.json({ access_token: "token" });
    graphCalls.push(url);
    if (url.includes("$filter=JoinWebUrl")) {
      return Response.json({ error: { code: "NotFound", message: "3004: Meeting properties are not found" } }, { status: 404 });
    }
    if (url.endsWith(`/onlineMeetings/${MEETING_ID}`)) {
      return Response.json({ id: MEETING_ID, subject: "SSW Design - Sprint Review" });
    }
    if (url.endsWith(`/onlineMeetings/${MEETING_ID}/transcripts`)) {
      return Response.json({
        value: [
          { id: "last-week", createdDateTime: "2026-10-16T00:47:22Z" },
          { id: "today-a", createdDateTime: "2026-10-29T23:33:01Z" },
          { id: "today-b", createdDateTime: "2026-10-30T00:32:31Z" },
        ],
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("TriggerProcessing", () => {
  it("falls back to the meeting ID when the JoinWebUrl lookup 404s (departed organizer)", async () => {
    const response = await handler(postRequest(), context);

    assert.equal(response.status, 202);
    assert.ok(graphCalls.some((url) => url.endsWith(`/users/${ORGANIZER}/onlineMeetings/${MEETING_ID}`)));
  });

  it("queues every transcript from the latest occurrence, not last week's", async () => {
    await handler(postRequest(), context);

    assert.deepEqual(
      queued.map((m) => m.transcriptId),
      ["today-a", "today-b"],
    );
    assert.ok(queued.every((m) => m.userId === ORGANIZER && m.meetingId === MEETING_ID && m.manualTrigger));
  });

  it("queues only the given transcript when the skipped card passes one", async () => {
    const response = await handler(postRequest({ transcriptId: "today-a" }), context);

    assert.equal(response.status, 202);
    assert.deepEqual(
      queued.map((m) => m.transcriptId),
      ["today-a"],
    );
  });

  it("reads the transcript ID from the query string (the form POSTs back to the card's URL)", async () => {
    const request = postRequest();
    request.query = new URLSearchParams({ joinUrl: JOIN_URL, transcriptId: "last-week" });

    await handler(request, context);

    assert.deepEqual(
      queued.map((m) => m.transcriptId),
      ["last-week"],
    );
  });

  it("reports not found for a transcript the meeting doesn't have", async () => {
    const response = await handler(postRequest({ transcriptId: "nope" }), context);

    assert.equal(response.status, 404);
    assert.equal(queued, null);
  });

  it("still reports not found when the meeting doesn't exist by ID either", async () => {
    const fetchWithMissingMeeting = global.fetch;
    global.fetch = async (url, options) =>
      url.endsWith(`/onlineMeetings/${MEETING_ID}`) ? new Response("", { status: 404 }) : fetchWithMissingMeeting(url, options);

    const response = await handler(postRequest(), context);

    assert.equal(response.status, 404);
    assert.equal(queued, null);
  });
});
