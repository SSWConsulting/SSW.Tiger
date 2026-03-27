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
      // Supports both online meetings and ad-hoc calls:
      //   Online meeting resource: users('{id}')/onlineMeetings('{id}')/transcripts('{id}')
      //   Ad-hoc call resource:   users/{id}/adhocCalls/{callId}/transcripts/{transcriptId}
      const resource = notification.resource || "";
      const userMatch = resource.match(/users\(?'?([^')]+)'?\)?/);
      const meetingMatch = resource.match(/onlineMeetings\('([^']+)'\)/);
      const adhocMatch = resource.match(/adhoc[Cc]alls\/([^/]+)\/transcripts/);
      const transcriptMatch = resource.match(/transcripts\(?'?([^')]+)'?\)?/);

      const userId =
        userMatch?.[1] || notification.resourceData?.meetingOrganizerId;
      const meetingId =
        meetingMatch?.[1] || notification.resourceData?.meetingId || null;
      const callId = adhocMatch?.[1] || null;
      const transcriptId =
        transcriptMatch?.[1] || notification.resourceData?.id;

      // Determine call type based on resource path
      const callType = callId ? "adhocCall" : "onlineMeeting";

      // For online meetings, meetingId is required; for ad-hoc calls, callId is required
      if (!userId || !transcriptId || (!meetingId && !callId)) {
        structuredLog(context, "error", "Missing IDs", { userId, meetingId, callId, transcriptId, callType });
        skippedCount++;
        continue;
      }

      const queueMessage = {
        userId,
        transcriptId,
        callType,
        timestamp: new Date().toISOString(),
      };

      // Include the appropriate ID based on call type
      if (callType === "adhocCall") {
        queueMessage.callId = callId;
      } else {
        queueMessage.meetingId = meetingId;
      }

      queueMessages.push(queueMessage);

      structuredLog(context, "info", "Queued", { userId, meetingId, callId, transcriptId, callType });
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
