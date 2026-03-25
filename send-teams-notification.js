#!/usr/bin/env node

/**
 * Send Teams Notification via Logic App
 *
 * Posts and updates Adaptive Cards in the meeting's group chat via Logic App.
 *
 * Card lifecycle:
 *   "started"   -> sendCard   -> stores messageId for later update
 *   "completed" -> updateCard -> updates the "started" card with dashboard link
 *   "failed"    -> updateCard -> updates the "started" card with error state
 *   "cancelled" -> updateCard -> updates the "started" card with cancelled state
 *   "skipped"   -> sendCard   -> new card (no prior card to update)
 *
 * Usage:
 *   node send-teams-notification.js
 *
 * Required Environment Variables:
 *   LOGIC_APP_URL         - Logic App HTTP trigger URL
 *   CHAT_ID               - Meeting group chat thread ID
 *
 * Optional:
 *   DASHBOARD_URL         - The deployed dashboard URL (required for "completed")
 *   MEETING_SUBJECT       - Meeting subject for the message
 *   PROJECT_NAME          - Project name
 *   PARTICIPANTS_JSON     - JSON array of participants [{userId}]
 *   NOTIFICATION_TYPE     - "started", "completed", "failed", "cancelled", or "skipped"
 *   CANCEL_URL            - URL to cancel processing (for "started" notifications)
 *   JOB_EXECUTION_ID      - Execution ID for tracking and messageId storage key
 *   TRIGGER_URL           - URL to manually trigger processing (for "skipped" notifications)
 *   MEETING_DURATION      - Pre-formatted duration string
 *   STORAGE_CONNECTION_STRING - Azure Storage connection string (for messageId persistence)
 *
 * Output (JSON to stdout):
 *   Success: {"success": true, "recipientCount": N, "messageId": "..."}
 *   Error: {"error": true, "message": "..."}
 */

const CONFIG = {
  logicAppUrl: process.env.LOGIC_APP_URL,
  chatId: process.env.CHAT_ID,
  dashboardUrl: process.env.DASHBOARD_URL,
  meetingSubject: process.env.MEETING_SUBJECT || "Untitled Meeting",
  projectName: process.env.PROJECT_NAME || "General Project",
  participantsJson: process.env.PARTICIPANTS_JSON,
  notificationType: process.env.NOTIFICATION_TYPE || "completed",
  cancelUrl: process.env.CANCEL_URL,
  executionId: process.env.JOB_EXECUTION_ID,
  triggerUrl: process.env.TRIGGER_URL,
  meetingDuration: process.env.MEETING_DURATION || null,
  storageConnectionString: process.env.STORAGE_CONNECTION_STRING,
};

function log(level, message, data = null) {
  const logEntry = {
    level: level.toLowerCase(),
    message,
    ...(data && { ...data }),
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
    return participants.filter((p) => p && p.userId);
  } catch (error) {
    log("warn", "Failed to parse PARTICIPANTS_JSON", { error: error.message });
    return [];
  }
}

/**
 * Determine the Logic App operation type based on notification type.
 * "started" and "skipped" send a new card; others update the existing card.
 */
function getOperationType(notificationType) {
  switch (notificationType) {
    case "started":
    case "skipped":
      return "sendCard";
    case "completed":
    case "failed":
    case "cancelled":
      return "updateCard";
    default:
      return "sendCard";
  }
}


/**
 * Try to retrieve the stored messageId for this execution.
 * Returns { messageId, chatId } or null.
 */
async function getStoredMessageId() {
  if (!CONFIG.executionId || !CONFIG.storageConnectionString) {
    return null;
  }

  try {
    const { getMessageId } = require("./lib/tableStorage");
    return await getMessageId(CONFIG.executionId);
  } catch (err) {
    log("warn", "Failed to retrieve messageId from Table Storage", {
      error: err.message,
    });
    return null;
  }
}

/**
 * Store the messageId returned by Logic App after sending a new card.
 */
async function saveMessageId(messageId) {
  if (!CONFIG.executionId || !CONFIG.storageConnectionString) {
    log("debug", "Skipping messageId storage (no executionId or connection string)");
    return;
  }

  try {
    const { storeMessageId } = require("./lib/tableStorage");
    await storeMessageId(CONFIG.executionId, messageId, CONFIG.chatId);
  } catch (err) {
    log("warn", "Failed to store messageId in Table Storage", {
      error: err.message,
    });
  }
}

async function sendViaLogicApp(participants) {
  const operationType = getOperationType(CONFIG.notificationType);

  const payload = {
    operationType,
    notificationType: CONFIG.notificationType,
    chatId: CONFIG.chatId,
    dashboardUrl: CONFIG.dashboardUrl,
    projectName: CONFIG.projectName,
    meetingSubject: CONFIG.meetingSubject,
    participants: participants,
    meetingDuration: CONFIG.meetingDuration,
  };

  // For updateCard, retrieve the stored messageId
  if (operationType === "updateCard") {
    const stored = await getStoredMessageId();
    if (stored && stored.messageId) {
      payload.messageId = stored.messageId;
      // Use stored chatId as fallback if not set in env
      if (!payload.chatId && stored.chatId) {
        payload.chatId = stored.chatId;
      }
      log("debug", "Using stored messageId for card update", {
        messageId: stored.messageId,
      });
    } else {
      // No stored messageId — fall back to sending a new card
      log("warn", "No stored messageId found, falling back to sendCard", {
        executionId: CONFIG.executionId,
      });
      payload.operationType = "sendCard";
    }
  }

  // Include cancelUrl for "started" notifications
  if (CONFIG.notificationType === "started" && CONFIG.cancelUrl) {
    payload.cancelUrl = CONFIG.cancelUrl;
    payload.executionId = CONFIG.executionId;
    log("debug", "Including cancel URL in notification", {
      cancelUrl: CONFIG.cancelUrl,
      executionId: CONFIG.executionId,
    });
  }

  // Include triggerUrl for "skipped" notifications
  if (CONFIG.notificationType === "skipped" && CONFIG.triggerUrl) {
    payload.triggerUrl = CONFIG.triggerUrl;
    log("debug", "Including trigger URL in notification", {
      triggerUrl: CONFIG.triggerUrl,
    });
  }

  log("info", `Sending ${payload.operationType} request to Logic App`, {
    notificationType: CONFIG.notificationType,
    operationType: payload.operationType,
    hasChatId: !!payload.chatId,
    hasMessageId: !!payload.messageId,
  });

  const response = await fetch(CONFIG.logicAppUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Logic App failed: ${response.status} - ${errorText}`);
  }

  // For sendCard, Logic App returns { messageId } — store it for later updates
  let messageId = null;
  if (payload.operationType === "sendCard") {
    try {
      const responseBody = await response.json();
      messageId = responseBody.messageId || null;
      if (messageId) {
        log("info", "Received messageId from Logic App", { messageId });
        await saveMessageId(messageId);
      } else {
        log("warn", "Logic App did not return a messageId");
      }
    } catch (err) {
      log("warn", "Could not parse Logic App response for messageId", {
        error: err.message,
      });
    }
  }

  log(
    "info",
    `Logic App notification (${CONFIG.notificationType}) sent successfully`,
    {
      recipientCount: participants.length,
      notificationType: CONFIG.notificationType,
      operationType: payload.operationType,
      messageId,
    },
  );

  return messageId;
}

async function main() {
  try {
    // Validate required config
    if (!CONFIG.logicAppUrl) {
      throw new Error("LOGIC_APP_URL is required");
    }
    if (!CONFIG.chatId) {
      // For updateCard, we might get chatId from Table Storage
      const operationType = getOperationType(CONFIG.notificationType);
      if (operationType === "sendCard") {
        throw new Error("CHAT_ID is required for sending new cards");
      }
      log("warn", "CHAT_ID not set, will try to retrieve from Table Storage");
    }
    if (CONFIG.notificationType === "completed" && !CONFIG.dashboardUrl) {
      throw new Error("DASHBOARD_URL is required for completed notifications");
    }

    const participants = parseParticipants();

    if (participants.length === 0) {
      log("warn", "No participants found, sending to chat only");
    }

    const messageId = await sendViaLogicApp(participants);

    outputResult({
      success: true,
      recipientCount: participants.length,
      messageId,
    });
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
