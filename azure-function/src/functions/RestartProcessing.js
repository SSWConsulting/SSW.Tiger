const { app, output } = require("@azure/functions");
const {
  getContainerAppsClient,
  findActiveExecutionForMeeting,
  structuredLog,
} = require("./ProcessTranscriptQueue");

/**
 * HTTP trigger to restart a transcript processing job for the same meeting.
 * Called when the user clicks "Restart processing" on a "cancelled" or
 * "failed" Teams card, or on the cancel-success HTML page.
 *
 * Query parameters:
 *   - executionId   : original execution ID (for audit/correlation; pseudo-token)
 *   - userId        : Graph user ID of the meeting organizer
 *   - meetingId     : Graph meeting ID
 *   - transcriptId  : Graph transcript ID
 *
 * Concurrency defence:
 *   1. List Container App Job executions and check if one is already running
 *      for this meeting (matched via the shared executionMappingCache).
 *   2. In-process restart-in-flight set blocks rapid double-clicks within the
 *      window between this endpoint and ProcessTranscriptQueue picking up the
 *      message.
 *   3. ProcessTranscriptQueue has its own dedup keyed by `restart-${meetingId}-${transcriptId}`.
 */

// In-memory tracking of restart requests issued in the last 5 minutes.
// Key: `${meetingId}-${transcriptId}` — Value: timestamp.
// This is the second concurrency layer described in the design.
const restartInFlight = new Map();
const RESTART_INFLIGHT_TTL_MS = 5 * 60 * 1000;

function markRestartInFlight(meetingId, transcriptId) {
  restartInFlight.set(`${meetingId}-${transcriptId}`, Date.now());

  // Cleanup old entries to prevent memory growth
  if (restartInFlight.size > 200) {
    const now = Date.now();
    for (const [k, ts] of restartInFlight) {
      if (now - ts > RESTART_INFLIGHT_TTL_MS) {
        restartInFlight.delete(k);
      }
    }
  }
}

function isRestartInFlight(meetingId, transcriptId) {
  const key = `${meetingId}-${transcriptId}`;
  const ts = restartInFlight.get(key);
  if (!ts) return false;
  if (Date.now() - ts > RESTART_INFLIGHT_TTL_MS) {
    restartInFlight.delete(key);
    return false;
  }
  return true;
}

function generateHtmlResponse(success, message, details = {}) {
  // Three states: success (green), conflict (amber), error (red)
  const isConflict = details.conflict === true;
  const icon = success ? "🐯" : isConflict ? "⏳" : "❌";
  const title = success
    ? "Restart Queued"
    : isConflict
      ? "Already Running"
      : "Restart Failed";
  const bgColor = success ? "#d4edda" : isConflict ? "#fff3cd" : "#f8d7da";
  const textColor = success ? "#155724" : isConflict ? "#856404" : "#721c24";
  const borderColor = success ? "#c3e6cb" : isConflict ? "#ffeaa7" : "#f5c6cb";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - SSW Tiger</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: #f5f5f5;
    }
    .card {
      background: white;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.1);
      padding: 40px;
      text-align: center;
      max-width: 400px;
    }
    .icon { font-size: 64px; margin-bottom: 20px; }
    .title { font-size: 24px; font-weight: 600; margin-bottom: 12px; color: #333; }
    .message {
      padding: 16px;
      border-radius: 8px;
      background: ${bgColor};
      color: ${textColor};
      border: 1px solid ${borderColor};
      margin-bottom: 20px;
    }
    .close-hint { margin-top: 20px; color: #999; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <div class="title">${title}</div>
    <div class="message">${message}</div>
    <div class="close-hint">You can close this window now.</div>
  </div>
</body>
</html>`;
}

function createResponse(request, success, message, statusCode, details = {}) {
  const acceptHeader = request.headers.get("accept") || "";
  const isJsonRequest = acceptHeader.includes("application/json");

  if (isJsonRequest) {
    return {
      status: statusCode,
      jsonBody: success
        ? { success: true, message, ...details }
        : { error: true, message, ...details },
    };
  }

  return {
    status: statusCode,
    headers: { "Content-Type": "text/html" },
    body: generateHtmlResponse(success, message, details),
  };
}

// Same queue used by TranscriptWebhook and TriggerProcessing
const queueOutput = output.storageQueue({
  queueName: "transcript-notifications",
  connection: "AzureWebJobsStorage",
});

app.http("RestartProcessing", {
  methods: ["POST", "GET"],
  authLevel: "anonymous",
  extraOutputs: [queueOutput],
  handler: async (request, context) => {
    const executionId = request.query.get("executionId");
    const userId = request.query.get("userId");
    const meetingId = request.query.get("meetingId");
    const transcriptId = request.query.get("transcriptId");
    const sourceIp =
      request.headers.get("x-forwarded-for") ||
      request.headers.get("x-azure-clientip") ||
      "(unknown)";

    structuredLog(context, "info", "Restart request received", {
      executionId,
      userId,
      meetingId,
      transcriptId,
      sourceIp,
    });

    // Validate required parameters
    const missing = [];
    if (!executionId) missing.push("executionId");
    if (!userId) missing.push("userId");
    if (!meetingId) missing.push("meetingId");
    if (!transcriptId) missing.push("transcriptId");

    if (missing.length > 0) {
      return createResponse(
        request,
        false,
        `Missing required parameter(s): ${missing.join(", ")}`,
        400,
      );
    }

    // Layer 1: Live check via Container Apps API + in-memory mapping cache.
    // If a recent execution for this meeting is still Running, refuse.
    const subscriptionId = process.env.SUBSCRIPTION_ID;
    const resourceGroup = process.env.CONTAINER_APP_JOB_RESOURCE_GROUP;
    const jobName = process.env.CONTAINER_APP_JOB_NAME;

    if (subscriptionId && resourceGroup && jobName) {
      try {
        const cachedActive = findActiveExecutionForMeeting(
          meetingId,
          transcriptId,
        );

        if (cachedActive) {
          // Verify it's actually still running via Azure (cache could be stale)
          try {
            const client = getContainerAppsClient(subscriptionId);
            const liveExec = await client.jobsExecutions.get(
              resourceGroup,
              jobName,
              cachedActive.executionName,
            );
            if (
              liveExec.status === "Running" ||
              liveExec.status === "Processing"
            ) {
              structuredLog(
                context,
                "info",
                "Restart blocked: already running",
                {
                  meetingId,
                  transcriptId,
                  runningExecutionName: cachedActive.executionName,
                  runningExecutionId: cachedActive.executionId,
                  userId,
                },
              );
              return createResponse(
                request,
                false,
                "A processing run for this meeting is already in progress. Please wait for it to complete or cancel it before restarting.",
                409,
                { conflict: true },
              );
            }
          } catch (liveCheckErr) {
            // If the live check fails (e.g. execution was deleted), fall
            // through. The cached entry was stale.
            structuredLog(
              context,
              "warn",
              "Live execution check failed, falling through",
              {
                executionName: cachedActive.executionName,
                error: liveCheckErr.message,
              },
            );
          }
        }
      } catch (err) {
        // Don't block restart on a check failure; log and proceed.
        structuredLog(
          context,
          "warn",
          "Layer 1 concurrency check failed, proceeding without it",
          { error: err.message },
        );
      }
    }

    // Layer 2: in-process restart-in-flight set
    if (isRestartInFlight(meetingId, transcriptId)) {
      structuredLog(context, "info", "Restart blocked: in-flight", {
        meetingId,
        transcriptId,
        userId,
      });
      return createResponse(
        request,
        false,
        "A restart for this meeting was just requested. Please wait for it to start before trying again.",
        409,
        { conflict: true },
      );
    }

    markRestartInFlight(meetingId, transcriptId);

    // Re-enqueue the queue message. ProcessTranscriptQueue has its own dedup
    // (Layer 3) keyed by `restart-${meetingId}-${transcriptId}`.
    const queueMessage = {
      userId,
      meetingId,
      transcriptId,
      skipSubjectFilter: true,
      restartTrigger: true,
      restartedFromExecutionId: executionId,
      restartedAt: new Date().toISOString(),
    };

    context.extraOutputs.set(queueOutput, [queueMessage]);

    structuredLog(context, "info", "Restart enqueued", {
      executionId,
      meetingId,
      transcriptId,
      userId,
      sourceIp,
    });

    return createResponse(
      request,
      true,
      "Processing has been restarted. You'll receive a Teams notification when the new run begins.",
      202,
    );
  },
});
