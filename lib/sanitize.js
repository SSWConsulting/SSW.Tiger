/**
 * Sanitize a string for use in Cosmos DB document IDs and URL paths.
 * Output contains only [a-z0-9-]. All other characters are converted
 * to hyphens (spaces, dots, slashes) or stripped (emojis, symbols).
 */
function sanitizeId(value) {
  if (value == null) return "";
  return String(value)
    .toLowerCase()
    .replace(/[\s./\\]+/g, "-")   // spaces, dots, slashes to hyphens
    .replace(/[^a-z0-9-]/g, "")   // strip everything else
    .replace(/-{2,}/g, "-")       // collapse consecutive hyphens
    .replace(/^-|-$/g, "");       // trim leading/trailing hyphens
}

module.exports = { sanitizeId };
