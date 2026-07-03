const { describe, it, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");

// Required env vars must be set BEFORE the module is required, since CONFIG
// is computed once at module load time from process.env.
process.env.GRAPH_CLIENT_ID = "test-client-id";
process.env.GRAPH_CLIENT_SECRET = "test-client-secret";
process.env.GRAPH_TENANT_ID = "test-tenant-id";
process.env.GRAPH_USER_ID = "test-user-id";
process.env.GRAPH_MEETING_ID = "test-meeting-id";
process.env.GRAPH_TRANSCRIPT_ID = "test-transcript-id";
process.env.SKIP_SUBJECT_FILTER = "true";
process.env.OUTPUT_PATH = path.join(os.tmpdir(), "vulture-73-test.vtt");

const { main, isExternalPerson } = require("./downloadTranscript");

const SSW_TENANT_ID = "ac2f7c34-b935-48e9-abdc-11e5d4fcb2b0";

// Chat message events that fetchActualParticipantsFromChat parses into the
// [{userId, displayName, tenantId, userIdentityType}] shape used for
// notification filtering.
const CHAT_MESSAGES = [
  {
    createdDateTime: "2026-07-01T09:59:00Z",
    eventDetail: {
      "@odata.type": "#microsoft.graph.callStartedEventMessageDetail",
      callId: "call-1",
      initiator: {
        user: {
          id: "internal-user-1",
          displayName: "Alice SSW",
          tenantId: SSW_TENANT_ID,
          userIdentityType: "aadUser",
        },
      },
    },
  },
  {
    createdDateTime: "2026-07-01T11:01:00Z",
    eventDetail: {
      "@odata.type": "#microsoft.graph.callEndedEventMessageDetail",
      callId: "call-1",
      callParticipants: [
        {
          participant: {
            user: {
              id: "internal-user-1",
              displayName: "Alice SSW",
              tenantId: SSW_TENANT_ID,
              userIdentityType: "aadUser",
            },
          },
        },
        {
          participant: {
            user: {
              id: "external-user-1",
              displayName: "Bob Client",
              tenantId: "some-other-tenant-id",
              userIdentityType: "aadUser",
            },
          },
        },
      ],
    },
  },
];

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function textResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => body,
  };
}

function makeFetchMock() {
  return async (url) => {
    const u = String(url);
    if (u.includes("/oauth2/v2.0/token")) {
      return jsonResponse({ access_token: "fake-token" });
    }
    if (u.includes("/transcripts/") && u.includes("/content")) {
      return textResponse(
        "WEBVTT\n\n00:00:00.000 --> 00:00:05.000\n<v Alice SSW>Hello everyone.\n",
      );
    }
    if (u.includes("/transcripts/")) {
      return jsonResponse({
        createdDateTime: "2026-07-01T10:00:00Z",
        callId: "call-1",
      });
    }
    if (u.includes("/messages")) {
      return jsonResponse({ value: CHAT_MESSAGES });
    }
    if (u.includes("/onlineMeetings/")) {
      return jsonResponse({
        subject: "[TestProject] Spec Review",
        chatInfo: { threadId: "chat-1" },
        participants: {
          organizer: { upn: "alice@ssw.com.au", identity: { user: { id: "internal-user-1" } } },
          attendees: [],
        },
      });
    }
    throw new Error(`Unmocked fetch URL: ${u}`);
  };
}

describe("downloadTranscript main() - external participant handling (issue #73)", () => {
  let originalFetch;
  let originalExit;
  let originalConsoleLog;
  let exitCode;
  let output;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalExit = process.exit;
    originalConsoleLog = console.log;

    output = null;
    exitCode = undefined;

    global.fetch = makeFetchMock();

    console.log = (msg) => {
      try {
        output = JSON.parse(msg);
      } catch {
        // ignore non-JSON log lines
      }
    };

    // main() calls process.exit(0) as the last statement of its success path
    // (and process.exit(1) as the last statement of its catch block);
    // intercept it so the test process itself doesn't exit. Since it is
    // always the final statement reached, simply recording the code (rather
    // than throwing) reproduces real process.exit's effect for this test.
    process.exit = (code) => {
      exitCode = code;
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.exit = originalExit;
    console.log = originalConsoleLog;
  });

  it("does not skip a meeting with an external participant - it processes it fully", async () => {
    await main();

    assert.equal(exitCode, 0);
    assert.ok(output, "expected outputResult to have been called with JSON");
    assert.equal(output.skipped, undefined, "meeting must not be skipped");
    assert.equal(output.success, true, "meeting must be processed successfully");
    assert.ok(output.transcriptPath, "transcript should still be saved");
  });

  it("excludes external participants from the notification recipient list while keeping internal ones", async () => {
    await main();

    assert.ok(Array.isArray(output.participants));
    const ids = output.participants.map((p) => p.userId);
    assert.ok(
      ids.includes("internal-user-1"),
      "internal SSW participant must still be included",
    );
    assert.ok(
      !ids.includes("external-user-1"),
      "external participant must be excluded from notification recipients",
    );
  });
});

describe("isExternalPerson (reused, unchanged helper)", () => {
  it("flags a person from a different tenant as external", () => {
    const result = isExternalPerson({
      displayName: "Bob Client",
      tenantId: "some-other-tenant-id",
      userIdentityType: "aadUser",
    });
    assert.equal(result.isExternal, true);
  });

  it("does not flag an SSW-tenant person as external", () => {
    const result = isExternalPerson({
      displayName: "Alice SSW",
      tenantId: SSW_TENANT_ID,
      userIdentityType: "aadUser",
    });
    assert.equal(result.isExternal, false);
  });
});
