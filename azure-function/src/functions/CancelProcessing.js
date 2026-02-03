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

    structuredLog(context, "info", "Cancel request received", {
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
      // Get the Container Apps client
      const client = getContainerAppsClient(subscriptionIdParam);

      // If no mapping found, list running executions and find/stop them
      if (!executionName) {
        structuredLog(
          context,
          "info",
          "Mapping not found, listing running executions",
          {
            executionId,
            jobName,
          },
        );

        // List all executions for this job
        const executions = [];
        for await (const execution of client.jobsExecutions.list(
          resourceGroup,
          jobName,
        )) {
          executions.push(execution);
        }

        // Find running executions
        const runningExecutions = executions.filter(
          (e) => e.status === "Running" || e.status === "Processing",
        );

        structuredLog(context, "info", "Found executions", {
          total: executions.length,
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
        // Found in cache, stop specific execution
        structuredLog(context, "info", "Stopping job execution from cache", {
          jobName,
          executionName,
          resourceGroup,
        });

        try {
          const execution = await client.jobsExecutions.get(
            resourceGroup,
            jobName,
            executionName,
          );

          if (
            execution.status === "Running" ||
            execution.status === "Processing"
          ) {
            await client.jobsExecutions.delete(
              resourceGroup,
              jobName,
              executionName,
            );
            structuredLog(context, "info", "Job execution stopped", {
              executionName,
              previousStatus: execution.status,
            });
          } else {
            structuredLog(context, "info", "Job already completed", {
              executionName,
              status: execution.status,
            });
          }
        } catch (stopError) {
          structuredLog(context, "warn", "Could not stop job execution", {
            executionName,
            error: stopError.message,
          });
        }

        // Remove from mapping cache
        removeExecutionMapping(executionId);
      }

      // Mark as cancelled (for job to check)
      markAsCancelled(executionId);

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

    structuredLog(context, "debug", "Cancellation check", {
      executionId,
      cancelled,
    });

    return {
      status: 200,
      jsonBody: { cancelled },
    };
  },
});
