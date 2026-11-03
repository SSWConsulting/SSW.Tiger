const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// Swap the Container Apps client for a fake before ProcessTranscriptQueue
// destructures it, and capture both handlers instead of registering them.
const startedJobs = [];
const fakeClient = {
  jobs: {
    beginStart: async (_rg, _job, { template }) => {
      startedJobs.push(template.containers[0].env);
      return { getOperationState: () => ({ result: { name: "exec-name" } }) };
    },
  },
  jobsExecutions: { list: async function* () {} },
};
require("@azure/arm-appcontainers");
require.cache[require.resolve("@azure/arm-appcontainers")].exports = {
  ContainerAppsAPIClient: function () {
    return fakeClient;
  },
};

const functions = require("@azure/functions");
const handlers = {};
functions.app.storageQueue = (name, options) => (handlers[name] = options.handler);
functions.app.http = (name, options) => (handlers[name] = options.handler);
require("./ProcessTranscriptQueue");
require("./RestartProcessing");

let queued;
const context = {
  log() {},
  warn() {},
  error() {},
  extraOutputs: { set: (_output, messages) => (queued = messages) },
};

// Start a job from a queue message, then press Restart on its card
async function restartFromRun(message, tamper = (query) => query) {
  await handlers.ProcessTranscriptQueue(message, context);
  const env = startedJobs.at(-1);
  const restartUrl = new URL(env.find((e) => e.name === "RESTART_URL").value);

  const response = await handlers.RestartProcessing(
    {
      method: "POST",
      query: tamper(restartUrl.searchParams),
      headers: new Headers({ accept: "application/json" }),
    },
    context,
  );
  return { env, response };
}

describe("RestartProcessing", () => {
  beforeEach(() => {
    process.env.SUBSCRIPTION_ID = "sub";
    process.env.CONTAINER_APP_JOB_RESOURCE_GROUP = "rg";
    process.env.CONTAINER_APP_JOB_NAME = "job";
    process.env.CONTAINER_APP_JOB_IMAGE = "image";
    process.env.CANCEL_FUNCTION_URL = "https://tiger.test/api/CancelProcessing";
    process.env.RESTART_TOKEN_SECRET = "secret";
    queued = null;
  });

  it("keeps the manual subject a run was started with", async () => {
    const { env, response } = await restartFromRun({
      userId: "user-1",
      meetingId: "meeting-1",
      transcriptId: "transcript-1",
      skipSubjectFilter: true,
      manualTrigger: true,
      subject: "SSW Design - Sprint Review",
    });

    assert.equal(env.find((e) => e.name === "MEETING_SUBJECT_OVERRIDE").value, "SSW Design - Sprint Review");
    assert.equal(response.status, 202);
    assert.equal(queued[0].subject, "SSW Design - Sprint Review");
  });

  it("rejects a restart link whose subject was changed", async () => {
    const { response } = await restartFromRun(
      { userId: "user-1", meetingId: "meeting-2", transcriptId: "transcript-1", subject: "SSW Design - Sprint Review" },
      (query) => (query.set("subject", "Someone Else - Sprint Review"), query),
    );

    assert.equal(response.status, 403);
    assert.equal(queued, null);
  });

  it("restarts a run without a subject as before", async () => {
    const { env, response } = await restartFromRun({ userId: "user-1", meetingId: "meeting-3", transcriptId: "transcript-1" });

    assert.ok(!env.some((e) => e.name === "MEETING_SUBJECT_OVERRIDE"));
    assert.equal(response.status, 202);
    assert.ok(!("subject" in queued[0]));
  });
});
