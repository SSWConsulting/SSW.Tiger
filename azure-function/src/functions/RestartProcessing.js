const { app, output } = require("@azure/functions");
const crypto = require("crypto");
const {
  getContainerAppsClient,
  findActiveExecutionForMeeting,
  structuredLog,
} = require("./ProcessTranscriptQueue");

const TIGER_LOGO_URL =
  process.env.TIGER_LOGO_URL ||
  "https://satigerstagingweb.blob.core.windows.net/assets/Logo.png";

/**
 * HTTP trigger to restart a transcript processing job for the same meeting.
 * Called when the user clicks "Restart processing" on a "cancelled" or
 * "failed" Teams card.
 *
 * Query parameters:
 *   - executionId   : original execution ID (for audit/correlation; pseudo-token)
 *   - userId        : Graph user ID of the meeting organizer
 *   - meetingId     : Graph meeting ID
 *   - transcriptId  : Graph transcript ID
 *   - expiresAt     : token expiry timestamp in milliseconds
 *   - token         : HMAC signature for the restart request
 *
 * Concurrency defence:
 *   1. List Container App Job executions and check if one is already running
 *      for this meeting (matched via the shared executionMappingCache).
 *   2. In-process restart-in-flight set blocks rapid double-clicks within the
 *      window between this endpoint and ProcessTranscriptQueue picking up the
 *      message.
 *   3. ProcessTranscriptQueue dedups Azure Queue redelivery by restartId.
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

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getRestartTokenSecret() {
  return (
    process.env.RESTART_TOKEN_SECRET ||
    process.env.WEBHOOK_CLIENT_STATE ||
    process.env.GRAPH_CLIENT_SECRET
  );
}

function createRestartSignature({
  executionId,
  userId,
  meetingId,
  transcriptId,
  expiresAt,
}) {
  const secret = getRestartTokenSecret();
  if (!secret) return "";

  return crypto
    .createHmac("sha256", secret)
    .update(
      [executionId, userId, meetingId, transcriptId, String(expiresAt)].join(
        "|",
      ),
    )
    .digest("hex");
}

function isValidRestartToken({
  executionId,
  userId,
  meetingId,
  transcriptId,
  expiresAt,
  token,
}) {
  if (!token || !expiresAt) return false;

  const expiry = Number(expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) {
    return false;
  }

  const expected = createRestartSignature({
    executionId,
    userId,
    meetingId,
    transcriptId,
    expiresAt,
  });
  if (!expected || expected.length !== token.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}

function generateHtmlResponse(success, message, details = {}) {
  // Three states: success (green), conflict (amber), error (red)
  const isConflict = details.conflict === true;
  const icon = isConflict ? "⏳" : "❌";
  const iconHtml = success
    ? `<img src="${escapeHtml(TIGER_LOGO_URL)}" alt="" class="icon icon-img">`
    : `<div class="icon">${icon}</div>`;
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
  <title>${escapeHtml(title)} - SSW Tiger</title>
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
    .icon { font-size: 64px; line-height: 1; margin-bottom: 20px; }
    .icon-img {
      display: inline-block;
      width: 64px;
      height: 64px;
      object-fit: contain;
    }
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
    ${iconHtml}
    <div class="title">${escapeHtml(title)}</div>
    <div class="message">${escapeHtml(message)}</div>
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
  const formAction = escapeHtml(request.url);

  return {
    status: 200,
    headers: {
      "Content-Type": "text/html",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
    body: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Re-run Analysis</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: #f5f5f5;
      color: #333;
    }
    .card {
      background: white;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.1);
      padding: 40px;
      text-align: center;
      max-width: 420px;
    }
    .title { font-size: 24px; font-weight: 600; margin-bottom: 12px; }
    .message { color: #555; line-height: 1.5; margin-bottom: 24px; }
    .keep-hint { color: #777; font-size: 14px; margin-bottom: 16px; }
    button {
      border-radius: 8px;
      border: 0;
      padding: 12px 18px;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      background: #CC4141;
      color: white;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="title">Re-run this meeting analysis?</div>
    <div class="message">The previous results will be replaced. A full re-analysis will run and you'll receive a new Teams notification when it's ready.</div>
    <form method="POST" action="${formAction}">
      <button type="submit">Re-run Analysis</button>
    </form>
    <div class="keep-hint">To keep the existing results, close this tab.</div>
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
    const expiresAt = request.query.get("expiresAt");
    const token = request.query.get("token");
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
    if (!expiresAt) missing.push("expiresAt");
    if (!token) missing.push("token");

    if (missing.length > 0) {
      return createResponse(
        request,
        false,
        `Missing required parameter(s): ${missing.join(", ")}`,
        400,
      );
    }

    if (
      !isValidRestartToken({
        executionId,
        userId,
        meetingId,
        transcriptId,
        expiresAt,
        token,
      })
    ) {
      structuredLog(context, "warn", "Restart rejected: invalid token", {
        executionId,
        meetingId,
        transcriptId,
        userId,
        sourceIp,
      });
      return createResponse(
        request,
        false,
        "This restart link is invalid or has expired. Please use the latest Teams notification link.",
        403,
      );
    }

    // Teams and security scanners can prefetch links with GET. GET must be
    // side-effect free; only the confirmation form's POST may enqueue a run.
    // However, we do a live running-check on GET so the user sees "Already
    // Running" immediately instead of hitting it after clicking confirm.
    const subscriptionId = process.env.SUBSCRIPTION_ID;
    const resourceGroup = process.env.CONTAINER_APP_JOB_RESOURCE_GROUP;
    const jobName = process.env.CONTAINER_APP_JOB_NAME;

    /**
     * Check whether a job for this meeting is already running. Returns:
     * - true: running execution found
     * - false: no running execution found
     * - null: status unknown because config/API lookup failed
     */
    async function checkAlreadyRunning() {
      if (!subscriptionId || !resourceGroup || !jobName) return null;
      try {
        const client = getContainerAppsClient(subscriptionId);
        const cachedActive = findActiveExecutionForMeeting(
          meetingId,
          transcriptId,
        );

        if (cachedActive) {
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
              structuredLog(context, "info", "Already running (cache hit)", {
                meetingId,
                transcriptId,
                runningExecutionName: cachedActive.executionName,
              });
              return true;
            }
          } catch (liveCheckErr) {
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

        // Cross-instance / cold-start fallback
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
          structuredLog(context, "info", "Already running (live API scan)", {
            meetingId,
            transcriptId,
            runningExecutionName: exec.name,
          });
          return true;
        }
      } catch (err) {
        structuredLog(
          context,
          "warn",
          "Running-check failed",
          { error: err.message },
        );
        return null;
      }
      return false;
    }

    if (request.method === "GET") {
      const runningStatus = await checkAlreadyRunning();
      if (runningStatus === null) {
        return createResponse(
          request,
          false,
          "Restart status is temporarily unavailable. Please try again in a minute.",
          503,
        );
      }
      if (runningStatus) {
        structuredLog(
          context,
          "info",
          "GET: already running, showing conflict page",
          {
            meetingId,
            transcriptId,
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
      return generateConfirmationResponse(request);
    }

    // POST: repeat the check (user may have left the confirm page open while
    // a new run was triggered by someone else, or via a double-click race).
    const runningStatus = await checkAlreadyRunning();
    if (runningStatus === null) {
      return createResponse(
        request,
        false,
        "Restart status is temporarily unavailable. Please try again in a minute.",
        503,
      );
    }
    if (runningStatus) {
      structuredLog(context, "info", "Restart blocked: already running", {
        meetingId,
        transcriptId,
        userId,
      });
      return createResponse(
        request,
        false,
        "A processing run for this meeting is already in progress. Please wait for it to complete or cancel it before restarting.",
        409,
        { conflict: true },
      );
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
