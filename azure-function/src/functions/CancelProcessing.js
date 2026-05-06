const { app } = require("@azure/functions");
const {
  getContainerAppsClient,
  getExecutionMapping,
  removeExecutionMapping,
  structuredLog,
  LOG_PREFIX,
} = require("./ProcessTranscriptQueue");
const { buildResponse } = require("../htmlResponseCard");

/**
 * Build the URL for the RestartProcessing endpoint based on the current
 * request's CancelProcessing URL. Returns "" if any required param is missing.
 */
function buildRestartUrl(request, executionId, userId, meetingId, transcriptId) {
  if (!executionId || !userId || !meetingId || !transcriptId) return "";
  // Resolve absolute URL of this CancelProcessing request, then swap the path.
  // request.url is absolute on Azure Functions runtime.
  let restartUrl;
  try {
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(/\/CancelProcessing$/, "/RestartProcessing");
    url.search = "";
    restartUrl = url.toString();
  } catch {
    return "";
  }
  const params = new URLSearchParams({
    executionId,
    userId,
    meetingId,
    transcriptId,
  });
  return `${restartUrl}?${params.toString()}`;
}

/**
 * Wrap the shared buildResponse with this endpoint's outcome labels.
 * The Restart button is only attached on the success page (run was just
 * cancelled and is no longer running).
 */
function createResponse(request, success, message, statusCode, details = {}) {
  const detailsHtml = details.executionName
    ? `<div class="details"><strong>Execution:</strong> ${details.executionName}</div>`
    : "";
  const actionHtml =
    success && details.restartUrl
      ? `<a href="${details.restartUrl}" class="action-button">↻ Restart Processing</a>`
      : "";

  return buildResponse(request, statusCode, {
    success,
    message,
    json: details,
    card: {
      status: success ? "success" : "error",
      icon: success ? "✅" : "❌",
      title: success ? "Processing Cancelled" : "Cancel Failed",
      detailsHtml,
      actionHtml,
    },
  });
}

/**
 * HTTP trigger to cancel a running transcript processing job.
 * Called when user clicks "Cancel" button in Teams notification.
 *
 * Query parameters:
 *   - executionId: The unique execution ID for the job
 *   - jobName: Container App Job name
 *   - resourceGroup: Resource group name
 *   - subscriptionId: Azure subscription ID
 *
 * This function:
 *   1. Tries to look up execution from in-memory cache (same instance)
 *   2. If not found, lists running executions and stops them (cross-instance)
 *   3. Sends a "cancelled" notification to participants
 */

// In-memory store of cancelled executionIds (for check endpoint)
// Note: This is per-instance, but cancellation is best-effort
const cancelledExecutions = new Set();
const CANCELLED_TTL_MS = 30 * 60 * 1000; // 30 minutes
const cancelledTimestamps = new Map();

function markAsCancelled(executionId) {
  cancelledExecutions.add(executionId);
  cancelledTimestamps.set(executionId, Date.now());

  // Cleanup old entries
  if (cancelledExecutions.size > 100) {
    const now = Date.now();
    for (const [id, ts] of cancelledTimestamps) {
      if (now - ts > CANCELLED_TTL_MS) {
        cancelledExecutions.delete(id);
        cancelledTimestamps.delete(id);
      }
    }
  }
}

function isCancelled(executionId) {
  return cancelledExecutions.has(executionId);
}

/**
 * Validate that the URL-supplied meetingId/transcriptId are consistent with
 * the executionId. ProcessTranscriptQueue generates executionId as
 * `${meetingId}-${transcriptId}-${Date.now()}` — a tampered URL where these
 * IDs don't align is rejected immediately, before any Azure API call.
 */
function executionIdMatches(executionId, meetingId, transcriptId) {
  if (!executionId || !meetingId || !transcriptId) return false;
  return executionId.startsWith(`${meetingId}-${transcriptId}-`);
}

/**
 * Inspect a JobExecution's env vars to confirm it belongs to the requested
 * meeting+transcript. Used to safely identify the right execution when the
 * in-memory mapping cache is missing (e.g., after Function App restart),
 * without falling back to "stop the only running one" — which could stop
 * an unrelated meeting that happens to be the only one running.
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

app.http("CancelProcessing", {
  methods: ["POST", "GET"],
  authLevel: "anonymous", // The long executionId in the URL acts as a pseudo-token.
  // Only users who received the original Teams notification have access to it.
  // Infrastructure identifiers (subscriptionId, resourceGroup, jobName) are NOT
  // trusted from the URL — they're read from server-side env vars instead.
  handler: async (request, context) => {
    const executionId = request.query.get("executionId");
    const userId = request.query.get("userId");
    const meetingId = request.query.get("meetingId");
    const transcriptId = request.query.get("transcriptId");

    // Server-side configuration (not user-controllable)
    const subscriptionId = process.env.SUBSCRIPTION_ID;
    const resourceGroup = process.env.CONTAINER_APP_JOB_RESOURCE_GROUP;
    const jobName = process.env.CONTAINER_APP_JOB_NAME;

    structuredLog(context, "info", "Cancel request received", {
      executionId,
      userId,
      meetingId,
      transcriptId,
    });

    // Validate required parameters
    const missing = [];
    if (!executionId) missing.push("executionId");
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

    if (!subscriptionId || !resourceGroup || !jobName) {
      structuredLog(
        context,
        "error",
        "Server-side env vars missing for cancel",
        {
          hasSubscriptionId: !!subscriptionId,
          hasResourceGroup: !!resourceGroup,
          hasJobName: !!jobName,
        },
      );
      return createResponse(
        request,
        false,
        "Cancel is not available: server is missing required configuration.",
        500,
      );
    }

    // Reject tampered URLs where executionId doesn't encode the same
    // meetingId/transcriptId pair. Cheap integrity check before any Azure call.
    if (!executionIdMatches(executionId, meetingId, transcriptId)) {
      structuredLog(context, "warn", "executionId/meeting mismatch", {
        executionId,
        meetingId,
        transcriptId,
      });
      return createResponse(
        request,
        false,
        "This cancel link is invalid.",
        400,
      );
    }

    // Mark as cancelled BEFORE issuing the stop. The container's SIGTERM trap
    // calls CheckCancellation to decide whether to send a "cancelled" Teams
    // notification — if we marked AFTER the stop, Azure could SIGTERM the
    // container before this flag flips and the trap would treat it as a
    // platform shutdown, suppressing the notification.
    markAsCancelled(executionId);

    // Try the in-memory mapping first (same instance, recent job)
    const mapping = getExecutionMapping(executionId);
    let executionName = mapping?.executionName;

    try {
      const client = getContainerAppsClient(subscriptionId);

      if (!executionName) {
        // Fallback path: in-memory mapping is gone (Function restart, cross-instance).
        // We must NOT just stop "the only running execution" — that could stop an
        // unrelated meeting. Instead, find the running execution whose env vars
        // match this meetingId+transcriptId.
        structuredLog(
          context,
          "info",
          "Mapping not found, searching running executions by env vars",
          { executionId, meetingId, transcriptId },
        );

        let matched = null;
        let runningCount = 0;
        for await (const exec of client.jobsExecutions.list(
          resourceGroup,
          jobName,
        )) {
          if (exec.status !== "Running" && exec.status !== "Processing") {
            continue;
          }
          runningCount += 1;
          if (executionMatchesMeeting(exec, meetingId, transcriptId)) {
            matched = exec;
            break;
          }
        }

        structuredLog(context, "info", "Fallback search complete", {
          runningCount,
          matched: !!matched,
        });

        if (!matched) {
          // Nothing running for this meeting. The job may have already finished
          // or been stopped. Mark-as-cancelled was still set above so a
          // late-poll from a still-living container will pick it up.
          return createResponse(
            request,
            false,
            "No running job execution found for this meeting. It may have already completed.",
            404,
          );
        }

        executionName = matched.name;
      }

      // We have a verified executionName at this point.
      structuredLog(context, "info", "Stopping job execution", {
        jobName,
        executionName,
      });

      try {
        await client.jobs.beginStopExecutionAndWait(
          resourceGroup,
          jobName,
          executionName,
        );
        structuredLog(context, "info", "Job execution stopped", {
          executionName,
        });
      } catch (stopError) {
        structuredLog(context, "warn", "Could not stop job execution", {
          executionName,
          error: stopError.message,
        });
        // Still report success at the user level — the cancel mark is set,
        // so the container will self-terminate via its cancel checker if
        // the API stop didn't take effect.
      }

      removeExecutionMapping(executionId);

      const restartUrl = buildRestartUrl(
        request,
        executionId,
        userId,
        meetingId,
        transcriptId,
      );

      return createResponse(
        request,
        true,
        "Processing has been cancelled successfully.",
        200,
        { executionId, executionName, restartUrl },
      );
    } catch (err) {
      structuredLog(context, "error", "Failed to cancel processing", {
        executionId,
        error: err.message,
      });

      return createResponse(
        request,
        false,
        `Failed to cancel: ${err.message}`,
        500,
      );
    }
  },
});

/**
 * Check if an execution has been cancelled
 * Called by the job before starting expensive processing
 */
app.http("CheckCancellation", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const executionId = request.query.get("executionId");

    if (!executionId) {
      return {
        status: 400,
        jsonBody: { error: true, message: "Missing executionId" },
      };
    }

    const cancelled = isCancelled(executionId);

    // Only log when actually cancelled (reduce log noise)
    if (cancelled) {
      structuredLog(context, "info", "Cancellation confirmed", { executionId });
    }

    return {
      status: 200,
      jsonBody: { cancelled },
    };
  },
});
