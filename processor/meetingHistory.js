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
const { queryMeetings } = require("../lib/cosmosClient");

// Enough for the agent's "3-meeting trend" plus one, without bloating its context
const HISTORY_LIMIT = 4;

/**
 * Pick the meetings that happened before `meetingId`, newest first.
 * Meeting IDs start with YYYY-MM-DD-HHmmss, so they sort chronologically as
 * strings. Later meetings are excluded so reprocessing an old transcript
 * doesn't "compare" against its own future.
 */
function selectPriorMeetings(meetings, meetingId, limit = HISTORY_LIMIT) {
  return meetings
    .filter((m) => m.consolidated && m.meetingId && m.meetingId < meetingId)
    .sort((a, b) => b.meetingId.localeCompare(a.meetingId))
    .slice(0, limit);
}

/**
 * Write prior meetings' consolidated analysis to `{meetingPath}/history/`.
 * Returns the meeting IDs written (newest first), or [] when there are none.
 */
async function writeMeetingHistory({ projectName, meetingId, meetingDate, meetingPath }) {
  // Over-fetch slightly: the current meeting (on reprocess) and later same-day
  // meetings can land in the window and get filtered out below
  const meetings = await queryMeetings({ projectName, endDate: meetingDate, limit: HISTORY_LIMIT + 3 });
  const prior = selectPriorMeetings(meetings, meetingId);
  if (prior.length === 0) return [];

  const historyDir = path.join(meetingPath, "history");
  await fs.mkdir(historyDir, { recursive: true });

  for (const m of prior) {
    const record = { meetingId: m.meetingId, meetingDate: m.meetingDate, consolidated: m.consolidated };
    await fs.writeFile(
      path.join(historyDir, `${m.meetingId}.json`),
      JSON.stringify(record, null, 2),
      "utf-8",
    );
  }

  return prior.map((m) => m.meetingId);
}

module.exports = { selectPriorMeetings, writeMeetingHistory, HISTORY_LIMIT };
