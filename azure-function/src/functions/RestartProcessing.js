const { app, output } = require("@azure/functions");
const crypto = require("crypto");
const {
  getContainerAppsClient,
  findActiveExecutionForMeeting,
  structuredLog,
} = require("./ProcessTranscriptQueue");
const {
  buildResponse,
  renderConfirmationCard,
  renderCard,
} = require("../htmlResponseCard");

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

/**
 * Inspect a live Container Apps Job execution and decide whether it is already
 * processing this meeting+transcript. This catches cross-instance cases where
 * the in-memory executionMappingCache is empty but Azure still has a running
 * execution for the same meeting.
 */
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

// SSW Tiger logo URL (optionally overridable via env var for environment swaps)
const TIGER_LOGO_URL =
  process.env.TIGER_LOGO_URL ||
  "https://satigerstagingweb.blob.core.windows.net/assets/Logo.png";

/**
 * Wrap the shared buildResponse with this endpoint's outcome labels.
 * Three states: success (green), conflict (amber), error (red).
 */
function createResponse(request, success, message, statusCode, details = {}) {
  const isConflict = details.conflict === true;
  return buildResponse(request, statusCode, {
    success,
    message,
    json: details,
    card: {
      status: success ? "success" : isConflict ? "conflict" : "error",
      // Brand image on success; expressive emoji for conflict / error states
      iconImageUrl: success ? TIGER_LOGO_URL : undefined,
      icon: success ? "" : isConflict ? "⏳" : "❌",
      title: success
        ? "Restart Queued"
        : isConflict
          ? "Already Running"
          : "Restart Failed",
    },
  });
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

    // For GET requests: check in-memory cache first so we can show "already
    // running" immediately without a confirmation step. If clearly running,
    // show the conflict page straight away. Otherwise show the confirmation
    // page — POST will do the full live API check before actually queueing.
    if (request.method === "GET") {
      const cachedActive = findActiveExecutionForMeeting(
        meetingId,
        transcriptId,
      );
      if (cachedActive || isRestartInFlight(meetingId, transcriptId)) {
        return {
          status: 200,
          headers: { "Content-Type": "text/html" },
          body: renderCard({
            status: "conflict",
            icon: "⏳",
            title: "Already Running",
            message:
              "A processing run for this meeting is already in progress. Please wait for it to complete or cancel it before restarting.",
          }),
        };
      }
      return {
        status: 200,
        headers: { "Content-Type": "text/html" },
        body: renderConfirmationCard({
          icon: "↻",
          title: "Restart Processing?",
          message: "This will re-run the meeting analysis from scratch.",
          actionUrl: request.url,
          confirmLabel: "↻ Confirm Restart",
        }),
      };
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
          // SDK only exposes list() on jobsExecutions — no direct get().
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

        // Cross-instance / cold-start fallback: cache may be empty, but the
        // Container Apps API can still show a running execution for the same
        // meeting. Scan live executions by env vars before queueing another run.
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

    // Re-enqueue the queue message. The unique restartId acts as the dedup
    // key in ProcessTranscriptQueue — this lets two distinct restart clicks
    // both reach the queue handler (each with its own restartId), while
    // genuine queue redelivery (same message replayed) still gets dedup'd.
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
