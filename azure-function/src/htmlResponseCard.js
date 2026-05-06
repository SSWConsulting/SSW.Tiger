/**
 * Shared HTML response card for SSW Tiger Function endpoints.
 *
 * Endpoints (Cancel, Restart, Trigger) return an HTML status page when a
 * browser hits the URL (typically by clicking a button in a Teams card),
 * and JSON when called programmatically. This module centralises both the
 * card rendering and the request-type negotiation.
 */

const STATUS_STYLES = {
  success: { bg: "#d4edda", text: "#155724", border: "#c3e6cb" },
  conflict: { bg: "#fff3cd", text: "#856404", border: "#ffeaa7" },
  error: { bg: "#f8d7da", text: "#721c24", border: "#f5c6cb" },
};

/**
 * Render the standard SSW Tiger response card.
 *
 * @param {Object} options
 * @param {"success"|"conflict"|"error"} options.status - drives card colours
 * @param {string} [options.icon] - emoji shown above the title (used when no iconImageUrl)
 * @param {string} [options.iconImageUrl] - URL for an image icon; takes precedence over `icon`
 * @param {string} options.title - bold title under the icon
 * @param {string} options.message - body text (rendered inside the coloured panel)
 * @param {string} [options.detailsHtml] - optional pre-escaped HTML below the message
 * @param {string} [options.actionHtml] - optional pre-escaped HTML for an action button
 * @returns {string} full HTML document
 */
function renderCard({
  status,
  icon,
  iconImageUrl,
  title,
  message,
  detailsHtml = "",
  actionHtml = "",
}) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.error;
  // Image takes precedence over emoji. Both render in the same 64×64 slot
  // with the same bottom margin so swapping one for the other doesn't shift
  // the rest of the card.
  const iconHtml = iconImageUrl
    ? `<img src="${iconImageUrl}" alt="" class="icon icon-img">`
    : `<div class="icon">${icon || ""}</div>`;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - SSW Tiger</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: #f5f5f5;
    }
    .card {
      background: white;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.1);
      padding: 40px;
      text-align: center;
      max-width: 400px;
    }
    .icon {
      font-size: 64px;
      line-height: 1;
      margin-bottom: 20px;
    }
    .icon-img {
      display: inline-block;
      width: 64px;
      height: 64px;
      object-fit: contain;
    }
    .title { font-size: 24px; font-weight: 600; margin-bottom: 12px; color: #333; }
    .message {
      padding: 16px;
      border-radius: 8px;
      background: ${s.bg};
      color: ${s.text};
      border: 1px solid ${s.border};
      margin-bottom: 20px;
    }
    .details { font-size: 14px; color: #555; text-align: left; margin-bottom: 16px; }
    .details p { margin: 4px 0; }
    .close-hint { margin-top: 20px; color: #999; font-size: 14px; }
    .action-button {
      display: inline-block;
      margin-top: 8px;
      padding: 12px 24px;
      background: #cc0000;
      color: white;
      text-decoration: none;
      border-radius: 6px;
      font-weight: 600;
      transition: background 0.2s;
    }
    .action-button:hover { background: #a30000; }
  </style>
</head>
<body>
  <div class="card">
    ${iconHtml}
    <div class="title">${title}</div>
    <div class="message">${message}</div>
    ${detailsHtml}
    ${actionHtml}
    <div class="close-hint">You can close this window now.</div>
  </div>
</body>
</html>`;
}

/**
 * Build a Functions HTTP response. Returns JSON for clients that ask for it
 * via Accept header; otherwise renders an HTML card for browser users.
 *
 * @param {Object} request - HttpRequest from @azure/functions
 * @param {number} statusCode
 * @param {Object} options
 * @param {boolean} options.success - drives the JSON body's success/error key
 * @param {string} options.message - shown in both JSON and HTML
 * @param {Object} [options.json] - extra JSON fields merged into the response body
 * @param {Object} options.card - renderCard options (status/icon/title/...) for HTML
 */
function buildResponse(request, statusCode, options) {
  const { success, message, json = {}, card } = options;
  const acceptHeader = request.headers.get("accept") || "";
  const isJsonRequest = acceptHeader.includes("application/json");

  if (isJsonRequest) {
    return {
      status: statusCode,
      jsonBody: success
        ? { success: true, message, ...json }
        : { error: true, message, ...json },
    };
  }

  return {
    status: statusCode,
    headers: { "Content-Type": "text/html" },
    body: renderCard({ ...card, message }),
  };
}

module.exports = { renderCard, buildResponse };
