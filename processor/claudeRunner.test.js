const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");

const {
  detectFailureReason,
  detectStage,
  hasConsolidatedAnalysis,
  isApiRetryEvent,
  extractRetryDetail,
  isStalled,
} = require("./claudeRunner");

const MINUTE = 60 * 1000;

// The real error line the Claude CLI emits on stdout as a stream-json event.
// Verbatim from the failure in GitHub issue #149.
const OUTPUT_LIMIT_LINE = JSON.stringify({
  type: "assistant",
  message: {
    content: [
      {
        type: "text",
        text:
          "API Error: Claude's response exceeded the 32000 output token maximum. " +
          "To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.",
      },
    ],
  },
});

describe("detectFailureReason", () => {
  it("recognizes the output token limit error", () => {
    const failure = detectFailureReason(OUTPUT_LIMIT_LINE);
    assert.equal(failure.reason, "output_token_limit");
    assert.match(failure.hint, /output token limit/i);
  });

  it("recognizes the error at a different token ceiling", () => {
    const line = "API Error: Claude's response exceeded the 64000 output token maximum.";
    assert.equal(detectFailureReason(line).reason, "output_token_limit");
  });

  it("returns null for ordinary output", () => {
    assert.equal(detectFailureReason("Running people-analyzer agent"), null);
    assert.equal(detectFailureReason(""), null);
  });

  it("does not mistake unrelated token wording for the limit error", () => {
    assert.equal(detectFailureReason("Used 32000 tokens so far"), null);
  });
});

describe("isApiRetryEvent", () => {
  it("matches the CLI's api_retry system event", () => {
    assert.equal(isApiRetryEvent({ type: "system", subtype: "api_retry" }), true);
  });

  it("does not match other system events or plain messages", () => {
    assert.equal(isApiRetryEvent({ type: "system", subtype: "init" }), false);
    assert.equal(isApiRetryEvent({ type: "assistant", message: {} }), false);
    assert.equal(isApiRetryEvent(undefined), false);
  });
});

describe("extractRetryDetail", () => {
  it("keeps the fields that explain why the CLI retried", () => {
    const detail = extractRetryDetail({
      type: "system",
      subtype: "api_retry",
      session_id: "abc",
      attempt: 3,
      delay_ms: 2000,
      status_code: 429,
      error: "overloaded_error",
    });

    assert.equal(detail.attempt, 3);
    assert.equal(detail.delay_ms, 2000);
    assert.equal(detail.status_code, 429);
    assert.equal(detail.error, "overloaded_error");
    // Routing noise is dropped
    assert.equal(detail.session_id, undefined);
  });

  it("surfaces unrecognized fields instead of dropping them silently", () => {
    const detail = extractRetryDetail({
      type: "system",
      subtype: "api_retry",
      some_new_field: "value-we-did-not-anticipate",
    });

    assert.match(detail.otherFields, /some_new_field/);
    assert.match(detail.otherFields, /value-we-did-not-anticipate/);
  });

  it("serializes object-valued fields rather than emitting [object Object]", () => {
    const detail = extractRetryDetail({
      type: "system",
      subtype: "api_retry",
      error: { type: "overloaded_error", message: "Overloaded" },
    });

    assert.match(detail.error, /overloaded_error/);
  });

  it("returns an empty object when the CLI sends no detail at all", () => {
    // This is the issue #149 case: subtype only, nothing to explain it
    assert.deepEqual(extractRetryDetail({ type: "system", subtype: "api_retry" }), {});
  });
});

describe("isStalled", () => {
  it("tolerates fast transient retries", () => {
    // 429 / overloaded backoff resolves in seconds - not a stall
    assert.equal(isStalled({ consecutiveRetries: 2, stalledMs: 8000 }), false);
  });

  it("tolerates a single slow retry", () => {
    assert.equal(isStalled({ consecutiveRetries: 1, stalledMs: 20 * MINUTE }), false);
  });

  it("flags repeated retries that each took minutes", () => {
    // The issue #149 shape: ~5 min per cycle, nothing in between
    assert.equal(isStalled({ consecutiveRetries: 2, stalledMs: 10 * MINUTE }), true);
  });

  it("flags a third consecutive retry regardless of speed", () => {
    assert.equal(isStalled({ consecutiveRetries: 3, stalledMs: 1000 }), true);
  });

  it("fails fast enough to leave room for a retry inside the 60 min job timeout", () => {
    // Two 5-minute cycles trip the detector, so the run gives up around the
    // 15 minute mark rather than being SIGTERMed at 60 minutes.
    assert.equal(isStalled({ consecutiveRetries: 2, stalledMs: 10 * MINUTE }), true);
  });
});

describe("detectStage", () => {
  let meetingPath;

  beforeEach(async () => {
    meetingPath = await fs.mkdtemp(path.join(os.tmpdir(), "tiger-stage-"));
  });

  afterEach(async () => {
    await fs.rm(meetingPath, { recursive: true, force: true });
  });

  const writeAnalysis = async (...names) => {
    const dir = path.join(meetingPath, "analysis");
    await fs.mkdir(dir, { recursive: true });
    for (const name of names) {
      await fs.writeFile(path.join(dir, name), "{}", "utf-8");
    }
  };

  it("reports the analysis stage when nothing has been written", async () => {
    assert.equal(await detectStage(meetingPath), "analysis");
  });

  it("reports agent progress while analysis is partial", async () => {
    await writeAnalysis("timeline.json", "people.json");
    assert.equal(await detectStage(meetingPath), "analysis (2 of 5 agents done)");
  });

  it("reports dashboard generation once consolidation is done", async () => {
    await writeAnalysis("timeline.json", "consolidated.json");
    assert.equal(await detectStage(meetingPath), "dashboard-generation");
  });

  it("flags a partially written dashboard", async () => {
    await writeAnalysis("consolidated.json");
    await fs.mkdir(path.join(meetingPath, "dashboard"), { recursive: true });
    await fs.writeFile(
      path.join(meetingPath, "dashboard", "index.html"),
      "<html>{{SUMMARY}}</html>",
      "utf-8",
    );
    assert.equal(
      await detectStage(meetingPath),
      "dashboard-generation (partial output written)",
    );
  });

  it("ignores non-JSON files in the analysis directory", async () => {
    const dir = path.join(meetingPath, "analysis");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "notes.txt"), "scratch", "utf-8");
    assert.equal(await detectStage(meetingPath), "analysis");
  });

  it("returns unknown without a meeting path", async () => {
    assert.equal(await detectStage(undefined), "unknown");
  });
});

describe("hasConsolidatedAnalysis", () => {
  let meetingPath;

  beforeEach(async () => {
    meetingPath = await fs.mkdtemp(path.join(os.tmpdir(), "tiger-resume-"));
  });

  afterEach(async () => {
    await fs.rm(meetingPath, { recursive: true, force: true });
  });

  it("is false when the analysis phase never completed", async () => {
    assert.equal(await hasConsolidatedAnalysis(meetingPath), false);
  });

  it("is true once consolidated.json exists, so a retry can skip analysis", async () => {
    const dir = path.join(meetingPath, "analysis");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "consolidated.json"), "{}", "utf-8");
    assert.equal(await hasConsolidatedAnalysis(meetingPath), true);
  });
});
