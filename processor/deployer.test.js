const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { DASHBOARD_HTML_CACHE_CONTROL } = require("../lib/dashboardBlob");
const { buildDashboardUploadArgs } = require("./deployer");

describe("dashboard deployment upload arguments", () => {
  it("sets the shared cache policy on batch uploads", () => {
    const args = buildDashboardUploadArgs({
      dashboardDir: "C:\\temp\\dashboard",
      blobDestination: "$web/crm/2026-07-16-120000",
      storageAccount: "satigerstagingweb",
    });

    const cacheControlIndex = args.indexOf("--content-cache-control");
    assert.notEqual(cacheControlIndex, -1);
    assert.equal(args[cacheControlIndex + 1], DASHBOARD_HTML_CACHE_CONTROL);
  });
});
