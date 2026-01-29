#!/usr/bin/env node

/**
 * Send Teams Notification via Logic App
 *
 * Sends private messages to each meeting participant via Azure Logic App.
 * Logic App uses Flow bot to send individual messages.
 *
 * Usage:
 *   node send-teams-notification.js
 *
 * Required Environment Variables:
 *   LOGIC_APP_URL         - Logic App HTTP trigger URL
 *   DASHBOARD_URL         - The deployed dashboard URL
 *
 * Optional:
 *   MEETING_SUBJECT       - Meeting subject for the message
 *   PROJECT_NAME          - Project name
 *   PARTICIPANTS_JSON     - JSON array of participants [{userId, displayName}]
 *
 * Output (JSON to stdout):
 *   Success: {"success": true, "recipientCount": N}
 *   Error: {"error": true, "message": "..."}
 */

const CONFIG = {
  logicAppUrl: process.env.LOGIC_APP_URL,
  dashboardUrl: process.env.DASHBOARD_URL,
  meetingSubject: process.env.MEETING_SUBJECT || "Untitled Meeting",
  projectName: process.env.PROJECT_NAME || "General Project",
  participantsJson: process.env.PARTICIPANTS_JSON,
};

function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level: level.toUpperCase(),
    component: "send-teams-notification",
    message,
    ...(data && { data }),
  };
  console.error(JSON.stringify(logEntry));
}

function outputResult(result) {
  console.log(JSON.stringify(result));
}

function parseParticipants() {
  if (!CONFIG.participantsJson) {
    return [];
  }
  try {
    const participants = JSON.parse(CONFIG.participantsJson);
    if (!Array.isArray(participants)) {
      log("warn", "PARTICIPANTS_JSON is not an array, ignoring");
      return [];
    }
    // Filter to only include participants with userId
    return participants.filter((p) => p && p.userId);
  } catch (error) {
    log("warn", "Failed to parse PARTICIPANTS_JSON", { error: error.message });
    return [];
  }
}

async function sendViaLogicApp(participants) {
  const payload = {
    dashboardUrl: CONFIG.dashboardUrl,
    projectName: CONFIG.projectName,
    meetingSubject: CONFIG.meetingSubject,
    participants: participants,
  };

  const response = await fetch(CONFIG.logicAppUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Logic App failed: ${response.status} - ${errorText}`);
  }

  log("info", "Logic App notification sent successfully", {
    recipientCount: participants.length,
  });
}

async function main() {
  try {
    // Validate required config
    if (!CONFIG.logicAppUrl) {
      throw new Error("LOGIC_APP_URL is required");
    }
    if (!CONFIG.dashboardUrl) {
      throw new Error("DASHBOARD_URL is required");
    }

    const participants = parseParticipants();

    if (participants.length === 0) {
      log("warn", "No participants to notify, skipping");
      outputResult({ success: true, recipientCount: 0, skipped: true });
      process.exit(0);
    }

    log("info", "Starting Teams notification", {
      dashboardUrl: CONFIG.dashboardUrl,
      projectName: CONFIG.projectName,
      meetingSubject: CONFIG.meetingSubject,
      recipientCount: participants.length,
    });

    await sendViaLogicApp(participants);

    outputResult({ success: true, recipientCount: participants.length });
    process.exit(0);
  } catch (error) {
    log("error", error.message, { stack: error.stack });
    outputResult({ error: true, message: error.message });
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { sendViaLogicApp, parseParticipants, CONFIG };
