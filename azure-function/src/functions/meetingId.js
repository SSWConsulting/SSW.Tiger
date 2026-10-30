/**
 * Helpers for resolving a Teams join URL to Graph IDs without the
 * `$filter=JoinWebUrl` lookup, which Graph answers with 404 ("3004: Meeting
 * properties are not found") once the organizer's account is disabled. The
 * meeting itself and its transcripts are still served by ID.
 */

// Transcription restarted mid-meeting produces several transcripts per
// occurrence; anything this close to the newest belongs to the same meeting.
const OCCURRENCE_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Graph online meeting ID for a join URL:
 * base64("1*{organizerId}*{messageId}**{threadId}"), where the join URL path is
 * /l/meetup-join/{threadId}/{messageId}. messageId is "0" for regular
 * meetings and the channel post ID for channel meetings.
 */
function meetingIdFromJoinUrl(joinUrl, organizerId) {
  const match = new URL(joinUrl).pathname.match(/\/l\/meetup-join\/([^/]+)\/([^/]+)/);
  if (!match) return null;

  const threadId = decodeURIComponent(match[1]);
  const messageId = decodeURIComponent(match[2]);
  return Buffer.from(`1*${organizerId}*${messageId}**${threadId}`).toString("base64");
}

/**
 * The transcripts belonging to the latest occurrence of a (possibly recurring)
 * meeting, oldest first.
 */
function latestOccurrenceTranscripts(transcripts) {
  if (transcripts.length === 0) return [];

  const sorted = [...transcripts].sort(
    (a, b) => new Date(a.createdDateTime) - new Date(b.createdDateTime),
  );
  const newest = new Date(sorted[sorted.length - 1].createdDateTime).getTime();
  return sorted.filter(
    (t) => newest - new Date(t.createdDateTime).getTime() <= OCCURRENCE_WINDOW_MS,
  );
}

module.exports = { meetingIdFromJoinUrl, latestOccurrenceTranscripts };
