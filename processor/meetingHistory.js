/**
 * Meeting History for Longitudinal Analysis
 *
 * Each run starts in a fresh container holding only the current meeting, so
 * the longitudinal-analyzer had nothing to compare against and always reported
 * "First analyzed meeting". This pulls the project's most recent prior
 * meetings from Cosmos DB and writes their consolidated analysis to
 * `{meetingPath}/history/`, where the agent is told to look.
 */

const fs = require("fs").promises;
const path = require("path");
const cosmos = require("../lib/cosmosClient");
const { log } = require("../lib/logger");

// Enough for the agent's "3-meeting trend" plus one, without bloating its context
const HISTORY_LIMIT = 4;

/**
 * Write prior meetings' consolidated analysis to `{meetingPath}/history/`.
 *
 * Non-fatal: returns `{ status: "loaded", meetingIds }` (newest first),
 * `{ status: "none" }` when the project has no earlier meetings, or
 * `{ status: "unavailable" }` when Cosmos isn't configured or the read failed -
 * so the prompt never claims "first meeting" for a project that has history.
 */
async function writeMeetingHistory({ projectName, meetingId, meetingPath }) {
  if (!process.env.COSMOS_ENDPOINT) {
    log("warn", "COSMOS_ENDPOINT not set, skipping meeting history");
    return { status: "unavailable" };
  }

  try {
    const meetings = await cosmos.queryMeetings({
      projectName,
      beforeMeetingId: meetingId,
      limit: HISTORY_LIMIT,
    });
    const prior = meetings.filter((m) => m.consolidated);

    // Clear any stale files so the folder matches what the prompt lists
    const historyDir = path.join(meetingPath, "history");
    await fs.rm(historyDir, { recursive: true, force: true });

    if (prior.length === 0) return { status: "none" };

    await fs.mkdir(historyDir, { recursive: true });
    for (const m of prior) {
      const record = { meetingId: m.meetingId, meetingDate: m.meetingDate, consolidated: m.consolidated };
      await fs.writeFile(
        path.join(historyDir, `${path.basename(m.meetingId)}.json`),
        JSON.stringify(record, null, 2),
        "utf-8",
      );
    }

    const meetingIds = prior.map((m) => m.meetingId);
    log("info", "Wrote meeting history for trend analysis", { count: meetingIds.length });
    return { status: "loaded", meetingIds };
  } catch (err) {
    log("warn", "Failed to fetch meeting history (non-fatal)", { error: err.message });
    return { status: "unavailable" };
  }
}

module.exports = { writeMeetingHistory };
