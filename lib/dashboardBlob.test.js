const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  DASHBOARD_HTML_CACHE_CONTROL,
  dashboardHtmlHttpHeaders,
} = require("./dashboardBlob");

describe("dashboard Blob cache headers", () => {
  it("requires revalidation when protected dashboard HTML is replaced", () => {
    assert.deepEqual(dashboardHtmlHttpHeaders(), {
      blobContentType: "text/html; charset=utf-8",
      blobCacheControl: DASHBOARD_HTML_CACHE_CONTROL,
    });
    assert.equal(
      DASHBOARD_HTML_CACHE_CONTROL,
      "no-cache, max-age=0, must-revalidate",
    );
  });
});
