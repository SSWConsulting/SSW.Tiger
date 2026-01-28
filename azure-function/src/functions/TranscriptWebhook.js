const { app } = require("@azure/functions");
const { DefaultAzureCredential } = require("@azure/identity");
const { ContainerAppsAPIClient } = require("@azure/arm-appcontainers");

/**
 * Receives Microsoft Graph webhook notifications for new transcripts and triggers a Container App Job to process them.
 */

// Module-level singletons for better performance
let containerAppsClient = null;
let azureCredential = null;

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

app.http("TranscriptWebhook", {
  methods: ["GET", "POST"],
  authLevel: "anonymous", // TODO: Use 'function' in production
  handler: async (request, context) => {
    // Handle Graph webhook validation
    const validationToken = request.query.get("validationToken");
    if (validationToken) {
      context.log("Webhook validation request received");
      return {
        status: 200,
        headers: { "Content-Type": "text/plain" },
        body: validationToken,
      };
    }

    // Parse notification payload
    let body;
    try {
      body = await request.json();
    } catch (error) {
      context.error("Failed to parse request body:", error);
      return { status: 400, body: "Invalid JSON payload" };
    }

    const notifications = body.value || [];

    const results = [];
    for (const notification of notifications) {
      try {
        const result = await processNotification(notification, context);
        results.push({ success: true, ...result });
      } catch (error) {
        context.error(`Failed to process notification:`, error);
        results.push({ success: false, error: error.message });
      }
    }

    return {
      status: 202,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Accepted",
        results,
      }),
    };
  },
});

async function processNotification(notification, context) {
  // Validate clientState per notification (Graph sends it per notification, not at body level)
  const expectedClientState = process.env.WEBHOOK_CLIENT_STATE;
  if (expectedClientState && notification.clientState !== expectedClientState) {
    context.warn("Invalid clientState in notification");
    return { skipped: true, reason: "Invalid client state" };
  }

  // Filter: only process callTranscript notifications
  const odataType = notification.resourceData?.["@odata.type"];
  if (odataType !== "#microsoft.graph.callTranscript") {
    context.log(`Skipping notification type: ${odataType}`);
    return { skipped: true, reason: `Not a transcript: ${odataType}` };
  }

  // Extract IDs from notification
  // Resource path format: /users/{userId}/onlineMeetings/{meetingId}/transcripts/{transcriptId}
  // Note: path starts with "/" so split gives ["", "users", "{userId}", ...]
  const resourceParts = notification.resource?.split("/") || [];

  // Find indices - only use if found (indexOf returns -1 if not found)
  const usersIdx = resourceParts.indexOf("users");
  const meetingsIdx = resourceParts.indexOf("onlineMeetings");

  // Extract from path if indices are valid, otherwise fall back to resourceData
  const userIdFromPath =
    usersIdx >= 0 && usersIdx + 1 < resourceParts.length
      ? resourceParts[usersIdx + 1]
      : null;
  const meetingIdFromPath =
    meetingsIdx >= 0 && meetingsIdx + 1 < resourceParts.length
      ? resourceParts[meetingsIdx + 1]
      : null;

  // Use path values first, fall back to resourceData (with optional chaining)
  const userId =
    userIdFromPath || notification.resourceData?.meetingOrganizerId;
  const meetingId = meetingIdFromPath || notification.resourceData?.meetingId;
  const transcriptId = notification.resourceData?.id;

  if (!userId || !meetingId || !transcriptId) {
    context.error("Missing required IDs from notification", {
      userId,
      meetingId,
      transcriptId,
      resource: notification.resource,
    });
    return {
      skipped: true,
      reason: `Missing IDs: userId=${userId}, meetingId=${meetingId}, transcriptId=${transcriptId}`,
    };
  }

  context.log(
    `Triggering job for transcript: userId=${userId}, meetingId=${meetingId}, transcriptId=${transcriptId}`,
  );

  await triggerContainerAppJob({ userId, meetingId, transcriptId }, context);

  return {
    userId,
    meetingId,
    transcriptId,
    jobTriggered: true,
  };
}

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
    throw new Error(
      `Missing required environment variables: ${missingEnvVars.join(", ")}`,
    );
  }

  // Use singleton client for better performance
  const client = getContainerAppsClient(subscriptionId);

  const poller = await client.jobs.beginStart(resourceGroup, jobName, {
    template: {
      containers: [
        {
          name: "tiger-processor",
          image: containerImage,
          env: [
            { name: "GRAPH_USER_ID", value: userId },
            { name: "GRAPH_MEETING_ID", value: meetingId },
            { name: "GRAPH_TRANSCRIPT_ID", value: transcriptId },
          ],
        },
      ],
    },
  });

  context.log(`Container App Job started with image: ${containerImage}`);
  context.log(`Operation state: ${poller.getOperationState().status}`);
}
