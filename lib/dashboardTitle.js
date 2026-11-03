/**
 * Dashboard <title> - built in code so the browser tab, link previews and
 * Teams unfurls always show the real weekday and a consistent format:
 *
 *   "SSW Tiger - TV - Meeting Dashboard (Fri 09/10/2026)"
 *
 * The model has been seen to get weekdays wrong (e.g. "SUN 25/05/2026" for a
 * Monday), so the processor rewrites the title after generation.
 */

const { escapeHtml } = require("./sanitize");

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// "SSW" followed by at least one separator: space, ".", "_", "-", en/em dash or ":".
const SSW_PREFIX = /^ssw[\s._:\-–—]+/i;

/**
 * Strip the "SSW" prefix in any of its forms ("SSW TV", "SSW.YakShaver",
 * "ssw-crm", "SSW - TV") so the title does not repeat it after "SSW Tiger - ".
 * Names that are just "SSW", or only start with the letters ("SSWeb"), stay as is.
 */
function shortProjectName(name) {
  const trimmed = String(name ?? "").trim();
  if (!SSW_PREFIX.test(trimmed)) return trimmed;
  const rest = trimmed.replace(SSW_PREFIX, "").trim();
  return rest || trimmed;
}

/**
 * Parse an ISO date (YYYY-MM-DD, extra suffix ignored) into its parts.
 * Returns null for anything that is not a real calendar date.
 */
function parseIsoDate(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDate ?? ""));
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  // UTC keeps the weekday independent of the server's timezone
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year: match[1], month: match[2], day: match[3], weekday: WEEKDAYS[date.getUTCDay()] };
}

/**
 * Build the dashboard title from a project name and ISO meeting date.
 * Without a valid date the date suffix is left out.
 */
function formatDashboardTitle(projectName, isoDate) {
  const name = shortProjectName(projectName) || "Meeting";
  const date = parseIsoDate(isoDate);
  const suffix = date ? ` (${date.weekday} ${date.day}/${date.month}/${date.year})` : "";
  return `SSW Tiger - ${name} - Meeting Dashboard${suffix}`;
}

function decodeHtml(text) {
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

const HEADER_PROJECT_NAME = /<h1\b[^>]*>\s*<span class="font-extrabold">([\s\S]*?)<\/span>\s*<\/h1>/;

/**
 * The project name the dashboard header shows ({{PROJECT_NAME}} in the
 * template). For "general" meetings the model picks a better name from the
 * meeting itself, so the title follows the header, not the slug.
 */
function extractHeaderProjectName(html) {
  const match = HEADER_PROJECT_NAME.exec(html);
  if (!match) return "";
  const name = decodeHtml(match[1].replace(/<[^>]*>/g, "")).trim();
  return name.includes("{{") ? "" : name;
}

const HEAD_TITLE = /(<head\b[\s\S]*?<title>)[\s\S]*?(<\/title>)/;

/**
 * Replace the document <title> in <head> (not the <title> inside inline SVGs).
 * Returns the html unchanged when there is no head title.
 */
function applyDashboardTitle(html, { fallbackProjectName, meetingDate }) {
  const projectName = extractHeaderProjectName(html) || fallbackProjectName;
  const title = formatDashboardTitle(projectName, meetingDate);
  return html.replace(HEAD_TITLE, (_, open, close) => `${open}${escapeHtml(title)}${close}`);
}

module.exports = {
  shortProjectName,
  parseIsoDate,
  formatDashboardTitle,
  extractHeaderProjectName,
  applyDashboardTitle,
};
