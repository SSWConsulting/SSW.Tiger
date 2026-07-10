const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { getProjectSettings, upsertProjectSettings } = require("./cosmosClient");

describe("getProjectSettings (default-safe)", () => {
  let savedEndpoint;
  before(() => {
    savedEndpoint = process.env.COSMOS_ENDPOINT;
    delete process.env.COSMOS_ENDPOINT;
  });
  after(() => {
    if (savedEndpoint !== undefined) process.env.COSMOS_ENDPOINT = savedEndpoint;
  });

  it("returns the safe default when COSMOS_ENDPOINT is not set", async () => {
    const settings = await getProjectSettings("crm");
    assert.deepEqual(settings, { obfuscateUrls: false });
  });

  it("never throws and defaults to human-readable for any project", async () => {
    const settings = await getProjectSettings("some-unknown-project");
    assert.equal(settings.obfuscateUrls, false);
  });

  it("returns an independent object each call (no shared mutable default)", async () => {
    const a = await getProjectSettings("crm");
    a.obfuscateUrls = true;
    const b = await getProjectSettings("crm");
    assert.equal(b.obfuscateUrls, false);
  });
});

describe("upsertProjectSettings (validation)", () => {
  it("throws when projectName is missing (before any Cosmos call)", async () => {
    await assert.rejects(
      () => upsertProjectSettings({ obfuscateUrls: true }),
      /projectName is required/,
    );
  });
});
