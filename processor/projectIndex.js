/**
 * Project Index Page Generation
 *
 * Renders a per-project index.html listing all of that project's meeting
 * dashboards. Deployed to the project root in blob storage so that
 * https://{host}/{project}/ shows a landing page instead of a 404.
 *
 * Meeting data comes from Cosmos DB (queryMeetings), merged with the
 * meeting that was just deployed in case persistence was skipped or lagging.
 */

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * Format an ISO date (YYYY-MM-DD) as Australian format (DD/MM/YYYY).
 */
function formatDate(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate || "");
  if (!match) return isoDate || "";
  return `${match[3]}/${match[2]}/${match[1]}`;
}

/**
 * Derive a human-readable label from the part of the meeting ID after the
 * date, e.g. "2026-01-22-094557" -> "09:45", "2026-01-22-sprint-review" ->
 * "Sprint Review". Returns "" when the ID is just the date.
 */
function meetingLabel(meetingId, meetingDate) {
  const id = String(meetingId || "");
  const date = String(meetingDate || "").substring(0, 10);
  let suffix = id.startsWith(date) ? id.substring(date.length) : "";
  suffix = suffix.replace(/^-/, "");
  if (!suffix) return "";

  const timeMatch = /^(\d{2})(\d{2})(\d{2})?$/.exec(suffix);
  if (timeMatch) return `${timeMatch[1]}:${timeMatch[2]}`;

  return suffix
    .split("-")
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/**
 * Build the metadata chips for a meeting card from the Cosmos metadata
 * summary (duration, participants, action items). Missing values are
 * simply omitted.
 */
function buildChips(metadata = {}) {
  const chips = [];
  if (metadata.totalDurationMinutes != null) {
    chips.push(`${Math.round(metadata.totalDurationMinutes)} min`);
  }
  if (metadata.participantCount != null) {
    chips.push(`${metadata.participantCount} people`);
  }
  if (metadata.actionItemsCount != null) {
    chips.push(`${metadata.actionItemsCount} action items`);
  }
  return chips;
}

/**
 * Sort meetings newest-first and de-duplicate by meetingId.
 */
function normalizeMeetings(meetings) {
  const byId = new Map();
  for (const meeting of meetings) {
    if (!meeting || !meeting.meetingId) continue;
    if (!byId.has(meeting.meetingId)) byId.set(meeting.meetingId, meeting);
  }
  return [...byId.values()].sort((a, b) => {
    const dateCompare = String(b.meetingDate || "").localeCompare(String(a.meetingDate || ""));
    if (dateCompare !== 0) return dateCompare;
    return String(b.meetingId).localeCompare(String(a.meetingId));
  });
}

/**
 * Merge the just-deployed meeting into the list queried from Cosmos,
 * so the index always includes it even if persistence failed.
 */
function mergeCurrentMeeting(meetings, currentMeeting) {
  const list = Array.isArray(meetings) ? [...meetings] : [];
  if (
    currentMeeting?.meetingId &&
    !list.some((m) => m?.meetingId === currentMeeting.meetingId)
  ) {
    list.push(currentMeeting);
  }
  return list;
}

function renderMeetingCard(meeting) {
  const date = formatDate(meeting.meetingDate);
  const label = meetingLabel(meeting.meetingId, meeting.meetingDate);
  const chips = buildChips(meeting.metadata)
    .map(
      (chip) =>
        `<span class="bg-ssw-gray-100 text-ssw-gray-700 px-2 py-1 rounded text-sm font-medium">${escapeHtml(chip)}</span>`,
    )
    .join("\n                        ");

  return `            <a href="./${encodeURIComponent(meeting.meetingId)}/" class="block bg-white rounded-lg shadow-raised ssw-card p-6">
                <div class="flex items-center justify-between gap-4">
                    <div>
                        <h2 class="text-xl text-ssw-charcoal">${escapeHtml(date)}${label ? ` <span class="font-medium text-ssw-gray-500">• ${escapeHtml(label)}</span>` : ""}</h2>
                        <p class="text-sm text-ssw-gray-400 mt-1">${escapeHtml(meeting.meetingId)}</p>
                    </div>
                    <div class="flex items-center gap-2 flex-wrap justify-end">
                        ${chips}
                        <span class="text-ssw-red font-bold text-xl ml-2">&rsaquo;</span>
                    </div>
                </div>
            </a>`;
}

/**
 * Render the project index HTML from the template.
 *
 * @param {Object} params
 * @param {string} params.template     - contents of templates/project-index.html
 * @param {string} params.displayName  - human-readable project name
 * @param {Object[]} params.meetings   - meeting records ({meetingId, meetingDate, metadata})
 * @param {string} [params.generatedAt] - ISO timestamp for the footer
 * @returns {string} rendered HTML
 */
function renderProjectIndex({ template, displayName, meetings, generatedAt }) {
  const sorted = normalizeMeetings(meetings || []);

  const meetingList = sorted.length
    ? sorted.map(renderMeetingCard).join("\n")
    : `            <div class="bg-white rounded-lg shadow-raised ssw-card p-6 text-center text-ssw-gray-500">No meetings yet</div>`;

  return template
    .replace(/\{\{PROJECT_NAME\}\}/g, escapeHtml(displayName))
    .replace(/\{\{MEETING_COUNT\}\}/g, String(sorted.length))
    .replace(/\{\{MEETING_LIST\}\}/g, meetingList)
    .replace(/\{\{GENERATED_AT\}\}/g, escapeHtml(formatDate(generatedAt || "")));
}

module.exports = {
  formatDate,
  meetingLabel,
  buildChips,
  normalizeMeetings,
  mergeCurrentMeeting,
  renderProjectIndex,
};
