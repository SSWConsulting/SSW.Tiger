const { sanitizeId } = require("../lib/sanitize");

// Derive a project + title from a meeting subject. Shared by the webhook path
// (downloadTranscript) and the portal meeting-link path (downloadFromMeetingLink)
// so an unnamed portal submission files under the same project the webhook would
// have used, instead of a one-off synthetic slug.
//
// Supported prefixes (else the project is "general"):
//   [ProjectName] Title   |   ProjectName - Title   |   ProjectName: Title
function parseSubject(subject) {
  if (!subject) return { displayName: "general", projectSlug: "general", title: "meeting" };

  let displayName = null;
  let title = subject;

  // Format 1: [ProjectName] Meeting Title
  const bracketMatch = subject.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (bracketMatch) {
    displayName = bracketMatch[1].trim();
    title = bracketMatch[2].trim() || "meeting";
  }

  // Format 2: ProjectName - Meeting Title (dash separator)
  // Support both hyphen (-), en dash (–), and em dash (—)
  if (!displayName) {
    const dashMatch = subject.match(/^([^-–—]+)\s*[-–—]\s*(.+)$/);
    if (dashMatch) {
      const projectPart = dashMatch[1].trim();
      if (projectPart.length <= 30 && !projectPart.includes(" and ")) {
        displayName = projectPart;
        title = dashMatch[2].trim();
      }
    }
  }

  // Format 3: ProjectName: Meeting Title (colon separator)
  if (!displayName) {
    const colonMatch = subject.match(/^([^:]+)\s*:\s*(.+)$/);
    if (colonMatch) {
      const projectPart = colonMatch[1].trim();
      if (projectPart.length <= 30 && !projectPart.includes(" and ")) {
        displayName = projectPart;
        title = colonMatch[2].trim();
      }
    }
  }

  const resolvedName = displayName || "general";
  return {
    displayName: resolvedName,
    projectSlug: sanitizeId(resolvedName) || "general",
    title,
  };
}

function extractProjectName(subject) {
  return parseSubject(subject).projectSlug;
}

module.exports = { parseSubject, extractProjectName };
