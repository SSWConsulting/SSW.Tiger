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

describe("deployDashboard", () => {
  it("refuses a public deploy when the dashboard quotes protected meetings", async () => {
    const { deployDashboard } = require("./deployer");
    const saved = { storage: process.env.DASHBOARD_STORAGE_ACCOUNT, cosmos: process.env.COSMOS_ENDPOINT, env: process.env.NODE_ENV };
    // No Cosmos outside production -> the policy check fails open to a public deploy
    process.env.DASHBOARD_STORAGE_ACCOUNT = "satigertest";
    delete process.env.COSMOS_ENDPOINT;
    process.env.NODE_ENV = "development";
    try {
      await assert.rejects(
        deployDashboard({ dashboardPath: "/tmp/x/index.html", projectName: "tina", meetingId: "2026-10-13-130104", requireProtection: true }),
        /Refusing to publish a public dashboard/,
      );
    } finally {
      for (const [key, value] of [["DASHBOARD_STORAGE_ACCOUNT", saved.storage], ["COSMOS_ENDPOINT", saved.cosmos], ["NODE_ENV", saved.env]]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
