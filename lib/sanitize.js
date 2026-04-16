/**
 * Sanitize a string for use in Cosmos DB document IDs and URL paths.
 * Strips emojis, special characters, and anything not alphanumeric, hyphen, or dot.
 * Cosmos DB IDs cannot contain: \, /, #, ?, or characters with code > 255.
 */
function sanitizeId(value) {
  return value
    .toLowerCase()
    .replace(/[\s/\\]+/g, "-")    // spaces, slashes to hyphens
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

module.exports = { sanitizeId };
