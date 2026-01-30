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
    context.log(
      `${LOG_PREFIX} Processing queue message:`,
      JSON.stringify(message),
    );

    // Parse message (handle both string and object)
    let data;
    if (typeof message === "string") {
      try {
        data = JSON.parse(message);
      } catch {
        context.error(`${LOG_PREFIX} ERROR: Invalid JSON in queue message`);
        throw new Error("Invalid JSON in queue message");
      }
    } else {
      data = message;
    }

    const { userId, meetingId, transcriptId } = data;

    if (!userId || !meetingId || !transcriptId) {
      context.error(
        `${LOG_PREFIX} ERROR: Missing IDs in queue message - userId=${userId}, meetingId=${meetingId}, transcriptId=${transcriptId}`,
      );
      throw new Error("Missing required IDs in queue message");
    }

    // Check for duplicate (Graph may send same notification multiple times)
    if (isDuplicate(meetingId, transcriptId)) {
      context.log(
        `${LOG_PREFIX} SKIP: Duplicate notification - meetingId=${meetingId}, transcriptId=${transcriptId}`,
      );
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

  const missingEnvVars = [];
  if (!subscriptionId) missingEnvVars.push("SUBSCRIPTION_ID");
  if (!resourceGroup) missingEnvVars.push("CONTAINER_APP_JOB_RESOURCE_GROUP");
  if (!jobName) missingEnvVars.push("CONTAINER_APP_JOB_NAME");
  if (!containerImage) missingEnvVars.push("CONTAINER_APP_JOB_IMAGE");

  if (missingEnvVars.length > 0) {
    context.error(
      `${LOG_PREFIX} ERROR: Missing env vars: ${missingEnvVars.join(", ")}`,
    );
    throw new Error(
      `Missing required environment variables: ${missingEnvVars.join(", ")}`,
    );
  }

  // Use singleton client for better performance
  const client = getContainerAppsClient(subscriptionId);

  context.log(
    `${LOG_PREFIX} Starting Container App Job: ${jobName} (userId=${userId}, meetingId=${meetingId}, transcriptId=${transcriptId})`,
  );

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

    context.log(
      `${LOG_PREFIX} SUCCESS: Container App Job started - ${jobName}, execution=${executionName} (userId=${userId}, meetingId=${meetingId}, transcriptId=${transcriptId})`,
    );
  } catch (err) {
    context.error(
      `${LOG_PREFIX} ERROR: Container App Job failed - ${jobName} (userId=${userId}, meetingId=${meetingId}, transcriptId=${transcriptId}): ${err.message}`,
    );
    throw err; // Re-throw to trigger queue retry
  }
}
