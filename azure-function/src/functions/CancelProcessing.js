const { app } = require("@azure/functions");
const {
  getContainerAppsClient,
  getExecutionMapping,
  removeExecutionMapping,
  structuredLog,
  LOG_PREFIX,
} = require("./ProcessTranscriptQueue");

/**
 * HTTP trigger to cancel a running transcript processing job.
 * Called when user clicks "Cancel" button in Teams notification.
 *
 * Query parameters:
 *   - executionId: The unique execution ID for the job
 *   - jobName: Container App Job name
 *   - resourceGroup: Resource group name
 *
 * This function:
 *   1. Looks up the actual job execution name from cache
 *   2. Stops/terminates the Container App Job execution
 *   3. Sends a "cancelled" notification to participants
 */

app.http("CancelProcessing", {
  methods: ["POST", "GET"],
  authLevel: "anonymous", // No authentication required (simpler setup)
  // Note: The executionId acts as a pseudo-authentication token
  // Only users who received the notification have access to the cancel URL
  handler: async (request, context) => {
    const executionId = request.query.get("executionId");
    const jobName = request.query.get("jobName");
    const resourceGroup = request.query.get("resourceGroup");

    structuredLog(context, "info", "Cancel request received", {
      executionId,
      jobName,
      resourceGroup,
    });

    // Validate required parameters
    if (!executionId) {
      return {
        status: 400,
        jsonBody: { error: true, message: "Missing executionId parameter" },
      };
    }

    // Look up the execution mapping
    const mapping = getExecutionMapping(executionId);

    if (!mapping) {
      structuredLog(context, "warn", "Execution mapping not found", {
        executionId,
      });
      // Job might have already completed or mapping expired
      return {
        status: 404,
        jsonBody: {
          error: true,
          message: "Job execution not found. It may have already completed.",
        },
      };
    }

    const {
      executionName,
      jobName: mappedJobName,
      resourceGroup: mappedResourceGroup,
      subscriptionId,
    } = mapping;

    // Use mapped values if not provided in query
    const finalJobName = jobName || mappedJobName;
    const finalResourceGroup = resourceGroup || mappedResourceGroup;

    if (!finalJobName || !finalResourceGroup || !subscriptionId) {
      return {
        status: 400,
        jsonBody: { error: true, message: "Missing job configuration" },
      };
    }

    try {
      // Get the Container Apps client
      const client = getContainerAppsClient(subscriptionId);

      // Stop the job execution
      // Note: Container App Jobs don't have a direct "stop" API
      // We need to delete the execution to stop it
      structuredLog(context, "info", "Stopping job execution", {
        jobName: finalJobName,
        executionName,
        resourceGroup: finalResourceGroup,
      });

      try {
        // Try to stop the execution by getting its status first
        const execution = await client.jobsExecutions.get(
          finalResourceGroup,
          finalJobName,
          executionName,
        );

        if (execution.status === "Running" || execution.status === "Processing") {
          // For running jobs, we can try to delete the execution
          await client.jobsExecutions.delete(
            finalResourceGroup,
            finalJobName,
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
        // If we can't stop it (e.g., already completed), that's okay
        structuredLog(context, "warn", "Could not stop job execution", {
          executionName,
          error: stopError.message,
        });
      }

      // Remove from mapping cache
      removeExecutionMapping(executionId);

      // Send cancelled notification
      await sendCancelledNotification(context, executionId);

      return {
        status: 200,
        jsonBody: {
          success: true,
          message: "Processing cancelled",
          executionId,
          executionName,
        },
      };
    } catch (err) {
      structuredLog(context, "error", "Failed to cancel processing", {
        executionId,
        error: err.message,
      });

      return {
        status: 500,
        jsonBody: {
          error: true,
          message: `Failed to cancel: ${err.message}`,
        },
      };
    }
  },
});

/**
 * Send notification that processing was cancelled
 */
async function sendCancelledNotification(context, executionId) {
  const logicAppUrl = process.env.LOGIC_APP_URL;

  if (!logicAppUrl) {
    structuredLog(context, "warn", "LOGIC_APP_URL not configured, skipping notification");
    return;
  }

  try {
    const payload = {
      notificationType: "cancelled",
      executionId,
      message: "Meeting transcript processing was cancelled by user.",
    };

    const response = await fetch(logicAppUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Logic App returned ${response.status}`);
    }

    structuredLog(context, "info", "Cancelled notification sent", { executionId });
  } catch (err) {
    structuredLog(context, "warn", "Failed to send cancelled notification", {
      error: err.message,
    });
  }
}
