const { app } = require("@azure/functions");
const { DefaultAzureCredential } = require("@azure/identity");
const { BlobServiceClient } = require("@azure/storage-blob");
const { ContainerAppsAPIClient } = require("@azure/arm-appcontainers");
const { ConfidentialClientApplication } = require("@azure/msal-node");
const fs = require("fs");
const path = require("path");

// Test mode: skip Graph API and Container Job, use local VTT file
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

  const meetingId = notification.resourceData.meetingId;
  const transcriptId = notification.resourceData.id;
  const organizerId = notification.resourceData.meetingOrganizerId;

  context.log(
    `Processing transcript: meetingId=${meetingId}, transcriptId=${transcriptId}`,
  );

  let meeting, vttContent;

  if (TEST_MODE) {
    // TEST MODE: Use mock data
    meeting = getMockMeeting(notification);
    vttContent = getMockVttContent(notification);
    context.log("[TEST MODE] Using mock meeting and VTT data");
  } else {
    // PRODUCTION: Call Graph API
    const graphToken = await getGraphToken(context);
    meeting = await fetchMeeting(graphToken, organizerId, meetingId, context);
    if (!meeting) {
      throw new Error("Failed to fetch meeting details");
    }
    vttContent = await downloadTranscript(
      graphToken,
      organizerId,
      meetingId,
      transcriptId,
      context,
    );
    if (!vttContent) {
      throw new Error("Failed to download transcript");
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

  // Extract meeting date from startDateTime (ISO 8601 format from Graph API)
  // Graph API onlineMeeting resource: https://learn.microsoft.com/en-us/graph/api/onlinemeeting-get
  const meetingDate = meeting.startDateTime
    ? meeting.startDateTime.split("T")[0]
    : new Date().toISOString().split("T")[0];
  const projectName = extractProjectName(subject);
  const filename = generateFilename(meeting);

  context.log(
    `Meeting: project=${projectName}, date=${meetingDate}, filename=${filename}`,
  );
  context.log(`VTT content: ${vttContent.length} bytes`);

  // Upload to Blob Storage (works with Azurite locally)
  const blobPath = `${projectName}/${filename}`;
  await uploadToBlob(vttContent, blobPath, context);
  context.log(`Uploaded VTT to Blob: ${blobPath}`);

  // Trigger Container App Job (skip in test mode)
  if (!TEST_MODE) {
    await triggerContainerAppJob(
      blobPath,
      projectName,
      meetingDate,
      filename,
      context,
    );
    context.log(`Triggered job for: ${projectName}/${filename}`);
  } else {
    context.log(
      `[TEST MODE] Would trigger job with: BLOB_PATH=${blobPath}, PROJECT_NAME=${projectName}, MEETING_DATE=${meetingDate}`,
    );
  }

  return {
    projectName,
    meetingDate,
    filename,
    blobPath,
    vttBytes: vttContent.length,
    jobTriggered: !TEST_MODE,
  };
}

/**
 * Get mock meeting data for testing
 */
function getMockMeeting(notification) {
  // Use test data from notification or defaults
  const testSubject =
    notification.testData?.subject || "[TestProject] Daily Standup";
  const testDate = notification.testData?.date || new Date().toISOString();

  return {
    id: notification.resourceData?.meetingId || "mock-meeting-id",
    subject: testSubject,
    startDateTime: testDate,
    endDateTime: testDate,
  };
}

function getMockVttContent(notification) {
  // Check if a local test file is specified
  const testVttPath =
    notification.testData?.vttPath || process.env.TEST_VTT_PATH;

  if (testVttPath && fs.existsSync(testVttPath)) {
    return fs.readFileSync(testVttPath, "utf-8");
  }

  // Return minimal mock VTT
  return `WEBVTT

00:00:00.000 --> 00:00:05.000
<v Test Speaker>This is a test transcript for local development.

00:00:05.000 --> 00:00:10.000
<v Test Speaker>The Graph API integration is mocked in TEST_MODE.
`;
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

async function fetchMeeting(token, organizerId, meetingId, context) {
  const url = `https://graph.microsoft.com/v1.0/users/${organizerId}/onlineMeetings/${meetingId}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    context.error(
      `Failed to fetch meeting: ${response.status} ${response.statusText}`,
    );
    const errorText = await response.text();
    context.error(`Error details: ${errorText}`);
    return null;
  }

  return response.json();
}

async function downloadTranscript(
  token,
  organizerId,
  meetingId,
  transcriptId,
  context,
) {
  const url = `https://graph.microsoft.com/v1.0/users/${organizerId}/onlineMeetings/${meetingId}/transcripts/${transcriptId}/content?$format=text/vtt`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    context.error(
      `Failed to download transcript: ${response.status} ${response.statusText}`,
    );
    const errorText = await response.text();
    context.error(`Error details: ${errorText}`);
    return null;
  }

  return response.text();
}

async function uploadToBlob(content, blobPath, context) {
  const connectionString = process.env.AzureWebJobsStorage;
  const containerName = process.env.TRANSCRIPT_CONTAINER_NAME || "transcripts";

  const blobServiceClient =
    BlobServiceClient.fromConnectionString(connectionString);
  const containerClient = blobServiceClient.getContainerClient(containerName);

  // Ensure container exists
  await containerClient.createIfNotExists();

  const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
  await blockBlobClient.upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: { blobContentType: "text/vtt" },
  });
}

async function triggerContainerAppJob(
  blobPath,
  projectName,
  meetingDate,
  filename,
  context,
) {
  const credential = new DefaultAzureCredential();
  const subscriptionId = process.env.SUBSCRIPTION_ID;
  const resourceGroup = process.env.CONTAINER_APP_JOB_RESOURCE_GROUP;
  const jobName = process.env.CONTAINER_APP_JOB_NAME;

  const client = new ContainerAppsAPIClient(credential, subscriptionId);

  await client.jobs.beginStartAndWait(resourceGroup, jobName, {
    template: {
      containers: [
        {
          name: "tiger-processor",
          env: [
            { name: "BLOB_PATH", value: blobPath },
            { name: "PROJECT_NAME", value: projectName },
            { name: "MEETING_DATE", value: meetingDate },
            { name: "FILENAME", value: filename },
          ],
        },
      ],
    },
  });
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
    // Only treat as project name if it's reasonably short (not a full sentence)
    if (projectPart.length <= 30 && !projectPart.includes(" and ")) {
      return projectPart.toLowerCase().replace(/\s+/g, "-");
    }
  }

  // Format 3: ProjectName: Meeting Title (colon separator)
  const colonMatch = subject.match(/^([^:]+)\s*:\s*.+/);
  if (colonMatch) {
    const projectPart = colonMatch[1].trim();
    // Only treat as project name if it's reasonably short (not a full sentence)
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
  // Format 1: [Project] Title
  title = title.replace(/^\[[^\]]+\]\s*/, "");

  // Format 2: Project - Title (dash separator)
  const dashMatch = meeting.subject?.match(/^([^-]+)\s*-\s*(.+)/);
  if (dashMatch) {
    const projectPart = dashMatch[1].trim();
    if (projectPart.length <= 30 && !projectPart.includes(" and ")) {
      title = dashMatch[2].trim();
    }
  }

  // Format 3: Project: Title (colon separator)
  const colonMatch = meeting.subject?.match(/^([^:]+)\s*:\s*(.+)/);
  if (colonMatch) {
    const projectPart = colonMatch[1].trim();
    if (projectPart.length <= 30 && !projectPart.includes(" and ")) {
      title = colonMatch[2].trim();
    }
  }

  // Slugify
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-") // Replace non-alphanumeric with dash
      .replace(/^-|-$/g, "") || // Trim leading/trailing dashes
    "";

  return slug ? `${date}-${slug}.vtt` : `${date}.vtt`;
}

// Export for unit testing
module.exports = {
  extractProjectName,
  generateFilename,
  getMockMeeting,
  getMockVttContent,
};
