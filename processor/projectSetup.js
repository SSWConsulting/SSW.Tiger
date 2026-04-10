const fs = require("fs").promises;
const path = require("path");
const { log } = require("../lib/logger");

/**
 * Validate transcript filename matches YYYY-MM-DD-HHmmss.vtt pattern.
 * @returns {{ meetingId: string, meetingDate: string, meetingTime: string }}
 */
function validateTranscriptFilename(transcriptPath) {
  const filename = path.basename(transcriptPath, ".vtt");

  const dateTimePattern = /^(\d{4}-\d{2}-\d{2})-(\d{6})$/;
  const match = filename.match(dateTimePattern);

  if (!match) {
    throw new Error(
      `Invalid transcript filename: ${path.basename(transcriptPath)}\n` +
        "Transcript files must be named: YYYY-MM-DD-HHmmss.vtt\n" +
        "Example: 2026-01-22-094557.vtt",
    );
  }

  if (path.extname(transcriptPath) !== ".vtt") {
    throw new Error(
      `Invalid transcript file extension: ${path.basename(transcriptPath)}\n` +
        "Only .vtt files are supported",
    );
  }

  return {
    meetingId: filename,
    meetingDate: match[1],
    meetingTime: match[2],
  };
}

/**
 * Create project directory structure and copy transcript + attendees.
 */
async function setupProjectStructure({ meetingPath, transcriptPath }) {
  const dirs = [
    meetingPath,
    path.join(meetingPath, "analysis"),
    path.join(meetingPath, "dashboard"),
  ];

  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }

  // Copy transcript to meeting folder
  const meetingTranscriptPath = path.join(meetingPath, "transcript.vtt");
  try {
    await fs.copyFile(transcriptPath, meetingTranscriptPath);
  } catch (error) {
    log("warn", "Failed to copy transcript", { error: error.message });
  }

  // Write attendees.json from meeting invite list (if available via env var)
  try {
    const inviteesJson = process.env.INVITEES_JSON;
    const vttInfoJson = process.env.VTT_INFO_JSON;
    if (inviteesJson) {
      const invitees = JSON.parse(inviteesJson);
      const vttInfo = vttInfoJson ? JSON.parse(vttInfoJson) : {};
      const attendeesData = {
        invitees,
        vttInfo,
        note: "Invitees are derived from the meeting invite list (UPNs). Use as a suggestion for name resolution — speaker <v> tags in the VTT are authoritative and take priority.",
      };
      const attendeesPath = path.join(meetingPath, "attendees.json");
      await fs.writeFile(
        attendeesPath,
        JSON.stringify(attendeesData, null, 2),
        "utf-8",
      );
      log("info", "Wrote attendees.json", {
        inviteeCount: invitees.length,
        hasSpeakerLabels: vttInfo.hasSpeakerLabels,
      });
    }
  } catch (error) {
    log("warn", "Failed to write attendees.json", {
      error: error.message,
    });
  }

  // Clean up previous analysis for this specific meeting (if exists)
  const analysisDir = path.join(meetingPath, "analysis");
  try {
    const files = await fs.readdir(analysisDir);
    for (const file of files) {
      if (file.endsWith(".json")) {
        await fs.unlink(path.join(analysisDir, file));
      }
    }
  } catch (error) {
    // Directory might not exist or be empty - that's fine
  }
}

module.exports = { validateTranscriptFilename, setupProjectStructure };
