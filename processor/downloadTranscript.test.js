const assert = require("node:assert/strict");
const { describe, it, beforeEach, afterEach } = require("node:test");

const {
  fetchTranscriptMetadata,
  downloadTranscriptContent,
  CONFIG,
} = require("./downloadTranscript");

// The retry backoff calls global setTimeout with real multi-second delays.
// Tests enable node:test mock timers and pump the event loop, advancing
// mocked time between macrotask turns until the promise under test settles.
function pumpUntilSettled(t, promise) {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return (async () => {
    while (!settled) {
      // setImmediate is not mocked, so this yields a real macrotask turn.
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(300_000);
    }
    return promise;
  })();
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

describe("transcript fetch retry and recovery (#153)", () => {
  const originalFetch = global.fetch;
  const originalTranscriptId = CONFIG.transcriptId;

  beforeEach(() => {
    CONFIG.userId = "user-1";
    CONFIG.meetingId = "meeting-1";
    CONFIG.transcriptId = "transcript-1";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    CONFIG.transcriptId = originalTranscriptId;
  });

  it("retries transcript metadata on 404 and succeeds once Graph catches up", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const calls = [];
    global.fetch = async (url) => {
      calls.push(url);
      return calls.length === 1
        ? jsonResponse(404, { error: { code: "NotFound" } })
        : jsonResponse(200, { id: "transcript-1", createdDateTime: "2026-08-19T05:44:00Z" });
    };

    const meta = await pumpUntilSettled(t, fetchTranscriptMetadata("token"));

    assert.equal(meta.id, "transcript-1");
    assert.equal(calls.length, 2);
    assert.match(calls[0], /transcripts\/transcript-1$/);
  });

  it("recovers via the transcript list when the notified ID persistently 404s", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let metadataCalls = 0;
    global.fetch = async (url) => {
      if (/transcripts\/transcript-1$/.test(url)) {
        metadataCalls++;
        return jsonResponse(404, { error: { code: "NotFound" } });
      }
      if (/transcripts$/.test(url)) {
        return jsonResponse(200, {
          value: [
            { id: "older", createdDateTime: "2026-08-19T04:00:00Z" },
            { id: "newest", createdDateTime: "2026-08-19T05:44:00Z" },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const meta = await pumpUntilSettled(t, fetchTranscriptMetadata("token"));

    assert.equal(metadataCalls, 8); // all attempts exhausted before recovery
    assert.equal(meta.id, "newest");
    assert.equal(CONFIG.transcriptId, "newest"); // content download now uses it
  });

  it("throws the original error when the recovery list is empty", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    global.fetch = async (url) =>
      /transcripts$/.test(url)
        ? jsonResponse(200, { value: [] })
        : jsonResponse(404, { error: { code: "NotFound" } });

    await assert.rejects(
      pumpUntilSettled(t, fetchTranscriptMetadata("token")),
      /Failed to fetch transcript metadata: 404/,
    );
  });

  it("does not retry metadata on non-transient errors like 403", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return jsonResponse(403, { error: { code: "Forbidden" } });
    };

    await assert.rejects(
      pumpUntilSettled(t, fetchTranscriptMetadata("token")),
      /403/,
    );
    assert.equal(calls, 1);
  });

  it("retries transcript content on 404 and returns the VTT once available", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return calls === 1
        ? jsonResponse(404, { error: { code: "NotFound" } })
        : jsonResponse(200, "WEBVTT\n\n00:00.000 --> 00:01.000\nhello");
    };

    const content = await pumpUntilSettled(t, downloadTranscriptContent("token"));

    assert.equal(calls, 2);
    assert.match(content, /^WEBVTT/);
  });
});
