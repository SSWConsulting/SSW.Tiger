#!/usr/bin/env node

/**
 * Download Transcript from Microsoft Graph API
 *
 * Standalone script to download meeting transcripts from Teams.
 * Can be tested independently before running the full processor.
 *
 * Usage:
 *   node download-transcript.js
 *
 * Required Environment Variables:
 *   GRAPH_CLIENT_ID      - App Registration client ID
 *   GRAPH_CLIENT_SECRET  - App Registration client secret
 *   GRAPH_TENANT_ID      - Azure AD tenant ID
 *   GRAPH_USER_ID        - Meeting organizer's user ID
 *   GRAPH_MEETING_ID     - Online meeting ID
 *   GRAPH_TRANSCRIPT_ID  - Transcript ID
 *
 * Optional:
 *   OUTPUT_PATH          - Where to save the file (default: ./dropzone/{filename})
 *   FILENAME             - Output filename (default: transcript.vtt)
 *
 * Exit Codes:
 *   0 = success (outputs file path to stdout)
 *   1 = error
 */

const fs = require("fs").promises;
const path = require("path");

// Configuration from environment
const CONFIG = {
  graphClientId: process.env.GRAPH_CLIENT_ID,
  graphClientSecret: process.env.GRAPH_CLIENT_SECRET,
  graphTenantId: process.env.GRAPH_TENANT_ID,
  userId: process.env.GRAPH_USER_ID,
  meetingId: process.env.GRAPH_MEETING_ID,
  transcriptId: process.env.GRAPH_TRANSCRIPT_ID,
  outputPath: process.env.OUTPUT_PATH,
  filename: process.env.FILENAME || "transcript.vtt",
};

/**
 * Structured logging
 */
function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level: level.toUpperCase(),
    component: "download-transcript",
    message,
    ...(data && { data }),
  };
  const output = JSON.stringify(logEntry);
  if (level === "error") {
    console.error(output);
  } else {
    console.error(output); // Log to stderr so stdout is clean for file path
  }
}

function validateConfig() {
  const required = [
    ["GRAPH_CLIENT_ID", CONFIG.graphClientId],
    ["GRAPH_CLIENT_SECRET", CONFIG.graphClientSecret],
    ["GRAPH_TENANT_ID", CONFIG.graphTenantId],
    ["GRAPH_USER_ID", CONFIG.userId],
    ["GRAPH_MEETING_ID", CONFIG.meetingId],
    ["GRAPH_TRANSCRIPT_ID", CONFIG.transcriptId],
  ];

  const missing = required
    .filter(([name, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n  ${missing.join("\n  ")}`,
    );
  }
}

/**
 * Get Graph API access token using client credentials flow
 */
async function getGraphToken() {
  log("info", "Acquiring Graph API token");

  const tokenUrl = `https://login.microsoftonline.com/${CONFIG.graphTenantId}/oauth2/v2.0/token`;

  const params = new URLSearchParams({
    client_id: CONFIG.graphClientId,
    client_secret: CONFIG.graphClientSecret,
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
    throw new Error(
      `Failed to acquire Graph token: ${response.status} - ${errorText}`,
    );
  }

  const data = await response.json();
  log("info", "Graph API token acquired successfully");
  return data.access_token;
}

/**
 * Download transcript content from Graph API
 */
async function downloadTranscript(token) {
  // Graph API endpoint for transcript content
  // GET /users/{userId}/onlineMeetings/{meetingId}/transcripts/{transcriptId}/content?$format=text/vtt
  const graphUrl = `https://graph.microsoft.com/v1.0/users/${CONFIG.userId}/onlineMeetings/${CONFIG.meetingId}/transcripts/${CONFIG.transcriptId}/content?$format=text/vtt`;

  log("info", "Downloading transcript from Graph API", {
    userId: CONFIG.userId,
    meetingId: CONFIG.meetingId,
    transcriptId: CONFIG.transcriptId,
    url: graphUrl,
  });

  const response = await fetch(graphUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to download transcript: ${response.status} - ${errorText}`,
    );
  }

  const vttContent = await response.text();
  log("info", "Transcript content downloaded", { size: vttContent.length });

  return vttContent;
}

async function saveTranscript(content) {
  let outputPath;

  if (CONFIG.outputPath) {
    outputPath = CONFIG.outputPath;
  } else {
    const tempDir = path.join(process.cwd(), "dropzone");
    await fs.mkdir(tempDir, { recursive: true });
    outputPath = path.join(tempDir, CONFIG.filename);
  }

  await fs.writeFile(outputPath, content, "utf-8");

  log("info", "Transcript saved to file", {
    path: outputPath,
    filename: CONFIG.filename,
    size: content.length,
  });

  return outputPath;
}

async function main() {
  try {
    log("info", "Starting transcript download", {
      userId: CONFIG.userId,
      meetingId: CONFIG.meetingId,
      transcriptId: CONFIG.transcriptId,
      filename: CONFIG.filename,
    });

    // Validate configuration
    validateConfig();

    // Get access token
    const token = await getGraphToken();

    // Download transcript
    const content = await downloadTranscript(token);

    // Validate VTT content
    if (!content.startsWith("WEBVTT")) {
      log("warn", "Downloaded content may not be valid VTT format", {
        preview: content.substring(0, 100),
      });
    }

    // Save to file
    const outputPath = await saveTranscript(content);

    log("info", "Transcript download completed successfully", { outputPath });

    // Output the file path to stdout (for piping to processor)
    console.log(outputPath);

    process.exit(0);
  } catch (error) {
    log("error", error.message, {
      name: error.name,
      stack: error.stack,
    });
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

// Export for testing
module.exports = {
  getGraphToken,
  downloadTranscript,
  saveTranscript,
  validateConfig,
  CONFIG,
};
