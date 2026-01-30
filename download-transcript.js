#!/usr/bin/env node

/**
 * Download Transcript from Microsoft Graph API
 *
 * This script:
 * 1. Fetches meeting details from Graph API
 * 2. Filters: only processes meetings with "sprint" in subject
 * 3. Extracts project name and generates filename
 * 4. Downloads transcript content (VTT format)
 * 5. Outputs JSON result for entrypoint.sh to parse
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
 *
 * Output (JSON to stdout):
 *   Success: {"success": true, "transcriptPath": "...", "projectName": "...", "meetingDate": "...", "filename": "..."}
 *   Skipped: {"skipped": true, "reason": "..."}
 *   Error: {"error": true, "message": "..."}
 *
 * Exit Codes:
 *   0 = success or skipped
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
  // Mock mode for local testing (bypasses Graph API)
  mockMode: process.env.USE_MOCK_TRANSCRIPT === "true",
  mockTranscriptPath: process.env.MOCK_TRANSCRIPT_PATH,
  mockMeetingSubject:
    process.env.MOCK_MEETING_SUBJECT || "[TestProject] Sprint Review",
  mockMeetingDate: process.env.MOCK_MEETING_DATE,
  // Meeting filter: regex pattern to match meeting subjects (default: "sprint")
  // Set to empty string or ".*" to process all meetings
  meetingFilterPattern: process.env.MEETING_FILTER_PATTERN || "sprint",
};

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
    console.error(output);
  }
}

function validateConfig() {
  // In mock mode, only require the mock transcript path
  if (CONFIG.mockMode) {
    if (!CONFIG.mockTranscriptPath) {
      throw new Error(
        "Mock mode enabled but MOCK_TRANSCRIPT_PATH not set.\n" +
          "Set MOCK_TRANSCRIPT_PATH to a local .vtt file path.",
      );
    }
    return;
  }

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
 * Mock mode: Read local VTT file and simulate Graph API response
 */
async function runMockMode() {
  // Validate mock transcript file exists
  try {
    await fs.access(CONFIG.mockTranscriptPath);
  } catch (error) {
    throw new Error(
      `Mock transcript file not found: ${CONFIG.mockTranscriptPath}`,
    );
  }

  // Simulate meeting object
  const mockMeeting = {
    subject: CONFIG.mockMeetingSubject,
    startDateTime: CONFIG.mockMeetingDate
      ? `${CONFIG.mockMeetingDate}T10:00:00Z`
      : new Date().toISOString(),
  };

  // Filter: only process meetings matching the filter pattern
  const subject = mockMeeting.subject || "";
  if (!matchesMeetingFilter(subject)) {
    outputResult({
      skipped: true,
      reason: `Subject does not match filter pattern '${CONFIG.meetingFilterPattern}': "${subject}"`,
    });
    process.exit(0);
  }

  // Extract project name and generate filename
  const projectName = extractProjectName(subject);
  // In mock mode, use the mock date directly
  const mockTranscriptDate = CONFIG.mockMeetingDate
    ? `${CONFIG.mockMeetingDate}T10:00:00Z`
    : new Date().toISOString();
  const meetingDate = mockTranscriptDate.split("T")[0];
  const filename = generateFilename(mockMeeting, mockTranscriptDate);

  // Read local VTT content
  const content = await fs.readFile(CONFIG.mockTranscriptPath, "utf-8");

  // Validate VTT content
  if (!content.startsWith("WEBVTT")) {
    log("warn", "Mock content may not be valid VTT format", {
      preview: content.substring(0, 100),
    });
  }

  // Save to dropzone (same as real mode)
  const transcriptPath = await saveTranscript(content, filename);

  // Mock values for notification (can be overridden via env)
  // Mock participants - can be set via MOCK_PARTICIPANTS as JSON array
  // Format: [{"userId": "...", "displayName": "..."}]
  const mockParticipants = process.env.MOCK_PARTICIPANTS
    ? JSON.parse(process.env.MOCK_PARTICIPANTS)
    : [];

  // Output result as JSON to stdout
  outputResult({
    success: true,
    transcriptPath,
    projectName,
    meetingDate,
    filename,
    meetingSubject: subject,
    participants: mockParticipants,
  });

  process.exit(0);
}

async function getGraphToken() {
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
  return data.access_token;
}

async function fetchMeeting(token) {
  const graphUrl = `https://graph.microsoft.com/v1.0/users/${CONFIG.userId}/onlineMeetings/${CONFIG.meetingId}`;

  const response = await fetch(graphUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to fetch meeting: ${response.status} - ${errorText}`,
    );
  }

  const meeting = await response.json();

  // Extract participant user IDs for Teams notification via Logic App
  // Format: [{userId}] as expected by send-teams-notification.js
  const participants = [];

  // Add organizer first
  if (meeting.participants?.organizer?.identity?.user?.id) {
    participants.push({
      userId: meeting.participants.organizer.identity.user.id,
    });
  }

  // Add attendees
  if (meeting.participants?.attendees) {
    for (const attendee of meeting.participants.attendees) {
      if (attendee.identity?.user?.id) {
        const userId = attendee.identity.user.id;
        // Skip if already added (avoid duplicates)
        if (!participants.some((p) => p.userId === userId)) {
          participants.push({ userId });
        }
      }
    }
  }

  return {
    ...meeting,
    participants,
  };
}

async function fetchTranscriptMetadata(token) {
  // Graph API endpoint for transcript metadata (includes createdDateTime)
  // GET /users/{userId}/onlineMeetings/{meetingId}/transcripts/{transcriptId}
  const graphUrl = `https://graph.microsoft.com/v1.0/users/${CONFIG.userId}/onlineMeetings/${CONFIG.meetingId}/transcripts/${CONFIG.transcriptId}`;

  const response = await fetch(graphUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to fetch transcript metadata: ${response.status} - ${errorText}`,
    );
  }

  return await response.json();
}

async function fetchActualParticipantsFromChat(token, chatId) {
  // Fetch chat messages and extract actual participants (real users only, no bots)
  // Sources: recording initiator + meeting starter + members joined
  // Filter: userIdentityType === "aadUser" (excludes bots/applications)
  // Deduped by userId
  const graphUrl = `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(chatId)}/messages?$top=50`;

  const response = await fetch(graphUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    log("warn", `Failed to fetch chat messages: ${response.status}`, {
      error: errorText,
    });
    return []; // Return empty array on failure, don't block the pipeline
  }

  const data = await response.json();
  const messages = data.value || [];

  // Collect unique participants from multiple event types
  const participantMap = new Map(); // Use Map to dedupe by ID

  for (const msg of messages) {
    const eventType = msg.eventDetail?.["@odata.type"];

    // 1. callRecordingEventMessageDetail - person who started/stopped recording
    if (eventType === "#microsoft.graph.callRecordingEventMessageDetail") {
      const initiator = msg.eventDetail?.initiator?.user;
      if (initiator?.id && initiator.userIdentityType === "aadUser") {
        participantMap.set(initiator.id, {
          userId: initiator.id,
          displayName: initiator.displayName || "",
        });
      }
    }

    // 2. callStartedEventMessageDetail - meeting initiator
    if (eventType === "#microsoft.graph.callStartedEventMessageDetail") {
      const initiator = msg.eventDetail?.initiator?.user;
      if (initiator?.id && initiator.userIdentityType === "aadUser") {
        participantMap.set(initiator.id, {
          userId: initiator.id,
          displayName: initiator.displayName || "",
        });
      }
    }

    // 3. membersJoinedEventMessageDetail - people who joined
    if (eventType === "#microsoft.graph.membersJoinedEventMessageDetail") {
      const members = msg.eventDetail?.members || [];
      for (const member of members) {
        if (member.id && member.userIdentityType === "aadUser") {
          participantMap.set(member.id, {
            userId: member.id,
            displayName: member.displayName || "",
          });
        }
      }
    }
  }

  const participants = Array.from(participantMap.values());

  log("info", `Found ${participants.length} actual participants from chat`, {
    participants: participants.map((p) => p.displayName || p.userId),
  });

  return participants;
}

async function downloadTranscriptContent(token) {
  // Graph API endpoint for transcript content
  // GET /users/{userId}/onlineMeetings/{meetingId}/transcripts/{transcriptId}/content?$format=text/vtt
  const graphUrl = `https://graph.microsoft.com/v1.0/users/${CONFIG.userId}/onlineMeetings/${CONFIG.meetingId}/transcripts/${CONFIG.transcriptId}/content?$format=text/vtt`;

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
  return vttContent;
}

function parseSubject(subject) {
  if (!subject) return { projectName: "general", title: "meeting" };

  let projectName = "general";
  let title = subject;

  // Format 1: [ProjectName] Meeting Title
  const bracketMatch = subject.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (bracketMatch) {
    projectName = bracketMatch[1].trim();
    title = bracketMatch[2].trim() || "meeting";
    return {
      projectName: projectName.toLowerCase().replace(/\s+/g, "-"),
      title,
    };
  }

  // Format 2: ProjectName - Meeting Title (dash separator)
  const dashMatch = subject.match(/^([^-]+)\s*-\s*(.+)$/);
  if (dashMatch) {
    const projectPart = dashMatch[1].trim();
    if (projectPart.length <= 30 && !projectPart.includes(" and ")) {
      projectName = projectPart;
      title = dashMatch[2].trim();
      return {
        projectName: projectName.toLowerCase().replace(/\s+/g, "-"),
        title,
      };
    }
  }

  // Format 3: ProjectName: Meeting Title (colon separator)
  const colonMatch = subject.match(/^([^:]+)\s*:\s*(.+)$/);
  if (colonMatch) {
    const projectPart = colonMatch[1].trim();
    if (projectPart.length <= 30 && !projectPart.includes(" and ")) {
      projectName = projectPart;
      title = colonMatch[2].trim();
      return {
        projectName: projectName.toLowerCase().replace(/\s+/g, "-"),
        title,
      };
    }
  }

  return { projectName: "general", title: subject };
}

function extractProjectName(subject) {
  return parseSubject(subject).projectName;
}

function generateFilename(meeting, transcriptDate) {
  // Use transcript createdDateTime (actual recording time)
  const date =
    transcriptDate?.split("T")[0] || new Date().toISOString().split("T")[0];

  const { title } = parseSubject(meeting.subject);

  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "meeting";

  return `${date}-${slug}.vtt`;
}

async function saveTranscript(content, filename) {
  let outputPath;

  if (CONFIG.outputPath) {
    outputPath = CONFIG.outputPath;
  } else {
    const tempDir = path.join(process.cwd(), "dropzone");
    await fs.mkdir(tempDir, { recursive: true });
    outputPath = path.join(tempDir, filename);
  }

  await fs.writeFile(outputPath, content, "utf-8");

  return outputPath;
}

function outputResult(result) {
  console.log(JSON.stringify(result));
}

function matchesMeetingFilter(subject) {
  const pattern = CONFIG.meetingFilterPattern;

  // No filter or wildcard = process all
  if (!pattern || pattern === ".*" || pattern === "*") {
    return true;
  }

  try {
    const regex = new RegExp(pattern, "i"); // Case-insensitive
    return regex.test(subject || "");
  } catch (error) {
    // Invalid regex, fallback to simple includes
    log("warn", `Invalid filter pattern '${pattern}', using simple match`, {
      error: error.message,
    });
    return (subject || "").toLowerCase().includes(pattern.toLowerCase());
  }
}

async function main() {
  try {
    // Validate configuration (checks mock mode or Graph API config)
    validateConfig();

    // Mock mode: use local file instead of Graph API
    if (CONFIG.mockMode) {
      return await runMockMode();
    }

    // Get access token
    const token = await getGraphToken();

    // Fetch meeting details
    const meeting = await fetchMeeting(token);

    // Filter: only process meetings matching the filter pattern
    const subject = meeting.subject || "";
    if (!matchesMeetingFilter(subject)) {
      outputResult({
        skipped: true,
        reason: `Subject does not match filter pattern '${CONFIG.meetingFilterPattern}': "${subject}"`,
      });
      process.exit(0);
    }

    // Fetch transcript metadata to get actual recording date
    const transcriptMeta = await fetchTranscriptMetadata(token);
    const transcriptDate = transcriptMeta.createdDateTime;

    // Extract project name and generate filename using transcript date
    const projectName = extractProjectName(subject);
    const meetingDate = transcriptDate
      ? transcriptDate.split("T")[0]
      : new Date().toISOString().split("T")[0];
    const filename = generateFilename(meeting, transcriptDate);

    // Download transcript content
    const content = await downloadTranscriptContent(token);

    // Validate VTT content
    if (!content.startsWith("WEBVTT")) {
      log("warn", "Downloaded content may not be valid VTT format", {
        preview: content.substring(0, 100),
      });
    }

    // Save to file
    const transcriptPath = await saveTranscript(content, filename);

    // Get actual participants from chat messages (not invitees)
    // This uses Chat.Read.All permission to read callEndedEventMessageDetail
    let participants = [];
    const chatId = meeting.chatInfo?.threadId;
    if (chatId) {
      participants = await fetchActualParticipantsFromChat(token, chatId);
    } else {
      log("warn", "No chatId found in meeting, cannot fetch actual participants");
    }

    // Output result as JSON to stdout (includes notification info)
    outputResult({
      success: true,
      transcriptPath,
      projectName,
      meetingDate,
      filename,
      meetingSubject: subject,
      participants,
    });

    process.exit(0);
  } catch (error) {
    log("error", error.message, {
      name: error.name,
      stack: error.stack,
    });
    outputResult({
      error: true,
      message: error.message,
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
  fetchMeeting,
  fetchTranscriptMetadata,
  fetchActualParticipantsFromChat,
  downloadTranscriptContent,
  saveTranscript,
  parseSubject,
  extractProjectName,
  generateFilename,
  matchesMeetingFilter,
  validateConfig,
  runMockMode,
  CONFIG,
};
