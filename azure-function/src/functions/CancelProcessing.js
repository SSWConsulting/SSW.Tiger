const { app } = require("@azure/functions");
const {
  getContainerAppsClient,
  getExecutionMapping,
  removeExecutionMapping,
  structuredLog,
  LOG_PREFIX,
} = require("./ProcessTranscriptQueue");

/**
 * Generate HTML response page for browser requests
 */
function generateHtmlResponse(success, message, details = {}) {
  const icon = success ? "✅" : "❌";
  const title = success ? "Processing Cancelled" : "Cancel Failed";
  const bgColor = success ? "#d4edda" : "#f8d7da";
  const textColor = success ? "#155724" : "#721c24";
  const borderColor = success ? "#c3e6cb" : "#f5c6cb";

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
    .details { font-size: 12px; color: #666; text-align: left; }
    .close-hint { margin-top: 20px; color: #999; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <div class="title">${title}</div>
    <div class="message">${message}</div>
    ${details.executionName ? `<div class="details"><strong>Execution:</strong> ${details.executionName}</div>` : ""}
    <div class="close-hint">You can close this window now.</div>
  </div>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generateCancelConfirmation(request, details = {}) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Confirm Cancel - SSW Tiger</title>
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
    .details { font-size: 11px; color: #888; margin-top: 24px; overflow-wrap: anywhere; }
    .details strong { color: #777; font-weight: 600; }
    .actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
    button, .secondary {
      border-radius: 8px;
      border: 0;
      padding: 12px 18px;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
    }
    button { background: #CC4141; color: white; }
    .secondary { background: #eee; color: #333; }
  </style>
</head>
<body>
  <div class="card">
    <div class="title">Stop analyzing this meeting?</div>
    <div class="message">If you stop, the meeting will not be analyzed and no dashboard will be generated.</div>
    <div class="actions">
      <a class="secondary" href="javascript:window.close()">Keep Running</a>
      <form method="POST" action="${escapeHtml(request.url)}">
        <button type="submit">Stop Analysis</button>
      </form>
    </div>
    ${details.executionName ? `<div class="details"><strong>Execution:</strong> ${escapeHtml(details.executionName)}</div>` : ""}
  </div>
</body>
</html>`;
}

function createConfirmationResponse(request, details = {}) {
  return {
    status: 200,
    headers: {
      "Content-Type": "text/html",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
    body: generateCancelConfirmation(request, details),
  };
}

function isRunningStatus(status) {
  return status === "Running" || status === "Processing";
}

async function getExecutionSnapshot(
  client,
  resourceGroup,
  jobName,
  executionName,
) {
  const executions = [];
  for await (const execution of client.jobsExecutions.list(
    resourceGroup,
    jobName,
  )) {
    executions.push(execution);
  }

  const runningExecutions = executions.filter((e) => isRunningStatus(e.status));
  const targetExecution = executionName
    ? executions.find((e) => e.name === executionName)
    : null;

  return {
    total: executions.length,
    runningExecutions,
    targetExecution,
  };
}

function getRequestDiagnostics(request) {
  return {
    method: request.method,
    userAgent: request.headers.get("user-agent") || "",
    forwardedFor: request.headers.get("x-forwarded-for") || "",
    referer:
      request.headers.get("referer") || request.headers.get("referrer") || "",
  };
}

/**
 * Return response based on request type (HTML for browser, JSON for API)
 */
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

  // Return HTML for browser requests
  return {
    status: statusCode,
    headers: { "Content-Type": "text/html" },
    body: generateHtmlResponse(success, message, details),
  };
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
 *   1. Marks the execution as cancelled so the container can exit cleanly
 *   2. If execution tracking is unavailable, falls back to stopping the running job
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

app.http("CancelProcessing", {
  methods: ["POST", "GET"],
  authLevel: "anonymous", // No authentication required (simpler setup)
  // Note: The executionId acts as a pseudo-authentication token
  // Only users who received the notification have access to the cancel URL
  handler: async (request, context) => {
    const executionId = request.query.get("executionId");
    const jobName = request.query.get("jobName");
    const resourceGroup = request.query.get("resourceGroup");
    const subscriptionIdParam = request.query.get("subscriptionId");
    const userId = request.query.get("userId");

    if (request.method === "GET") {
      const mapping = getExecutionMapping(executionId);
      const executionName = mapping?.executionName;

      structuredLog(context, "info", "Cancel confirmation viewed", {
        ...getRequestDiagnostics(request),
        executionId,
        jobName,
        resourceGroup,
        subscriptionId: subscriptionIdParam,
        userId,
      });

      if (!executionId || !jobName || !resourceGroup || !subscriptionIdParam) {
        return createResponse(
          request,
          false,
          "Missing required parameters: executionId, jobName, resourceGroup, subscriptionId",
          400,
        );
      }

      try {
        const client = getContainerAppsClient(subscriptionIdParam);
        const snapshot = await getExecutionSnapshot(
          client,
          resourceGroup,
          jobName,
          executionName,
        );

        structuredLog(
          context,
          "info",
          "Cancel confirmation job status checked",
          {
            executionId,
            executionName,
            total: snapshot.total,
            running: snapshot.runningExecutions.length,
            targetStatus: snapshot.targetExecution?.status,
          },
        );

        if (
          snapshot.targetExecution &&
          !isRunningStatus(snapshot.targetExecution.status)
        ) {
          return createResponse(
            request,
            false,
            "No running job executions found. It may have already completed.",
            404,
            { executionId, executionName },
          );
        }

        if (!snapshot.targetExecution && executionName) {
          return createResponse(
            request,
            false,
            "No running job executions found. It may have already completed.",
            404,
            { executionId, executionName },
          );
        }

        if (!executionName) {
          if (snapshot.runningExecutions.length === 0) {
            return createResponse(
              request,
              false,
              "No running job executions found. It may have already completed.",
              404,
              { executionId },
            );
          }

          if (snapshot.runningExecutions.length > 1) {
            return createResponse(
              request,
              false,
              `Multiple jobs running (${snapshot.runningExecutions.length}). Cannot safely determine which one to cancel.`,
              409,
              { executionId },
            );
          }

          return createConfirmationResponse(request, {
            executionName: snapshot.runningExecutions[0].name,
          });
        }

        return createConfirmationResponse(request, { executionName });
      } catch (err) {
        structuredLog(
          context,
          "warn",
          "Could not verify job status for cancel confirmation",
          {
            executionId,
            executionName,
            error: err.message,
          },
        );

        return createResponse(
          request,
          false,
          "Could not verify whether the job is still running. Please try again.",
          500,
          { executionId, executionName },
        );
      }
    }

    structuredLog(context, "info", "Cancel request submitted", {
      ...getRequestDiagnostics(request),
      executionId,
      jobName,
      resourceGroup,
      subscriptionId: subscriptionIdParam,
      userId,
    });

    // Validate required parameters
    if (!executionId || !jobName || !resourceGroup || !subscriptionIdParam) {
      return createResponse(
        request,
        false,
        "Missing required parameters: executionId, jobName, resourceGroup, subscriptionId",
        400,
      );
    }

    // Try to look up from in-memory cache first (works if same instance)
    const mapping = getExecutionMapping(executionId);
    let executionName = mapping?.executionName;

    try {
      // If no mapping found, list running executions and find/stop them
      if (!executionName) {
        // Get the Container Apps client only for the force-stop fallback.
        const client = getContainerAppsClient(subscriptionIdParam);

        structuredLog(
          context,
          "info",
          "Mapping not found, listing running executions",
          {
            executionId,
            jobName,
          },
        );

        const snapshot = await getExecutionSnapshot(
          client,
          resourceGroup,
          jobName,
        );
        const { runningExecutions } = snapshot;

        structuredLog(context, "info", "Found executions", {
          total: snapshot.total,
          running: runningExecutions.length,
        });

        if (runningExecutions.length === 0) {
          return createResponse(
            request,
            false,
            "No running job executions found. It may have already completed.",
            404,
          );
        }

        // Safety check: only stop if exactly 1 running execution
        // If multiple running, we can't safely determine which one to stop
        if (runningExecutions.length > 1) {
          structuredLog(
            context,
            "warn",
            "Multiple running executions found, cannot safely cancel",
            {
              runningCount: runningExecutions.length,
              executions: runningExecutions.map((e) => e.name),
            },
          );
          return createResponse(
            request,
            false,
            `Multiple jobs running (${runningExecutions.length}). Cannot safely determine which one to cancel. Please wait for them to complete or cancel manually.`,
            409,
          );
        }

        // Stop the single running execution
        const targetExecution = runningExecutions[0];
        try {
          await client.jobsExecutions.delete(
            resourceGroup,
            jobName,
            targetExecution.name,
          );
          structuredLog(context, "info", "Job execution stopped", {
            executionName: targetExecution.name,
            previousStatus: targetExecution.status,
          });
          executionName = targetExecution.name;
          // Mark as cancelled only after the force-stop succeeded
          markAsCancelled(executionId);
        } catch (stopError) {
          structuredLog(context, "warn", "Could not stop job execution", {
            executionName: targetExecution.name,
            error: stopError.message,
          });
          return createResponse(
            request,
            false,
            `Failed to stop execution: ${stopError.message}`,
            500,
          );
        }
      } else {
        // Found in cache, let the container's cancellation checker stop itself.
        structuredLog(
          context,
          "info",
          "Marked job execution for cooperative cancellation",
          {
            jobName,
            executionName,
            resourceGroup,
          },
        );

        // Mark as cancelled only after confirming the cooperative path is valid
        markAsCancelled(executionId);
        // Remove from mapping cache
        removeExecutionMapping(executionId);
      }

      return createResponse(
        request,
        true,
        "Processing has been cancelled successfully.",
        200,
        { executionId, executionName },
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
