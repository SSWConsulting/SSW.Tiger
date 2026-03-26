const { app, output } = require("@azure/functions");

/**
 * Manual trigger for transcript processing.
 *
 * Accepts a Teams meeting join URL, resolves it to Graph API IDs,
 * discovers available transcripts, and queues them for processing.
 *
 * This bypasses the automatic subject filter (e.g. "sprint" keyword)
 * but still respects external participant checks.
 *
 * Usage:
 *   POST /api/TriggerProcessing
 *   Body: { "joinUrl": "https://teams.microsoft.com/l/meetup-join/..." }
 *
 *   GET /api/TriggerProcessing?joinUrl=https://teams.microsoft.com/l/meetup-join/...
 */

const LOG_PREFIX = "[TIGER]";

/**
 * Generate HTML response page for browser requests
 */
function generateHtmlResponse(success, message, details = {}) {
  const icon = success ? "🐯" : "❌";
  const title = success ? "Processing Queued" : "Trigger Failed";
  const bgColor = success ? "#d4edda" : "#f8d7da";
  const textColor = success ? "#155724" : "#721c24";
  const borderColor = success ? "#c3e6cb" : "#f5c6cb";

  const detailsHtml = details.subject
    ? `<div class="details">
        <p><strong>Meeting:</strong> ${details.subject}</p>
        ${details.transcriptCreated ? `<p><strong>Transcript:</strong> ${new Date(details.transcriptCreated).toLocaleString()}</p>` : ""}
      </div>`
    : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - SSW Tiger</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: #f5f5f5;
    }
    .card {
      background: white;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.1);
      padding: 40px;
      text-align: center;
      max-width: 400px;
    }
    .icon { font-size: 64px; margin-bottom: 20px; }
    .title { font-size: 24px; font-weight: 600; margin-bottom: 12px; color: #333; }
    .message {
      padding: 16px;
      border-radius: 8px;
      background: ${bgColor};
      color: ${textColor};
      border: 1px solid ${borderColor};
      margin-bottom: 20px;
    }
    .details { font-size: 14px; color: #555; text-align: left; margin-bottom: 16px; }
    .details p { margin: 4px 0; }
    .close-hint { margin-top: 20px; color: #999; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <div class="title">${title}</div>
    <div class="message">${message}</div>
    ${detailsHtml}
    <div class="close-hint">You can close this window now.</div>
  </div>
</body>
</html>`;
}

/**
 * Return response based on request type (HTML for browser, JSON for API)
 */
function createResponse(request, success, message, statusCode, details = {}) {
  const acceptHeader = request.headers.get("accept") || "";
  const isJsonRequest = acceptHeader.includes("application/json");

  if (isJsonRequest) {
    return {
      status: statusCode,
      jsonBody: success
        ? { success: true, message, ...details }
        : { error: true, message, ...details },
    };
  }

  return {
    status: statusCode,
    headers: { "Content-Type": "text/html" },
    body: generateHtmlResponse(success, message, details),
  };
}

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

// Queue output binding (same queue as TranscriptWebhook)
const queueOutput = output.storageQueue({
  queueName: "transcript-notifications",
  connection: "AzureWebJobsStorage",
});

/**
 * Parse a Teams meeting join URL to extract the organizer's user ID.
 *
 * Join URL format:
 *   https://teams.microsoft.com/l/meetup-join/19%3ameeting_XXX%40thread.v2/0?context=%7b%22Tid%22%3a%22TENANT_ID%22%2c%22Oid%22%3a%22USER_ID%22%7d
 *
 * The `context` query parameter is URL-encoded JSON containing:
 *   { "Tid": "tenant-id", "Oid": "organizer-user-id" }
 */
function parseJoinUrl(joinUrl) {
  try {
    const url = new URL(joinUrl);

    // Validate it's a Teams meeting URL
    if (
      !url.hostname.includes("teams.microsoft.com") &&
      !url.hostname.includes("teams.live.com")
    ) {
      return { error: "Not a valid Teams meeting URL" };
    }

    const contextParam = url.searchParams.get("context");
    if (!contextParam) {
      return { error: "Missing 'context' parameter in join URL" };
    }

    const context = JSON.parse(contextParam);
    const userId = context.Oid;
    const tenantId = context.Tid;

    if (!userId) {
      return { error: "Could not extract organizer ID (Oid) from join URL" };
    }

    return { userId, tenantId, joinUrl };
  } catch (err) {
    return { error: `Failed to parse join URL: ${err.message}` };
  }
}

/**
 * Get a Graph API access token using client credentials.
 */
async function getGraphToken() {
  const tenantId = process.env.GRAPH_TENANT_ID;
  const clientId = process.env.GRAPH_CLIENT_ID;
  const clientSecret = process.env.GRAPH_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      "Missing Graph API credentials (GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET)",
    );
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to acquire Graph token: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data.access_token;
}

/**
 * Find a meeting by its join URL using Graph API.
 * GET /users/{userId}/onlineMeetings?$filter=JoinWebUrl eq '{joinUrl}'
 */
async function findMeetingByJoinUrl(token, userId, joinUrl) {
  // The JoinWebUrl filter requires the exact URL as stored by Graph.
  // We need to escape single quotes in the URL for the OData filter.
  const escapedUrl = joinUrl.replace(/'/g, "''");
  const graphUrl = `https://graph.microsoft.com/v1.0/users/${userId}/onlineMeetings?$filter=JoinWebUrl eq '${escapedUrl}'`;

  const response = await fetch(graphUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to find meeting: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const meetings = data.value || [];

  if (meetings.length === 0) {
    return null;
  }

  return meetings[0];
}

/**
 * List transcripts for a meeting.
 * GET /users/{userId}/onlineMeetings/{meetingId}/transcripts
 */
async function listTranscripts(token, userId, meetingId) {
  const graphUrl = `https://graph.microsoft.com/v1.0/users/${userId}/onlineMeetings/${meetingId}/transcripts`;

  const response = await fetch(graphUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to list transcripts: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data.value || [];
}

app.http("TriggerProcessing", {
  methods: ["POST", "GET"],
  authLevel: "anonymous",
  extraOutputs: [queueOutput],
  handler: async (request, context) => {
    // Check if this is an ad-hoc call trigger (raw IDs passed directly)
    const callType = request.query.get("callType");
    if (callType === "adhocCall") {
      return handleAdhocCallTrigger(request, context);
    }

    // Extract joinUrl from query string (GET) or request body (POST)
    let joinUrl = request.query.get("joinUrl");

    if (!joinUrl && request.method === "POST") {
      try {
        const body = await request.json();
        joinUrl = body.joinUrl;
      } catch {
        // Body might not be JSON
      }
    }

    if (!joinUrl) {
      return createResponse(
        request,
        false,
        "Missing 'joinUrl' parameter. Provide a Teams meeting join URL.",
        400,
      );
    }

    structuredLog(context, "info", "Manual trigger requested", {
      joinUrl: joinUrl.substring(0, 80) + "...",
    });

    // Step 1: Parse the join URL to extract organizer user ID
    const parsed = parseJoinUrl(joinUrl);
    if (parsed.error) {
      structuredLog(context, "error", "Failed to parse join URL", {
        error: parsed.error,
      });
      return createResponse(request, false, parsed.error, 400);
    }

    const { userId } = parsed;
    structuredLog(context, "info", "Extracted organizer from join URL", {
      userId,
    });

    try {
      // Step 2: Get Graph API token
      const token = await getGraphToken();

      // Step 3: Find the meeting by join URL
      const meeting = await findMeetingByJoinUrl(token, userId, joinUrl);
      if (!meeting) {
        structuredLog(context, "warn", "No meeting found for join URL", {
          userId,
        });
        return createResponse(
          request,
          false,
          "No meeting found for this join URL. The meeting may have been deleted or the URL may be incorrect.",
          404,
        );
      }

      const meetingId = meeting.id;
      const subject = meeting.subject || "(no subject)";
      structuredLog(context, "info", "Found meeting", {
        meetingId,
        subject,
      });

      // Step 4: List transcripts for this meeting
      const transcripts = await listTranscripts(token, userId, meetingId);
      if (transcripts.length === 0) {
        structuredLog(context, "warn", "No transcripts found for meeting", {
          meetingId,
          subject,
        });
        return createResponse(
          request,
          false,
          `No transcripts found for meeting "${subject}". Ensure recording/transcription was enabled.`,
          404,
          { subject },
        );
      }

      // Step 5: Queue the latest transcript for processing
      // Sort by createdDateTime descending and take the latest
      transcripts.sort(
        (a, b) =>
          new Date(b.createdDateTime) - new Date(a.createdDateTime),
      );
      const latestTranscript = transcripts[0];
      const transcriptId = latestTranscript.id;

      structuredLog(context, "info", "Queuing transcript for processing", {
        userId,
        meetingId,
        transcriptId,
        subject,
        transcriptCount: transcripts.length,
        createdDateTime: latestTranscript.createdDateTime,
      });

      const queueMessage = {
        userId,
        meetingId,
        transcriptId,
        callType: "onlineMeeting",
        skipSubjectFilter: true,
        manualTrigger: true,
        timestamp: new Date().toISOString(),
      };

      context.extraOutputs.set(queueOutput, [queueMessage]);

      return createResponse(
        request,
        true,
        `Processing has been queued for "${subject}". You'll receive a Teams notification when the dashboard is ready.`,
        202,
        { subject, transcriptCreated: latestTranscript.createdDateTime },
      );
    } catch (err) {
      structuredLog(context, "error", "Manual trigger failed", {
        error: err.message,
        stack: err.stack,
      });
      return createResponse(
        request,
        false,
        `Failed to process: ${err.message}`,
        500,
      );
    }
  },
});

/**
 * Handle manual trigger for ad-hoc calls.
 * Unlike online meetings (which use a join URL to discover the meeting),
 * ad-hoc calls pass the raw IDs directly since there's no join URL to resolve.
 *
 * Query params: callType=adhocCall&callId={id}&userId={id}&transcriptId={id}
 */
async function handleAdhocCallTrigger(request, context) {
  const callId = request.query.get("callId");
  const userId = request.query.get("userId");
  const transcriptId = request.query.get("transcriptId");

  if (!callId || !userId || !transcriptId) {
    return createResponse(
      request,
      false,
      "Missing required parameters for ad-hoc call trigger: callId, userId, transcriptId",
      400,
    );
  }

  structuredLog(context, "info", "Ad-hoc call manual trigger requested", {
    callId,
    userId,
    transcriptId,
  });

  const queueMessage = {
    userId,
    callId,
    transcriptId,
    callType: "adhocCall",
    skipSubjectFilter: true,
    manualTrigger: true,
    timestamp: new Date().toISOString(),
  };

  context.extraOutputs.set(queueOutput, [queueMessage]);

  return createResponse(
    request,
    true,
    "Ad-hoc call transcript has been queued for processing. You'll receive a Teams notification when the dashboard is ready.",
    202,
    { callId },
  );
}
