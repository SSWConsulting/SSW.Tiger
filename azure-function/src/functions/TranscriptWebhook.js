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
      context.log(`${LOG_PREFIX} Validation request - returning token`);
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
      context.error(
        `${LOG_PREFIX} ERROR: Failed to parse request body:`,
        error.message,
      );
      return { status: 400, body: "Invalid JSON payload" };
    }

    const notifications = body.value || [];
    const expectedClientState = process.env.WEBHOOK_CLIENT_STATE;

    // WEBHOOK_CLIENT_STATE is required for security
    if (!expectedClientState) {
      context.error(
        `${LOG_PREFIX} ERROR: WEBHOOK_CLIENT_STATE environment variable is not configured`,
      );
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
        context.warn(
          `${LOG_PREFIX} SKIP: Invalid clientState (expected=${expectedClientState?.substring(0, 4)}..., got=${notification.clientState?.substring(0, 4) || "none"}...)`,
        );
        skippedCount++;
        continue;
      }

      // Filter: only process callTranscript notifications
      const odataType = notification.resourceData?.["@odata.type"];
      if (!odataType?.toLowerCase().includes("calltranscript")) {
        context.log(
          `${LOG_PREFIX} SKIP: Not a transcript - type: ${odataType}`,
        );
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
        context.error(
          `${LOG_PREFIX} ERROR: Missing IDs - userId=${userId}, meetingId=${meetingId}, transcriptId=${transcriptId}`,
        );
        skippedCount++;
        continue;
      }

      queueMessages.push({
        userId,
        meetingId,
        transcriptId,
        timestamp: new Date().toISOString(),
      });

      context.log(
        `${LOG_PREFIX} Queued: userId=${userId}, meetingId=${meetingId}, transcriptId=${transcriptId}`,
      );
    }

    // Write all messages to queue (array is split into individual queue messages)
    if (queueMessages.length > 0) {
      context.extraOutputs.set(queueOutput, queueMessages);
    }

    context.log(
      `${LOG_PREFIX} Processed ${notifications.length} notification(s): ${queueMessages.length} queued, ${skippedCount} skipped`,
    );

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
