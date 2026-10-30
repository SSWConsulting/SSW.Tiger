/**
 * Pure decision logic for the daily organizer check (CheckMeetingOrganizers).
 *
 * Graph never sends a transcript notification for a meeting whose organizer is
 * disabled, so once someone leaves, their recurring meetings silently stop
 * being processed. These helpers decide which series to warn about and what
 * the warning says. Kept free of Azure SDKs so they can be unit tested.
 */

const DEFAULT_SUBJECT = "Untitled Meeting";
const DEFAULT_ORGANIZER_NAME = "the original organiser";

/**
 * Collapse meeting records to the latest occurrence of each Teams meeting
 * series, dropping series that were already alerted (on any occurrence) and
 * records with no Teams meeting (local runs).
 */
function latestUnalertedSeries(meetings) {
  const bySeries = new Map();

  for (const meeting of meetings) {
    const seriesId = meeting.teamsMeeting?.onlineMeetingId;
    if (!seriesId || !meeting.teamsMeeting.organizerUserId) continue;

    const entry = bySeries.get(seriesId) || { latest: null, alerted: false };
    if (meeting.organizerAlertSentAt) entry.alerted = true;
    if (!entry.latest || meeting.meetingDate > entry.latest.meetingDate) {
      entry.latest = meeting;
    }
    bySeries.set(seriesId, entry);
  }

  return [...bySeries.values()]
    .filter((entry) => !entry.alerted)
    .map((entry) => entry.latest);
}

/**
 * Whether a Graph user lookup means the organizer has left: disabled (200 with
 * accountEnabled false) or deleted (404). Any other failure is treated as
 * "unknown" so a Graph blip never sends a false alarm.
 */
function isOrganizerGone({ status, accountEnabled }) {
  if (status === 404) return true;
  return status === 200 && accountEnabled === false;
}

/**
 * Logic App payload for the "organizer-disabled" Teams card. Sent to the
 * series' participants, minus the departed organizer.
 */
function buildOrganizerAlert({ series, organizerName, docsUrl }) {
  const { organizerUserId, subject, participantUserIds = [] } = series.teamsMeeting;

  return {
    notificationType: "organizer-disabled",
    projectName: series.projectName,
    meetingSubject: subject || DEFAULT_SUBJECT,
    organizerName: organizerName || DEFAULT_ORGANIZER_NAME,
    docsUrl,
    participants: participantUserIds
      .filter((userId) => userId !== organizerUserId)
      .map((userId) => ({ userId })),
  };
}

module.exports = {
  latestUnalertedSeries,
  isOrganizerGone,
  buildOrganizerAlert,
};
