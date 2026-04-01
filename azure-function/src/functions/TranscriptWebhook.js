const { app, output } = require("@azure/functions");

/**
 * Receives Microsoft Graph webhook notifications for new transcripts.
 * Writes notifications to Azure Queue for reliable async processing.
 *
 * This function ONLY handles webhook validation and queuing.
 * Actual processing is done by ProcessTranscriptQueue.js
 */

// Log prefix for easy filtering
const LOG_PREFIX = "[TIGER]";

/**
 * In-memory deduplication cache for webhook notifications.
 * Prevents duplicate queue messages when Graph sends the same notification twice.
 * Key: `${meetingId}-${transcriptId}`, Value: timestamp
 * TTL: 10 minutes
 *
 * This works because duplicate Graph notifications typically hit the same
 * function instance within seconds. The queue-level dedup in ProcessTranscriptQueue
 * remains as a secondary safety net for cross-instance scenarios.
 */
const webhookDedupCache = new Map();
const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes

function isWebhookDuplicate(meetingId, transcriptId) {
  const key = `${meetingId}-${transcriptId}`;
  const cachedTime = webhookDedupCache.get(key);
  if (cachedTime && Date.now() - cachedTime < DEDUP_TTL_MS) {
    return true;
  }
  return false;
}

function markWebhookProcessed(meetingId, transcriptId) {
  const key = `${meetingId}-${transcriptId}`;
  webhookDedupCache.set(key, Date.now());

  // Cleanup old entries to prevent memory leak
  if (webhookDedupCache.size > 1000) {
    const now = Date.now();
    for (const [k, v] of webhookDedupCache) {
      if (now - v > DEDUP_TTL_MS) {
        webhookDedupCache.delete(k);
      }
    }
  }
}

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

// Queue output binding
const queueOutput = output.storageQueue({
  queueName: "transcript-notifications",
  connection: "AzureWebJobsStorage",
});

app.http("TranscriptWebhook", {
  methods: ["GET", "POST"],
  authLevel: "anonymous", // TODO: Use 'function' in production
  extraOutputs: [queueOutput],
  handler: async (request, context) => {
    // Handle Graph webhook validation
    const validationToken = request.query.get("validationToken");
    if (validationToken) {
      structuredLog(context, "info", "Validation request - returning token");
      return {
        status: 200,
        headers: { "Content-Type": "text/plain" },
        body: validationToken,
      };
    }

    // Parse notification payload
    let body;
    try {
      const rawBody = await request.text();
      body = JSON.parse(rawBody);
    } catch (error) {
      structuredLog(context, "error", "Failed to parse request body", { error: error.message });
      return { status: 400, body: "Invalid JSON payload" };
    }

    const notifications = body.value || [];
    const expectedClientState = process.env.WEBHOOK_CLIENT_STATE;

    // WEBHOOK_CLIENT_STATE is required for security
    if (!expectedClientState) {
      structuredLog(context, "error", "WEBHOOK_CLIENT_STATE environment variable is not configured");
      return {
        status: 500,
        body: "Server configuration error",
      };
    }

    const queueMessages = [];
    let skippedCount = 0;

    for (const notification of notifications) {
      // Validate clientState - skip notification if missing or mismatched
      // Continue processing other notifications in the batch
      if (notification.clientState !== expectedClientState) {
        structuredLog(context, "warn", "SKIP: Invalid clientState", {
          expected: expectedClientState?.substring(0, 4) + "...",
          got: (notification.clientState?.substring(0, 4) || "none") + "...",
        });
        skippedCount++;
        continue;
      }

      // Filter: only process callTranscript notifications
      const odataType = notification.resourceData?.["@odata.type"];
      if (!odataType?.toLowerCase().includes("calltranscript")) {
        structuredLog(context, "info", "SKIP: Not a transcript", { type: odataType });
        skippedCount++;
        continue;
      }

      // Extract IDs from notification
      const resource = notification.resource || "";
      const userMatch = resource.match(/users\('([^']+)'\)/);
      const meetingMatch = resource.match(/onlineMeetings\('([^']+)'\)/);
      const transcriptMatch = resource.match(/transcripts\('([^']+)'\)/);

      const userId =
        userMatch?.[1] || notification.resourceData?.meetingOrganizerId;
      const meetingId =
        meetingMatch?.[1] || notification.resourceData?.meetingId;
      const transcriptId =
        transcriptMatch?.[1] || notification.resourceData?.id;

      if (!userId || !meetingId || !transcriptId) {
        structuredLog(context, "error", "Missing IDs", { userId, meetingId, transcriptId });
        skippedCount++;
        continue;
      }

      // Deduplicate at webhook level to prevent duplicate queue messages
      // Graph may send the same notification multiple times (at-least-once delivery)
      if (isWebhookDuplicate(meetingId, transcriptId)) {
        structuredLog(context, "info", "SKIP: Duplicate webhook notification", { meetingId, transcriptId });
        skippedCount++;
        continue;
      }
      markWebhookProcessed(meetingId, transcriptId);

      queueMessages.push({
        userId,
        meetingId,
        transcriptId,
        timestamp: new Date().toISOString(),
      });

      structuredLog(context, "info", "Queued", { userId, meetingId, transcriptId });
    }

    // Write all messages to queue (array is split into individual queue messages)
    if (queueMessages.length > 0) {
      context.extraOutputs.set(queueOutput, queueMessages);
    }

    structuredLog(context, "info", "Processed notifications", {
      total: notifications.length,
      queued: queueMessages.length,
      skipped: skippedCount,
    });

    // Return immediately - Queue processing happens separately
    return {
      status: 202,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Accepted",
        queued: queueMessages.length,
        skipped: skippedCount,
      }),
    };
  },
});
