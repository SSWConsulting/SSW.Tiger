const { app } = require("@azure/functions");
const { DefaultAzureCredential } = require("@azure/identity");
const { ContainerAppsAPIClient } = require("@azure/arm-appcontainers");
const crypto = require("node:crypto");
const {
  normalizeQueueMessage,
  buildDedupKey,
  buildJobEnvironment,
} = require("../services/queueMessage");

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
const RESTART_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

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

/**
 * Find a cached execution mapping for a given meeting + transcript.
 * Used by RestartProcessing to detect a job already running for the meeting.
 *
 * Per-instance only — if the running job was started by a different Function
 * instance, this returns undefined. Caller should treat that as "no match" and
 * rely on the live Container Apps API check + queue-level dedup as backstops.
 */
function findActiveExecutionForMeeting(meetingId, transcriptId) {
  for (const [executionId, data] of executionMappingCache) {
    if (data.meetingId === meetingId && data.transcriptId === transcriptId) {
      return { executionId, ...data };
    }
  }
  return undefined;
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
  if (!secret) {
    throw new Error(
      "Missing restart token signing secret. Configure RESTART_TOKEN_SECRET, WEBHOOK_CLIENT_STATE, or GRAPH_CLIENT_SECRET.",
    );
  }

  return crypto
    .createHmac("sha256", secret)
    .update(
      [executionId, userId, meetingId, transcriptId, String(expiresAt)].join(
        "|",
      ),
    )
    .digest("hex");
}

function appendQueryParams(url, params) {
  const parsedUrl = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    parsedUrl.searchParams.set(key, value);
  }
  return parsedUrl.toString();
}

function buildSiblingFunctionUrl(sourceFunctionUrl, targetFunctionName) {
  const parsedUrl = new URL(sourceFunctionUrl);
  const normalizedPath = parsedUrl.pathname.replace(/\/+$/, "");
  if (!normalizedPath.endsWith("/CancelProcessing")) {
    throw new Error(
      `CANCEL_FUNCTION_URL must end with /CancelProcessing to derive ${targetFunctionName}`,
    );
  }
  parsedUrl.pathname = `${normalizedPath.slice(
    0,
    -"/CancelProcessing".length,
  )}/${targetFunctionName}`;
  parsedUrl.search = "";
  parsedUrl.hash = "";
  return parsedUrl.toString();
}

app.storageQueue("ProcessTranscriptQueue", {
  queueName: "transcript-notifications",
  connection: "AzureWebJobsStorage",
  handler: async (message, context) => {
    let data;
    try {
      data = normalizeQueueMessage(message);
    } catch (error) {
      structuredLog(context, "error", "Invalid queue message", { error: error.message });
      throw error;
    }
    const { userId, meetingId, transcriptId, manualTrigger, restartTrigger, restartedFromExecutionId } = data;
    structuredLog(context, "info", "Processing queue message", {
      sourceType: data.sourceType,
      requestId: data.requestId,
      meetingId,
      transcriptId,
    });

    if (manualTrigger) {
      structuredLog(context, "info", "Manual trigger - subject filter will be skipped", { meetingId });
    }

    if (restartTrigger) {
      structuredLog(context, "info", "Restart job starting", {
        meetingId,
        transcriptId,
        restartedFromExecutionId: restartedFromExecutionId || "(unknown)",
      });
    }

    // Check for duplicate (Graph may send same notification multiple times).
    // Webhook/manual: dedup on meetingId+transcriptId (10 min) — covers
    //   Graph webhook retries and accidental UI double-clicks.
    // Restart: dedup on a per-click unique restartId — only prevents Azure
    //   Queue redelivery of the same message; multiple legitimate restart
    //   clicks each get their own restartId. RestartProcessing blocks rapid
    //   user double-clicks before enqueueing.
    const dedupKey = buildDedupKey(data);
    if (processedCache.has(dedupKey) && Date.now() - processedCache.get(dedupKey) < CACHE_TTL_MS) {
      structuredLog(context, "info", "SKIP: Duplicate notification", {
        meetingId,
        transcriptId,
        manualTrigger: !!manualTrigger,
        restartTrigger: !!restartTrigger,
      });
      return;
    }

    // Mark as processed BEFORE triggering to prevent race conditions
    // If two messages arrive simultaneously, only the first will proceed
    processedCache.set(dedupKey, Date.now());

    try {
      await triggerContainerAppJob(data, context);
    } catch (err) {
      // Remove from cache on failure to allow retry
      processedCache.delete(dedupKey);
      throw err;
    }
  },
});

async function triggerContainerAppJob(params, context) {
  const { userId, meetingId, transcriptId } = params;
  const isGraph = params.sourceType === "graphTranscript";

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
  const executionId = isGraph
    ? `${meetingId}-${transcriptId}-${Date.now()}`
    : `${params.requestId}-${Date.now()}`;
  const restartTokenExpiresAt = isGraph && cancelFunctionUrl
    ? Date.now() + RESTART_TOKEN_TTL_MS
    : null;
  const restartToken = isGraph && cancelFunctionUrl
    ? createRestartSignature({
        executionId,
        userId,
        meetingId,
        transcriptId,
        expiresAt: restartTokenExpiresAt,
      })
    : "";

  // Build cancel URL if cancel function is configured
  // Include subscriptionId so cancel can work without in-memory cache (cross-instance)
  // Include userId so cancelled notification can be sent to the organizer
  const cancelUrl = isGraph && cancelFunctionUrl
    ? appendQueryParams(cancelFunctionUrl, {
        executionId,
        jobName,
        resourceGroup,
        subscriptionId,
        userId,
        meetingId,
        transcriptId,
      })
    : "";

  // Build restart URL (same Function host, different endpoint)
  const restartUrl = isGraph && cancelFunctionUrl
    ? appendQueryParams(
        buildSiblingFunctionUrl(cancelFunctionUrl, "RestartProcessing"),
        {
          executionId,
          userId,
          meetingId,
          transcriptId,
          expiresAt: String(restartTokenExpiresAt),
          token: restartToken,
        },
      )
    : "";

  // Build check cancellation URL (same host, different endpoint)
  const checkCancellationUrl = isGraph && cancelFunctionUrl
    ? appendQueryParams(
        buildSiblingFunctionUrl(cancelFunctionUrl, "CheckCancellation"),
        {
          executionId,
        },
      )
    : "";

  // Use singleton client for better performance
  const client = getContainerAppsClient(subscriptionId);

  structuredLog(context, "info", "Starting Container App Job", {
    jobName,
    sourceType: params.sourceType,
    requestId: params.requestId,
    meetingId,
    transcriptId,
  });

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
            env: buildJobEnvironment(params, process.env, {
              executionId,
              cancelUrl,
              checkCancellationUrl,
              restartUrl,
            }),
          },
        ],
      },
    });

    // Get the initial result (job execution info) without waiting for completion
    const initialResult = poller.getOperationState().result;
    const executionName = initialResult?.name || "unknown";

    // Store mapping of executionId -> executionName for cancel functionality
    // This allows the cancel endpoint to find the actual job execution.
    // meetingId/transcriptId enable findActiveExecutionForMeeting() (used by RestartProcessing
    // to detect a job already running for the same meeting).
    storeExecutionMapping(executionId, {
      executionName,
      jobName,
      resourceGroup,
      subscriptionId,
      meetingId,
      transcriptId,
      requestId: params.requestId,
      sourceType: params.sourceType,
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
      requestId: params.requestId,
      sourceType: params.sourceType,
    });
  } catch (err) {
    structuredLog(context, "error", "Container App Job failed", {
      jobName,
      userId,
      meetingId,
      transcriptId,
      requestId: params.requestId,
      sourceType: params.sourceType,
      error: err.message,
    });
    throw err; // Re-throw to trigger queue retry
  }
}

// Export shared utilities for CancelProcessing and RestartProcessing functions
module.exports = {
  getContainerAppsClient,
  getExecutionMapping,
  removeExecutionMapping,
  findActiveExecutionForMeeting,
  structuredLog,
  LOG_PREFIX,
};
