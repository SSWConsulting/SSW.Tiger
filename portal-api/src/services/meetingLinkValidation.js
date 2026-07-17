const { SubmissionValidationError } = require("./submissionValidation");

// Validate a Teams meeting join URL and extract the organizer (Oid) + tenant
// (Tid) from its `context` param — no Graph call. The Container App Job does the
// actual Graph resolution; here we only reject links we already know can't work.
function validateMeetingLink(value) {
  const joinUrl = String(value || "").trim();
  if (!joinUrl) {
    throw new SubmissionValidationError("A meeting link is required.", 400, "link_required");
  }
  if (joinUrl.length > 4096) {
    throw new SubmissionValidationError("The meeting link is too long.", 400, "link_too_long");
  }

  let url;
  try {
    url = new URL(joinUrl);
  } catch {
    throw new SubmissionValidationError("The meeting link is not a valid URL.", 400, "invalid_link");
  }
  if (!url.hostname.includes("teams.microsoft.com") && !url.hostname.includes("teams.live.com")) {
    throw new SubmissionValidationError("That is not a Teams meeting link.", 400, "not_teams_link");
  }

  const contextParam = url.searchParams.get("context");
  if (!contextParam) {
    throw new SubmissionValidationError(
      "The meeting link is missing meeting info — copy the full link from Teams (a Safe Links / shortened URL won't work).",
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
    throw new SubmissionValidationError(
      "The meeting link does not identify the organizer.",
      400,
      "link_missing_organizer",
    );
  }

  return { joinUrl, organizerId: context.Oid, tenantId: context.Tid || null };
}

module.exports = { validateMeetingLink };
