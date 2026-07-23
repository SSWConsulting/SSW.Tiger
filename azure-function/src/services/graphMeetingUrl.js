/**
 * Build the Graph `onlineMeetings?$filter=JoinWebUrl eq '...'` URL.
 *
 * Two layers of escaping are required:
 *   1. OData — a single quote inside a string literal is doubled.
 *   2. URL   — the whole $filter expression is a query VALUE, so it must be
 *      encodeURIComponent'd. A join URL carries its own "?"/"&"/"%", which would
 *      otherwise break query parsing: the "?" leaks a second query separator, an
 *      "&" truncates the filter mid-literal, and Graph decodes %3a -> ":" while it
 *      stores the encoded form, so an un-encoded filter never matches.
 *
 * ⚠️ DUPLICATED — azure-function and processor are separate deploy units (only the
 * container image gets lib/), so this cannot be a shared module today. An identical
 * copy lives in processor/downloadFromMeetingLink.js#buildMeetingFilterUrl. Change
 * one, change both; each side has its own regression test on the encoded URL shape.
 */
function buildMeetingFilterUrl(userId, joinUrl) {
  const filter = `JoinWebUrl eq '${joinUrl.replace(/'/g, "''")}'`;
  return (
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}` +
    `/onlineMeetings?$filter=${encodeURIComponent(filter)}`
  );
}

module.exports = { buildMeetingFilterUrl };
