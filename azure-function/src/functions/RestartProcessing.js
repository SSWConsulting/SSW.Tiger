const { app, output } = require("@azure/functions");
const crypto = require("crypto");
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

// In-memory tracking of restart requests issued in the last 30 seconds.
// Key: `${meetingId}-${transcriptId}` — Value: timestamp.
//
// Purpose: bridge the brief window between this endpoint enqueuing a message
// and ProcessTranscriptQueue picking it up and starting a container. Once the
// container starts, executionMappingCache picks up the slack and Layer 1
// (Azure API check) handles further restart attempts.
//
// 30s is enough to absorb double-clicks from a single user; a longer TTL
// would block legitimate retries when a freshly-started container fails fast.
const restartInFlight = new Map();
const RESTART_INFLIGHT_TTL_MS = 30 * 1000;

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

function executionMatchesMeeting(execution, meetingId, transcriptId) {
  const containers = execution?.template?.containers;
  if (!Array.isArray(containers)) return false;
  for (const c of containers) {
    if (!Array.isArray(c.env)) continue;
    const envMap = new Map(c.env.map((e) => [e.name, e.value]));
    if (
      envMap.get("GRAPH_MEETING_ID") === meetingId &&
      envMap.get("GRAPH_TRANSCRIPT_ID") === transcriptId
    ) {
      return true;
    }
  }
  return false;
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

function generateConfirmationResponse(request) {
  return {
    status: 200,
    headers: { "Content-Type": "text/html" },
    body: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Restart Processing - SSW Tiger</title>
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
      background: #fff3cd;
      color: #856404;
      border: 1px solid #ffeaa7;
      margin-bottom: 20px;
    }
    .action-button {
      display: inline-block;
      margin-top: 8px;
      padding: 12px 24px;
      background: #cc0000;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
    }
    .close-hint { margin-top: 20px; color: #999; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">↻</div>
    <div class="title">Restart Processing?</div>
    <div class="message">This will re-run the meeting analysis from scratch.</div>
    <form method="POST" action="${request.url}">
      <button type="submit" class="action-button">↻ Confirm Restart</button>
    </form>
    <div class="close-hint">You can close this window if you do not want to restart.</div>
  </div>
</body>
</html>`,
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
      method: request.method,
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

    // Teams and security scanners can prefetch links with GET. GET must be
    // side-effect free; only the confirmation form's POST may enqueue a run.
    if (request.method === "GET") {
      return generateConfirmationResponse(request);
    }

    // Layer 1: Live check via Container Apps API + in-memory mapping cache.
    // If a recent execution for this meeting is still Running, refuse.
    const subscriptionId = process.env.SUBSCRIPTION_ID;
    const resourceGroup = process.env.CONTAINER_APP_JOB_RESOURCE_GROUP;
    const jobName = process.env.CONTAINER_APP_JOB_NAME;

    if (subscriptionId && resourceGroup && jobName) {
      try {
        const client = getContainerAppsClient(subscriptionId);
        const cachedActive = findActiveExecutionForMeeting(
          meetingId,
          transcriptId,
        );

        if (cachedActive) {
          // Verify it's actually still running via Azure (cache could be stale).
          // SDK only exposes list() on jobsExecutions in this package version.
          try {
            let liveExec = null;
            for await (const exec of client.jobsExecutions.list(
              resourceGroup,
              jobName,
            )) {
              if (exec.name === cachedActive.executionName) {
                liveExec = exec;
                break;
              }
            }
            if (
              liveExec &&
              (liveExec.status === "Running" ||
                liveExec.status === "Processing")
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

        // Cross-instance / cold-start fallback: cache may be empty, but Azure
        // can still show a running execution for the same meeting.
        for await (const exec of client.jobsExecutions.list(
          resourceGroup,
          jobName,
        )) {
          if (exec.status !== "Running" && exec.status !== "Processing") {
            continue;
          }
          if (!executionMatchesMeeting(exec, meetingId, transcriptId)) {
            continue;
          }

          structuredLog(
            context,
            "info",
            "Restart blocked: live execution already running",
            {
              meetingId,
              transcriptId,
              runningExecutionName: exec.name,
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

    // Re-enqueue the queue message. restartId lets ProcessTranscriptQueue
    // dedup queue redelivery without blocking separate legitimate restarts.
    const restartId = crypto.randomUUID();
    const queueMessage = {
      userId,
      meetingId,
      transcriptId,
      skipSubjectFilter: true,
      restartTrigger: true,
      restartId,
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
