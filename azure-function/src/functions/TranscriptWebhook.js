const { app } = require("@azure/functions");
const { DefaultAzureCredential } = require("@azure/identity");
const { ContainerAppsAPIClient } = require("@azure/arm-appcontainers");
const { ConfidentialClientApplication } = require("@azure/msal-node");

// Test mode: skip Graph API and Container Job
const TEST_MODE = process.env.TEST_MODE === "true";

app.http("TranscriptWebhook", {
  methods: ["POST"],
  authLevel: "anonymous", // Use 'function' in production
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

    // Validate clientState if configured (skip in test mode)
    const expectedClientState = process.env.WEBHOOK_CLIENT_STATE;
    if (
      !TEST_MODE &&
      expectedClientState &&
      body.clientState !== expectedClientState
    ) {
      context.warn("Invalid clientState received");
      return { status: 401, body: "Invalid client state" };
    }

    const notifications = body.value || [];
    context.log(
      `Processing ${notifications.length} notification(s)${TEST_MODE ? " [TEST MODE]" : ""}`,
    );

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
        testMode: TEST_MODE,
        results,
      }),
    };
  },
});

async function processNotification(notification, context) {
  // Filter: only process callTranscript notifications
  const odataType = notification.resourceData?.["@odata.type"];
  if (odataType !== "#microsoft.graph.callTranscript") {
    context.log(`Skipping notification type: ${odataType}`);
    return { skipped: true, reason: `Not a transcript: ${odataType}` };
  }

  // Extract IDs from notification
  // Resource path format: /users/{userId}/onlineMeetings/{meetingId}/transcripts/{transcriptId}
  const resourceParts = notification.resource?.split("/") || [];
  const userIdIndex = resourceParts.indexOf("users") + 1;
  const meetingIdIndex = resourceParts.indexOf("onlineMeetings") + 1;

  const userId =
    resourceParts[userIdIndex] || notification.resourceData.meetingOrganizerId;
  const meetingId =
    resourceParts[meetingIdIndex] || notification.resourceData.meetingId;
  const transcriptId = notification.resourceData.id;

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
    `Processing transcript: userId=${userId}, meetingId=${meetingId}, transcriptId=${transcriptId}`,
  );

  let meeting;

  if (TEST_MODE) {
    // TEST MODE: Use mock data
    meeting = getMockMeeting(notification);
    context.log("[TEST MODE] Using mock meeting data");
  } else {
    // PRODUCTION: Call Graph API to get meeting details
    const graphToken = await getGraphToken(context);
    meeting = await fetchMeeting(graphToken, userId, meetingId, context);
    if (!meeting || meeting.error) {
      throw new Error(
        `Failed to fetch meeting details: ${meeting?.error?.message || "Unknown error"}`,
      );
    }
  }

  // Filter: only process meetings with "sprint" in the subject
  const subject = meeting.subject || "";
  if (!subject.toLowerCase().includes("sprint")) {
    context.log(`Skipping meeting without 'sprint' in subject: "${subject}"`);
    return {
      skipped: true,
      reason: `Subject does not contain 'sprint': "${subject}"`,
    };
  }

  // Extract meeting info
  const meetingDate = meeting.startDateTime
    ? meeting.startDateTime.split("T")[0]
    : new Date().toISOString().split("T")[0];
  const projectName = extractProjectName(subject);
  const filename = generateFilename(meeting);

  context.log(
    `Meeting: project=${projectName}, date=${meetingDate}, filename=${filename}`,
  );

  // Trigger Container App Job (skip in test mode)
  if (!TEST_MODE) {
    await triggerContainerAppJob(
      {
        userId,
        meetingId,
        transcriptId,
        projectName,
        meetingDate,
        filename,
      },
      context,
    );
    context.log(`Triggered job for: ${projectName}/${filename}`);
  } else {
    context.log(
      `[TEST MODE] Would trigger job with: GRAPH_USER_ID=${userId}, GRAPH_MEETING_ID=${meetingId}, GRAPH_TRANSCRIPT_ID=${transcriptId}, PROJECT_NAME=${projectName}`,
    );
  }

  return {
    userId,
    meetingId,
    transcriptId,
    projectName,
    meetingDate,
    filename,
    jobTriggered: !TEST_MODE,
  };
}

/**
 * Get mock meeting data for testing
 */
function getMockMeeting(notification) {
  const testSubject =
    notification.testData?.subject || "[TestProject] Sprint Review";
  const testDate = notification.testData?.date || new Date().toISOString();

  return {
    id: notification.resourceData?.meetingId || "mock-meeting-id",
    subject: testSubject,
    startDateTime: testDate,
    endDateTime: testDate,
  };
}

async function getGraphToken(context) {
  const cca = new ConfidentialClientApplication({
    auth: {
      clientId: process.env.GRAPH_CLIENT_ID,
      clientSecret: process.env.GRAPH_CLIENT_SECRET,
      authority: `https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID}`,
    },
  });

  const result = await cca.acquireTokenByClientCredential({
    scopes: ["https://graph.microsoft.com/.default"],
  });

  if (!result?.accessToken) {
    throw new Error("Failed to acquire Graph API token");
  }

  return result.accessToken;
}

async function fetchMeeting(token, userId, meetingId, context) {
  // Application permissions require /users/{userId} path (cannot use /me)
  const url = `https://graph.microsoft.com/v1.0/users/${userId}/onlineMeetings/${meetingId}`;

  context.log(`Fetching meeting: ${url}`);

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    context.error(
      `Failed to fetch meeting: ${response.status} ${response.statusText}`,
    );
    const errorText = await response.text();
    context.error(`Error details: ${errorText}`);
    return { error: { message: errorText, status: response.status } };
  }

  return response.json();
}

async function triggerContainerAppJob(params, context) {
  const {
    userId,
    meetingId,
    transcriptId,
    projectName,
    meetingDate,
    filename,
  } = params;

  const credential = new DefaultAzureCredential();
  const subscriptionId = process.env.SUBSCRIPTION_ID;
  const resourceGroup = process.env.CONTAINER_APP_JOB_RESOURCE_GROUP;
  const jobName = process.env.CONTAINER_APP_JOB_NAME;
  const containerImage = process.env.CONTAINER_APP_JOB_IMAGE;

  if (!containerImage) {
    throw new Error("CONTAINER_APP_JOB_IMAGE environment variable is required");
  }

  const client = new ContainerAppsAPIClient(credential, subscriptionId);

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
            { name: "PROJECT_NAME", value: projectName },
            { name: "MEETING_DATE", value: meetingDate },
            { name: "FILENAME", value: filename },
          ],
        },
      ],
    },
  });

  context.log(`Container App Job started with image: ${containerImage}`);
  context.log(`Operation state: ${poller.getOperationState().status}`);
}

function extractProjectName(subject) {
  if (!subject) return "general";

  // Format 1: [ProjectName] Meeting Title
  const bracketMatch = subject.match(/^\[([^\]]+)\]/);
  if (bracketMatch) {
    return bracketMatch[1].toLowerCase().replace(/\s+/g, "-");
  }

  // Format 2: ProjectName - Meeting Title (dash separator)
  const dashMatch = subject.match(/^([^-]+)\s*-\s*.+/);
  if (dashMatch) {
    const projectPart = dashMatch[1].trim();
    if (projectPart.length <= 30 && !projectPart.includes(" and ")) {
      return projectPart.toLowerCase().replace(/\s+/g, "-");
    }
  }

  // Format 3: ProjectName: Meeting Title (colon separator)
  const colonMatch = subject.match(/^([^:]+)\s*:\s*.+/);
  if (colonMatch) {
    const projectPart = colonMatch[1].trim();
    if (projectPart.length <= 30 && !projectPart.includes(" and ")) {
      return projectPart.toLowerCase().replace(/\s+/g, "-");
    }
  }

  return "general";
}

function generateFilename(meeting) {
  const date =
    meeting.startDateTime?.split("T")[0] ||
    new Date().toISOString().split("T")[0];

  let title = meeting.subject || "";

  // Remove project prefix in various formats
  title = title.replace(/^\[[^\]]+\]\s*/, "");

  const dashMatch = meeting.subject?.match(/^([^-]+)\s*-\s*(.+)/);
  if (dashMatch) {
    const projectPart = dashMatch[1].trim();
    if (projectPart.length <= 30 && !projectPart.includes(" and ")) {
      title = dashMatch[2].trim();
    }
  }

  const colonMatch = meeting.subject?.match(/^([^:]+)\s*:\s*(.+)/);
  if (colonMatch) {
    const projectPart = colonMatch[1].trim();
    if (projectPart.length <= 30 && !projectPart.includes(" and ")) {
      title = colonMatch[2].trim();
    }
  }

  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "meeting";

  return `${date}-${slug}.vtt`;
}

// Export for unit testing
module.exports = {
  extractProjectName,
  generateFilename,
  getMockMeeting,
};
