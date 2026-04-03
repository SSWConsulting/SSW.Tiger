/**
 * Structured JSON logger for Tiger pipeline.
 *
 * All logs go to stderr to keep stdout clean for machine output.
 */

function log(level, message, data = null) {
  const logEntry = {
    level: level.toLowerCase(),
    message,
    ...(data && { ...data }),
  };
  console.error(JSON.stringify(logEntry));
}

function truncate(text, maxLength = 120) {
  if (!text) return "";
  return text.length > maxLength
    ? `${text.substring(0, maxLength)}...`
    : text;
}

module.exports = { log, truncate };
