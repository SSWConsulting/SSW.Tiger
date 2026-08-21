// Shared HTTP-response helper for the Portal API functions.
function json(status, body) {
  return {
    status,
    jsonBody: body,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  };
}

module.exports = { json };
