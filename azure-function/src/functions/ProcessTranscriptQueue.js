const { app } = require("@azure/functions");
const { DefaultAzureCredential } = require("@azure/identity");
const { ContainerAppsAPIClient } = require("@azure/arm-appcontainers");

/**
 * Processes transcript notifications from the queue.
 * Triggers Container App Job to process each transcript.
 *
 * This function runs independently of the webhook, with automatic retry on failure.
 */

// Log prefix for easy filtering
const LOG_PREFIX = "[TIGER]";

/**
 * Structured logging helper for consistent log format
 */
function structuredLog(context, level, message, data = {}) {
  const logEntry = {
    level,
    message: `${LOG_PREFIX} ${message}`,
    ...data,
  };

  if (level === "error") {
    context.error(JSON.stringify(logEntry));
  } else if (level === "warn") {
    context.warn(JSON.stringify(logEntry));
  } else {
    context.log(JSON.stringify(logEntry));
  }
}

// Module-level singletons for better performance
let containerAppsClient = null;
let azureCredential = null;

/**
 * Simple in-memory deduplication cache.
 * Key: `${meetingId}-${transcriptId}`, Value: timestamp
 * TTL: 10 minutes (Graph may retry within this window)
 *
 * Note: This is per-instance only. For multi-instance scenarios,
 * consider using Azure Table Storage or Redis.
 */
const processedCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function isDuplicate(meetingId, transcriptId) {
  const key = `${meetingId}-${transcriptId}`;
  const cachedTime = processedCache.get(key);

  if (cachedTime && Date.now() - cachedTime < CACHE_TTL_MS) {
    return true;
  }

  return false;
}

function markAsProcessed(meetingId, transcriptId) {
  const key = `${meetingId}-${transcriptId}`;
  processedCache.set(key, Date.now());

  // Cleanup old entries to prevent memory leak
  if (processedCache.size > 1000) {
    const now = Date.now();
    for (const [k, v] of processedCache) {
      if (now - v > CACHE_TTL_MS) {
        processedCache.delete(k);
      }
    }
  }
}

function removeFromCache(meetingId, transcriptId) {
  const key = `${meetingId}-${transcriptId}`;
  processedCache.delete(key);
}

/**
 * Execution mapping cache for cancel functionality.
 * Maps executionId -> { executionName, jobName, resourceGroup, subscriptionId, startedAt }
 * TTL: 2 hours (processing should complete within this time)
 */
const executionMappingCache = new Map();
const EXECUTION_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function storeExecutionMapping(executionId, data) {
  executionMappingCache.set(executionId, data);

  // Cleanup old entries
  if (executionMappingCache.size > 100) {
    const now = Date.now();
    for (const [k, v] of executionMappingCache) {
      if (now - v.startedAt > EXECUTION_CACHE_TTL_MS) {
        executionMappingCache.delete(k);
      }
    }
  }
}

function getExecutionMapping(executionId) {
  return executionMappingCache.get(executionId);
}

function removeExecutionMapping(executionId) {
  executionMappingCache.delete(executionId);
}

function getContainerAppsClient(subscriptionId) {
  if (!containerAppsClient) {
    azureCredential = new DefaultAzureCredential();
    containerAppsClient = new ContainerAppsAPIClient(
      azureCredential,
      subscriptionId,
    );
  }
  return containerAppsClient;
}

app.storageQueue("ProcessTranscriptQueue", {
  queueName: "transcript-notifications",
  connection: "AzureWebJobsStorage",
  handler: async (message, context) => {
    structuredLog(context, "info", "Processing queue message", { message });

    // Parse message (handle both string and object)
    let data;
    if (typeof message === "string") {
      try {
        data = JSON.parse(message);
      } catch {
        structuredLog(context, "error", "Invalid JSON in queue message");
        throw new Error("Invalid JSON in queue message");
      }
    } else {
      data = message;
    }

    const { userId, meetingId, transcriptId } = data;

    if (!userId || !meetingId || !transcriptId) {
      structuredLog(context, "error", "Missing IDs in queue message", { userId, meetingId, transcriptId });
      throw new Error("Missing required IDs in queue message");
    }

    // Check for duplicate (Graph may send same notification multiple times)
    if (isDuplicate(meetingId, transcriptId)) {
      structuredLog(context, "info", "SKIP: Duplicate notification", { meetingId, transcriptId });
      return; // Don't throw - this is expected behavior, not an error
    }

    // Mark as processed BEFORE triggering to prevent race conditions
    // If two messages arrive simultaneously, only the first will proceed
    markAsProcessed(meetingId, transcriptId);

    try {
      await triggerContainerAppJob({ userId, meetingId, transcriptId }, context);
    } catch (err) {
      // Remove from cache on failure to allow retry
      removeFromCache(meetingId, transcriptId);
      throw err;
    }
  },
});

async function triggerContainerAppJob(params, context) {
  const { userId, meetingId, transcriptId } = params;

  // Validate all required environment variables
  const subscriptionId = process.env.SUBSCRIPTION_ID;
  const resourceGroup = process.env.CONTAINER_APP_JOB_RESOURCE_GROUP;
  const jobName = process.env.CONTAINER_APP_JOB_NAME;
  const containerImage = process.env.CONTAINER_APP_JOB_IMAGE;

  // Cancel function URL - can be explicitly set or auto-constructed from WEBSITE_HOSTNAME
  // The CancelProcessing function uses anonymous auth, so no function key needed
  // The executionId in the URL acts as a pseudo-authentication token
  let cancelFunctionUrl = process.env.CANCEL_FUNCTION_URL;
  if (!cancelFunctionUrl && process.env.WEBSITE_HOSTNAME) {
    // Auto-construct URL from Azure Function environment
    const hostname = process.env.WEBSITE_HOSTNAME;
    cancelFunctionUrl = `https://${hostname}/api/CancelProcessing`;
  }

  const missingEnvVars = [];
  if (!subscriptionId) missingEnvVars.push("SUBSCRIPTION_ID");
  if (!resourceGroup) missingEnvVars.push("CONTAINER_APP_JOB_RESOURCE_GROUP");
  if (!jobName) missingEnvVars.push("CONTAINER_APP_JOB_NAME");
  if (!containerImage) missingEnvVars.push("CONTAINER_APP_JOB_IMAGE");

  if (missingEnvVars.length > 0) {
    structuredLog(context, "error", "Missing env vars", { missingEnvVars });
    throw new Error(
      `Missing required environment variables: ${missingEnvVars.join(", ")}`,
    );
  }

  // Generate a unique execution ID for this job run
  const executionId = `${meetingId}-${transcriptId}-${Date.now()}`;

  // Build cancel URL if cancel function is configured
  const cancelUrl = cancelFunctionUrl
    ? `${cancelFunctionUrl}?executionId=${encodeURIComponent(executionId)}&jobName=${encodeURIComponent(jobName)}&resourceGroup=${encodeURIComponent(resourceGroup)}`
    : "";

  // Use singleton client for better performance
  const client = getContainerAppsClient(subscriptionId);

  structuredLog(context, "info", "Starting Container App Job", { jobName, userId, meetingId, transcriptId });

  try {
    // beginStart() returns a poller for the LRO (Long Running Operation)
    // We only wait for the job to be accepted/started, not for it to complete
    // IMPORTANT: Template override REPLACES the env array, so we must include ALL env vars
    const poller = await client.jobs.beginStart(resourceGroup, jobName, {
      template: {
        containers: [
          {
            name: "tiger-processor",
            image: containerImage,
            env: [
              // Dynamic values passed from queue message
              { name: "GRAPH_USER_ID", value: userId },
              { name: "GRAPH_MEETING_ID", value: meetingId },
              { name: "GRAPH_TRANSCRIPT_ID", value: transcriptId },
              // Execution tracking for cancel functionality
              { name: "JOB_EXECUTION_ID", value: executionId },
              { name: "CANCEL_URL", value: cancelUrl },
              // Static values - must be included as template override replaces the env array
              { name: "NODE_ENV", value: "production" },
              // Secrets from job configuration (defined in containerApp.bicep)
              { name: "CLAUDE_CODE_OAUTH_TOKEN", secretRef: "anthropic-oauth-token" },
              { name: "SURGE_EMAIL", secretRef: "surge-email" },
              { name: "SURGE_TOKEN", secretRef: "surge-token" },
              { name: "GRAPH_CLIENT_ID", secretRef: "graph-client-id" },
              { name: "GRAPH_CLIENT_SECRET", secretRef: "graph-client-secret" },
              { name: "GRAPH_TENANT_ID", secretRef: "graph-tenant-id" },
              { name: "LOGIC_APP_URL", secretRef: "logic-app-url" },
            ],
          },
        ],
      },
    });

    // Get the initial result (job execution info) without waiting for completion
    const initialResult = poller.getOperationState().result;
    const executionName = initialResult?.name || "unknown";

    // Store mapping of executionId -> executionName for cancel functionality
    // This allows the cancel endpoint to find the actual job execution
    storeExecutionMapping(executionId, {
      executionName,
      jobName,
      resourceGroup,
      subscriptionId,
      startedAt: Date.now(),
    });

    structuredLog(context, "info", "Container App Job started", {
      jobName,
      executionName,
      executionId,
      cancelUrl: cancelUrl || "(not configured)",
      userId,
      meetingId,
      transcriptId,
    });
  } catch (err) {
    structuredLog(context, "error", "Container App Job failed", {
      jobName,
      userId,
      meetingId,
      transcriptId,
      error: err.message,
    });
    throw err; // Re-throw to trigger queue retry
  }
}

// Export shared utilities for CancelProcessing function
module.exports = {
  getContainerAppsClient,
  getExecutionMapping,
  removeExecutionMapping,
  structuredLog,
  LOG_PREFIX,
};
