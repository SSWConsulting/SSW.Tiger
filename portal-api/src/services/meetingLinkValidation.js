const { SubmissionValidationError } = require("./submissionValidation");

// Numeric Teams Meeting ID (as shown in the invite / short link), spaces stripped.
const MEETING_ID_RE = /^\d{9,20}$/;

// Classify a Teams meeting reference in any form a user can paste — NO Graph call.
// The Container App Job does the actual resolution.
//
//   - Long "meetup-join" link (carries context.Oid):
//       { mode: "organizer", joinUrl, organizerId, tenantId }
//   - Short "/meet/<code>" link, or a bare numeric Meeting ID:
//       { mode: "joinMeetingId", joinMeetingId }
//
// Short links / Meeting IDs carry no organizer, so the Job resolves them by
// joinMeetingId under the submitter (or a supplied attendee) — see SubmitMeetingLink.
function validateMeetingLink(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw new SubmissionValidationError("A meeting link or Meeting ID is required.", 400, "link_required");
  }
  if (raw.length > 4096) {
    throw new SubmissionValidationError("The meeting link is too long.", 400, "link_too_long");
  }

  // A bare numeric Meeting ID (e.g. "477 696 498 774 90" from the invite).
  const bareDigits = raw.replace(/\s+/g, "");
  if (MEETING_ID_RE.test(bareDigits)) {
    return { mode: "joinMeetingId", joinMeetingId: bareDigits };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new SubmissionValidationError("That is not a valid Teams meeting link or Meeting ID.", 400, "invalid_link");
  }
  if (!url.hostname.includes("teams.microsoft.com") && !url.hostname.includes("teams.live.com")) {
    throw new SubmissionValidationError("That is not a Teams meeting link.", 400, "not_teams_link");
  }

  // Short link: https://teams.microsoft.com/meet/<code>?p=...  (the code IS the joinMeetingId)
  const meetMatch = url.pathname.match(/\/meet\/([^/?#]+)/i);
  if (meetMatch) {
    const code = decodeURIComponent(meetMatch[1]).replace(/\s+/g, "");
    if (!MEETING_ID_RE.test(code)) {
      throw new SubmissionValidationError("The meeting link's Meeting ID could not be read.", 400, "invalid_link");
    }
    return { mode: "joinMeetingId", joinMeetingId: code };
  }

  // Long link: resolve by the organizer embedded in context.Oid.
  const contextParam = url.searchParams.get("context");
  if (!contextParam) {
    throw new SubmissionValidationError(
      "The meeting link is missing meeting info — paste the full join link, the short teams.microsoft.com/meet link, or the numeric Meeting ID.",
      400,
      "link_missing_context",
    );
  }
  let context;
  try {
    context = JSON.parse(contextParam);
  } catch {
    throw new SubmissionValidationError("The meeting link could not be parsed.", 400, "invalid_link");
  }
  if (!context.Oid) {
    throw new SubmissionValidationError("The meeting link does not identify the organizer.", 400, "link_missing_organizer");
  }
  return { mode: "organizer", joinUrl: raw, organizerId: context.Oid, tenantId: context.Tid || null };
}

// Validate the OPTIONAL attendee email used to resolve a Meeting-ID submission when
// the submitter did not attend. Returns a lowercased email, or null if none given.
function validateAttendeeEmail(value) {
  if (value === undefined || value === null || value === "") return null;
  const email = String(value).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new SubmissionValidationError("Enter a valid attendee email address.", 400, "invalid_attendee_email");
  }
  return email;
}

module.exports = { validateMeetingLink, validateAttendeeEmail };
