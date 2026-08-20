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
// Bounded so a stuck SUT fails the test instead of hanging the suite.
function pumpUntilSettled(t, promise, maxTurns = 500) {
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
    for (let turn = 0; turn < maxTurns && !settled; turn++) {
      // setImmediate is not mocked, so this yields a real macrotask turn.
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(300_000);
    }
    if (!settled) {
      throw new Error(`Promise did not settle within ${maxTurns} pump turns`);
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

// Timestamps relative to now so the 72h recovery recency window behaves the
// same whenever the suite runs.
function hoursAgo(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

describe("transcript fetch retry and recovery (#153)", () => {
  const originalFetch = global.fetch;
  const originalConfig = {
    userId: CONFIG.userId,
    meetingId: CONFIG.meetingId,
    transcriptId: CONFIG.transcriptId,
  };

  beforeEach(() => {
    CONFIG.userId = "user-1";
    CONFIG.meetingId = "meeting-1";
    CONFIG.transcriptId = "transcript-1";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    Object.assign(CONFIG, originalConfig);
  });

  // URL helpers: the notified-ID metadata GET, the first list page, and a
  // continuation page. The continuation URL deliberately does NOT end in
  // "transcripts" so the matchers stay unambiguous.
  const isMetadataGet = (url) => /transcripts\/transcript-1$/.test(url);
  const isListGet = (url) => /transcripts$/.test(url);
  const isListPage2 = (url) => /skiptoken=page2$/.test(url);

  it("retries transcript metadata on 404 and succeeds once Graph catches up", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const calls = [];
    global.fetch = async (url) => {
      calls.push(url);
      return calls.length === 1
        ? jsonResponse(404, { error: { code: "NotFound" } })
        : jsonResponse(200, { id: "transcript-1", createdDateTime: hoursAgo(1) });
    };

    const meta = await pumpUntilSettled(t, fetchTranscriptMetadata("token"));

    assert.equal(meta.id, "transcript-1");
    assert.equal(calls.length, 2);
    assert.ok(isMetadataGet(calls[0]));
  });

  it("recovers via the transcript list when the notified ID persistently 404s", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let metadataCalls = 0;
    global.fetch = async (url) => {
      if (isMetadataGet(url)) {
        metadataCalls++;
        return jsonResponse(404, { error: { code: "NotFound" } });
      }
      if (isListGet(url)) {
        // Notified ID is absent; two recent alternatives exist.
        return jsonResponse(200, {
          value: [
            { id: "older", createdDateTime: hoursAgo(3) },
            { id: "newest", createdDateTime: hoursAgo(1) },
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

  it("recovers even when a trailing 5xx follows a run of 404s", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let metadataCalls = 0;
    global.fetch = async (url) => {
      if (isMetadataGet(url)) {
        metadataCalls++;
        // 404s with a 503 on the final attempt — the 404 signature must
        // still trigger recovery.
        return metadataCalls === 8
          ? jsonResponse(503, { error: { code: "ServiceUnavailable" } })
          : jsonResponse(404, { error: { code: "NotFound" } });
      }
      if (isListGet(url)) {
        return jsonResponse(200, {
          value: [{ id: "recovered", createdDateTime: hoursAgo(1) }],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const meta = await pumpUntilSettled(t, fetchTranscriptMetadata("token"));

    assert.equal(meta.id, "recovered");
  });

  it("follows @odata.nextLink pagination when recovering from the list", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    global.fetch = async (url) => {
      if (isMetadataGet(url)) {
        return jsonResponse(404, { error: { code: "NotFound" } });
      }
      if (isListPage2(url)) {
        return jsonResponse(200, {
          value: [{ id: "page2-newest", createdDateTime: hoursAgo(1) }],
        });
      }
      if (isListGet(url)) {
        return jsonResponse(200, {
          value: [{ id: "page1-older", createdDateTime: hoursAgo(5) }],
          "@odata.nextLink":
            "https://graph.microsoft.com/v1.0/users/user-1/onlineMeetings/meeting-1/transcripts?skiptoken=page2",
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const meta = await pumpUntilSettled(t, fetchTranscriptMetadata("token"));

    assert.equal(meta.id, "page2-newest");
  });

  it("does not substitute when the notified ID exists in the list", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    global.fetch = async (url) => {
      if (isMetadataGet(url)) {
        return jsonResponse(404, { error: { code: "NotFound" } });
      }
      if (isListGet(url)) {
        // The notified ID is listed (GET-by-id is just lagging) alongside an
        // older transcript. Substituting the older one would process the
        // wrong recording — recovery must decline and rethrow the 404.
        return jsonResponse(200, {
          value: [
            { id: "older-other", createdDateTime: hoursAgo(4) },
            { id: "transcript-1", createdDateTime: hoursAgo(1) },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    await assert.rejects(
      pumpUntilSettled(t, fetchTranscriptMetadata("token")),
      /Failed to fetch transcript metadata: 404/,
    );
    assert.equal(CONFIG.transcriptId, "transcript-1"); // unchanged
  });

  it("does not substitute a stale transcript from a previous occurrence", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    global.fetch = async (url) => {
      if (isMetadataGet(url)) {
        return jsonResponse(404, { error: { code: "NotFound" } });
      }
      if (isListGet(url)) {
        // Recurring meeting: only last week's transcript is listed. It is
        // outside the recency window and must not be "recovered".
        return jsonResponse(200, {
          value: [{ id: "last-week", createdDateTime: hoursAgo(7 * 24) }],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    await assert.rejects(
      pumpUntilSettled(t, fetchTranscriptMetadata("token")),
      /Failed to fetch transcript metadata: 404/,
    );
    assert.equal(CONFIG.transcriptId, "transcript-1"); // unchanged
  });

  it("throws the original error when the recovery list is empty", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    global.fetch = async (url) =>
      isListGet(url)
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
    const seenUrls = [];
    global.fetch = async (url) => {
      calls++;
      seenUrls.push(url);
      return calls === 1
        ? jsonResponse(404, { error: { code: "NotFound" } })
        : jsonResponse(200, "WEBVTT\n\n00:00.000 --> 00:01.000\nhello");
    };

    const content = await pumpUntilSettled(t, downloadTranscriptContent("token"));

    assert.equal(calls, 2);
    assert.match(content, /^WEBVTT/);
    // Content URL is built from CONFIG.transcriptId at call time, so a
    // recovery that mutated it is honoured here.
    assert.match(seenUrls[0], /transcripts\/transcript-1\/content/);
  });
});
