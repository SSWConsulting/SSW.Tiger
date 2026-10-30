const { app } = require("@azure/functions");
const {
  latestUnalertedSeries,
  isOrganizerGone,
  buildOrganizerAlert,
} = require("./organizerCheck");

/**
 * Daily check for recurring meetings whose organizer has left.
 *
 * Graph sends no transcript notification for a meeting whose organizer is
 * disabled, so Tiger silently stops processing it (see the docs page below).
 * This looks at Teams meetings processed in the last LOOKBACK_DAYS, checks
 * each organizer's account, and sends the series' participants one Teams
 * card per series explaining how to hand the meeting over.
 *
 * Needs: COSMOS_ENDPOINT (+ managed identity with Cosmos data access),
 * GRAPH_* credentials (User.Read.All), LOGIC_APP_URL with an
 * "organizer-disabled" case.
 */

const LOG_PREFIX = "[TIGER]";
// Covers monthly meetings with room to spare
const LOOKBACK_DAYS = 45;
const DEFAULT_DOCS_URL = "https://sswtiger.com/docs/when-a-meeting-organiser-leaves";

app.timer("CheckMeetingOrganizers", {
  schedule: "0 0 22 * * *", // 22:00 UTC = 8-9am Sydney, before the work day
  handler: async (myTimer, context) => {
    const logicAppUrl = process.env.LOGIC_APP_URL;
    if (!process.env.COSMOS_ENDPOINT || !logicAppUrl) {
      structuredLog(context, "info", "SKIP: organizer check needs COSMOS_ENDPOINT and LOGIC_APP_URL");
      return;
    }
    const docsUrl = process.env.ORGANIZER_DOCS_URL || DEFAULT_DOCS_URL;

    try {
      const container = getMeetingsContainer();
      const meetings = await queryRecentTeamsMeetings(container);
      const series = latestUnalertedSeries(meetings);
      structuredLog(context, "info", "Organizer check started", {
        meetingCount: meetings.length,
        seriesCount: series.length,
      });
      if (series.length === 0) return;

      const token = await getGraphToken();
      const organizers = new Map();
      for (const organizerUserId of new Set(series.map((s) => s.teamsMeeting.organizerUserId))) {
        organizers.set(organizerUserId, await lookupOrganizer(token, organizerUserId, context));
      }

      for (const s of series) {
        const organizer = organizers.get(s.teamsMeeting.organizerUserId);
        if (!isOrganizerGone(organizer)) continue;

        const payload = buildOrganizerAlert({
          series: s,
          organizerName: organizer.displayName,
          docsUrl,
        });
        if (payload.participants.length === 0) {
          structuredLog(context, "warn", "Organizer gone but no participants to alert", {
            projectName: s.projectName,
            meetingId: s.id,
          });
          continue;
        }

        try {
          await postToLogicApp(logicAppUrl, payload);
          await markAlerted(container, s);
          structuredLog(context, "info", "Organizer-disabled alert sent", {
            projectName: s.projectName,
            meetingId: s.id,
            organizerUserId: s.teamsMeeting.organizerUserId,
            recipientCount: payload.participants.length,
          });
        } catch (err) {
          // Not marked as alerted, so tomorrow's run retries
          structuredLog(context, "error", "Organizer-disabled alert failed", {
            projectName: s.projectName,
            meetingId: s.id,
            error: err.message,
          });
        }
      }
    } catch (err) {
      structuredLog(context, "error", `Organizer check failed: ${err.message}`, {
        stack: err.stack,
      });
    }
  },
});

function getMeetingsContainer() {
  const { CosmosClient } = require("@azure/cosmos");
  const { DefaultAzureCredential } = require("@azure/identity");
  const client = new CosmosClient({
    endpoint: process.env.COSMOS_ENDPOINT,
    aadCredentials: new DefaultAzureCredential(),
  });
  return client
    .database(process.env.COSMOS_DATABASE || "tiger")
    .container(process.env.COSMOS_CONTAINER || "meetings");
}

async function queryRecentTeamsMeetings(container) {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .substring(0, 10);
  const { resources } = await container.items
    .query({
      query:
        "SELECT c.id, c.projectName, c.meetingDate, c.teamsMeeting, c.organizerAlertSentAt " +
        "FROM c WHERE c.type = 'meeting' AND IS_DEFINED(c.teamsMeeting) AND c.meetingDate >= @since",
      parameters: [{ name: "@since", value: since }],
    })
    .fetchAll();
  return resources;
}

async function markAlerted(container, series) {
  await container
    .item(series.id, series.projectName)
    .patch([{ op: "add", path: "/organizerAlertSentAt", value: new Date().toISOString() }]);
}

/**
 * GET /users/{id} -> { status, accountEnabled, displayName }. Never throws for
 * HTTP errors; isOrganizerGone() decides what each status means.
 */
async function lookupOrganizer(token, userId, context) {
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}?$select=accountEnabled,displayName`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    if (response.status !== 404) {
      structuredLog(context, "warn", "Organizer lookup failed", {
        userId,
        status: response.status,
      });
    }
    return { status: response.status };
  }
  const user = await response.json();
  return { status: 200, accountEnabled: user.accountEnabled, displayName: user.displayName };
}

async function postToLogicApp(logicAppUrl, payload) {
  const response = await fetch(logicAppUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Logic App failed: ${response.status} - ${errorText}`);
  }
}

async function getGraphToken() {
  const tenantId = process.env.GRAPH_TENANT_ID;
  const clientId = process.env.GRAPH_CLIENT_ID;
  const clientSecret = process.env.GRAPH_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      "Missing Graph API credentials (GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET)",
    );
  }

  const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to acquire Graph token: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data.access_token;
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
