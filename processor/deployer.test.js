const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { DASHBOARD_HTML_CACHE_CONTROL } = require("../lib/dashboardBlob");
const { buildDashboardUploadArgs } = require("./deployer");

describe("dashboard deployment upload arguments", () => {
  it("stores the project display name on reports without a project index", () => {
    const args = buildDashboardUploadArgs({ dashboardDir: '/tmp/dashboard', blobDestination: 'reports/yak/meeting', storageAccount: 'satiger', displayName: 'YakShaver \u56e2\u961f' });
    assert.equal(args[args.indexOf('--metadata') + 1], `displayname=${encodeURIComponent('YakShaver \u56e2\u961f')}`);
  });
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

it('private Portal deployments skip static project and root indexes', async () => {
  const saved = { container: process.env.DASHBOARD_CONTAINER, base: process.env.DASHBOARD_BASE_URL };
  process.env.DASHBOARD_CONTAINER = 'reports';
  process.env.DASHBOARD_BASE_URL = 'https://portal.test';
  try {
    const { deployProjectIndex } = require('./deployer');
    const { deployPortalIndex } = require('./portalIndex');
    assert.equal(await deployProjectIndex({ projectName: 'Yak Team' }), 'https://portal.test/Yak%20Team/');
    assert.equal(await deployPortalIndex({ container: new Proxy({}, { get() { throw new Error('Static storage must not be accessed'); } }) }), 'https://portal.test/');
  } finally {
    for (const [key, value] of [['DASHBOARD_CONTAINER', saved.container], ['DASHBOARD_BASE_URL', saved.base]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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
