/**
 * Meeting History for Longitudinal Analysis
 *
 * Writes the project's most recent prior meetings' analysis from Cosmos DB to
 * `{meetingPath}/history/` for the longitudinal-analyzer, plus a `status.json`
 * that always says whether history loaded, doesn't exist, or couldn't be read.
 */

const fs = require("fs").promises;
const path = require("path");
const cosmos = require("../lib/cosmosClient");
const { log } = require("../lib/logger");

// Enough for the agent's "3-meeting trend" plus one, without bloating its context
const HISTORY_LIMIT = 4;

// The parts of consolidated.json the longitudinal-analyzer audits. Copying
// only these keeps its context small and limits what a past meeting exposes.
const HISTORY_FIELDS = [
  "metadata",
  "executiveSummary",
  "participants",
  "keyDecisions",
  "doneThisSprint",
  "nextSteps",
  "consolidatedTrends",
  "consolidatedAnalytics",
];

const pick = (obj, keys) =>
  Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

/**
 * Which protected meetings to leave out of history. Meetings protected on
 * their own must not surface in a later dashboard - unless the whole project
 * is protected, in which case they're kept and the run is flagged so the
 * deploy refuses to publish this dashboard publicly (see deployDashboard).
 */
async function protectedMeetings(projectName) {
  const policy = await cosmos.getProjectPolicy(projectName);
  if (policy?.passwordProtectionEnabled) return { projectProtected: true, excludeIds: [] };

  const records = await cosmos.listMeetingSecurityByProject(projectName);
  return {
    projectProtected: false,
    excludeIds: records.filter((r) => r.passwordEnabled).map((r) => r.meetingId),
  };
}

/**
 * Fetch prior meetings and write them, plus `history/status.json`.
 * Never throws - returns the history status (also written to status.json when possible).
 */
async function writeMeetingHistory({ projectName, meetingId, meetingPath }) {
  const historyDir = path.join(meetingPath, "history");
  try {
    const status = await loadHistory({ projectName, meetingId, historyDir });
    await fs.mkdir(historyDir, { recursive: true });
    await fs.writeFile(path.join(historyDir, "status.json"), JSON.stringify(status, null, 2), "utf-8");
    return status;
  } catch (err) {
    // Filesystem trouble - the analyzer finds no status.json and no history
    log("error", "Failed to write meeting history (non-fatal)", { error: err.message });
    return { status: "unavailable", reason: "Could not write history files" };
  }
}

async function loadHistory({ projectName, meetingId, historyDir }) {
  // Clear stale files so the folder only ever holds this run's history
  await fs.rm(historyDir, { recursive: true, force: true });

  if (!process.env.COSMOS_ENDPOINT) {
    log("warn", "COSMOS_ENDPOINT not set, skipping meeting history");
    return { status: "unavailable", reason: "Cosmos DB not configured" };
  }

  try {
    const { projectProtected, excludeIds } = await protectedMeetings(projectName);
    const meetings = await cosmos.queryMeetings({
      projectName,
      beforeMeetingId: meetingId,
      excludeMeetingIds: excludeIds,
      requireConsolidated: true,
      limit: HISTORY_LIMIT,
    });
    if (meetings.length === 0) return { status: "none" };

    await fs.mkdir(historyDir, { recursive: true });
    for (const m of meetings) {
      const record = {
        meetingId: m.meetingId,
        meetingDate: m.meetingDate,
        consolidated: pick(m.consolidated, HISTORY_FIELDS),
      };
      await fs.writeFile(
        path.join(historyDir, `${path.basename(m.meetingId)}.json`),
        JSON.stringify(record, null, 2),
        "utf-8",
      );
    }

    const meetingIds = meetings.map((m) => m.meetingId);
    log("info", "Wrote meeting history for trend analysis", { count: meetingIds.length });
    // In a protected project every history meeting is itself protected
    return { status: "loaded", meetingIds, includesProtectedMeetings: projectProtected };
  } catch (err) {
    log("error", "Failed to fetch meeting history (non-fatal)", { error: err.message });
    return { status: "unavailable", reason: "Cosmos DB read failed" };
  }
}

module.exports = { writeMeetingHistory };
