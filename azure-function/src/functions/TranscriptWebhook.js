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

// Log prefix for easy filtering
const LOG_PREFIX = "[TIGER]";

app.http("TranscriptWebhook", {
  methods: ["GET", "POST"],
  authLevel: "anonymous", // TODO: Use 'function' in production
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

    const results = [];
    for (let i = 0; i < notifications.length; i++) {
      const notification = notifications[i];
      try {
        const result = await processNotification(notification, context);
        results.push({ success: true, ...result });
      } catch (error) {
        context.error(
          `${LOG_PREFIX} ERROR: Notification ${i + 1} failed:`,
          error.message,
        );
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
    context.warn(`${LOG_PREFIX} SKIP: Invalid clientState`);
    return { skipped: true, reason: "Invalid client state" };
  }

  // Filter: only process callTranscript notifications (case-insensitive)
  const odataType = notification.resourceData?.["@odata.type"];
  if (!odataType?.toLowerCase().includes("calltranscript")) {
    context.log(`${LOG_PREFIX} SKIP: Not a transcript - type: ${odataType}`);
    return { skipped: true, reason: `Not a transcript: ${odataType}` };
  }
  // Extract IDs from notification
  // Resource format: users('userId')/onlineMeetings('meetingId')/transcripts('transcriptId')
  const resource = notification.resource || "";

  // Extract IDs using regex to handle format: users('id')/onlineMeetings('id')/transcripts('id')
  const userMatch = resource.match(/users\('([^']+)'\)/);
  const meetingMatch = resource.match(/onlineMeetings\('([^']+)'\)/);
  const transcriptMatch = resource.match(/transcripts\('([^']+)'\)/);

  const userId =
    userMatch?.[1] || notification.resourceData?.meetingOrganizerId;
  const meetingId = meetingMatch?.[1] || notification.resourceData?.meetingId;
  const transcriptId = transcriptMatch?.[1] || notification.resourceData?.id;

  if (!userId || !meetingId || !transcriptId) {
    context.error(`${LOG_PREFIX} ERROR: Missing required IDs`);
    return {
      skipped: true,
      reason: `Missing IDs: userId=${userId}, meetingId=${meetingId}, transcriptId=${transcriptId}`,
    };
  }

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
    context.error(
      `${LOG_PREFIX} ERROR: Missing env vars: ${missingEnvVars.join(", ")}`,
    );
    throw new Error(
      `Missing required environment variables: ${missingEnvVars.join(", ")}`,
    );
  }

  // Use singleton client for better performance
  const client = getContainerAppsClient(subscriptionId);

  context.log(`${LOG_PREFIX} Starting Container App Job: ${jobName}`);

  await client.jobs.beginStart(resourceGroup, jobName, {
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

  context.log(`${LOG_PREFIX} SUCCESS: Container App Job triggered - ${jobName}`);
}
