const { app, output } = require("@azure/functions");
const { buildResponse } = require("../htmlResponseCard");

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

// SSW Tiger logo URL (optionally overridable via env var for environment swaps)
const TIGER_LOGO_URL =
  process.env.TIGER_LOGO_URL ||
  "https://satigerstagingweb.blob.core.windows.net/assets/Logo.png";

/**
 * Wrap the shared buildResponse with this endpoint's outcome labels.
 * Optionally renders a meeting/transcript details block.
 */
function createResponse(request, success, message, statusCode, details = {}) {
  const detailsHtml = details.subject
    ? `<div class="details">
        <p><strong>Meeting:</strong> ${details.subject}</p>
        ${details.transcriptCreated ? `<p><strong>Transcript:</strong> ${new Date(details.transcriptCreated).toLocaleString()}</p>` : ""}
      </div>`
    : "";

  return buildResponse(request, statusCode, {
    success,
    message,
    json: details,
    card: {
      status: success ? "success" : "error",
      // Brand image on success; expressive emoji for the error state
      iconImageUrl: success ? TIGER_LOGO_URL : undefined,
      icon: success ? "" : "❌",
      title: success ? "Processing Queued" : "Trigger Failed",
      detailsHtml,
    },
  });
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
