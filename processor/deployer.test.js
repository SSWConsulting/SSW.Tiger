const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { chooseSlug, resolveDeploySlug, deployProjectIndex, UUID_RE } = require("./deployer");

describe("chooseSlug", () => {
  it("uses the human-readable meetingId when not obfuscated", () => {
    const result = chooseSlug({ obfuscateUrls: false, meetingId: "2026-04-03" });
    assert.deepEqual(result, { slug: "2026-04-03", obfuscated: false });
  });

  it("generates a fresh GUID when obfuscated with no prior path", () => {
    const result = chooseSlug({ obfuscateUrls: true, meetingId: "2026-04-03" });
    assert.equal(result.obfuscated, true);
    assert.ok(UUID_RE.test(result.slug), `expected a UUID, got ${result.slug}`);
    assert.notEqual(result.slug, "2026-04-03");
  });

  it("reuses the prior GUID from an existing dashboardPath (stable URL)", () => {
    const guid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const result = chooseSlug({
      obfuscateUrls: true,
      meetingId: "2026-04-03",
      priorDashboardPath: `crm/${guid}`,
    });
    assert.deepEqual(result, { slug: guid, obfuscated: true });
  });

  it("generates a new GUID when the prior path is a human-readable (non-GUID) slug", () => {
    const result = chooseSlug({
      obfuscateUrls: true,
      meetingId: "2026-04-03",
      priorDashboardPath: "crm/2026-04-03",
    });
    assert.equal(result.obfuscated, true);
    assert.ok(UUID_RE.test(result.slug));
    assert.notEqual(result.slug, "2026-04-03");
  });
});

describe("UUID_RE", () => {
  it("matches a generated UUID", () => {
    assert.ok(UUID_RE.test(require("crypto").randomUUID()));
  });

  it("rejects a date-style meetingId", () => {
    assert.equal(UUID_RE.test("2026-04-03"), false);
    assert.equal(UUID_RE.test("2026-04-03-094557"), false);
  });
});

describe("resolveDeploySlug (no Cosmos configured)", () => {
  let savedEndpoint;
  before(() => {
    savedEndpoint = process.env.COSMOS_ENDPOINT;
    delete process.env.COSMOS_ENDPOINT;
  });
  after(() => {
    if (savedEndpoint !== undefined) process.env.COSMOS_ENDPOINT = savedEndpoint;
  });

  it("defaults to the human-readable meetingId when settings are unavailable", async () => {
    const result = await resolveDeploySlug({ projectName: "crm", meetingId: "2026-04-03" });
    assert.deepEqual(result, { slug: "2026-04-03", obfuscated: false });
  });
});

describe("resolveDeploySlug (Cosmos-backed, injected deps)", () => {
  const guid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  let savedEndpoint;
  before(() => {
    savedEndpoint = process.env.COSMOS_ENDPOINT;
    process.env.COSMOS_ENDPOINT = "https://cosmos.example/"; // gate the prior-GUID lookup
  });
  after(() => {
    if (savedEndpoint === undefined) delete process.env.COSMOS_ENDPOINT;
    else process.env.COSMOS_ENDPOINT = savedEndpoint;
  });

  it("reuses the prior GUID from Cosmos so the URL is stable across re-processing", async () => {
    const deps = {
      getProjectSettings: async () => ({ obfuscateUrls: true }),
      getMeeting: async () => ({ dashboardPath: `crm/${guid}` }),
    };
    const result = await resolveDeploySlug({ projectName: "crm", meetingId: "2026-04-03" }, deps);
    assert.deepEqual(result, { slug: guid, obfuscated: true });
  });

  it("mints a fresh GUID when the meeting has no prior obfuscated path", async () => {
    const deps = {
      getProjectSettings: async () => ({ obfuscateUrls: true }),
      getMeeting: async () => null,
    };
    const result = await resolveDeploySlug({ projectName: "crm", meetingId: "2026-04-03" }, deps);
    assert.equal(result.obfuscated, true);
    assert.ok(UUID_RE.test(result.slug));
  });

  it("falls back to a fresh GUID (does not abort) when the prior-meeting lookup fails", async () => {
    const deps = {
      getProjectSettings: async () => ({ obfuscateUrls: true }),
      getMeeting: async () => {
        throw new Error("transient getMeeting failure");
      },
    };
    const result = await resolveDeploySlug({ projectName: "crm", meetingId: "2026-04-03" }, deps);
    assert.equal(result.obfuscated, true);
    assert.ok(UUID_RE.test(result.slug));
  });

  it("aborts (rejects) when the settings read fails closed - never silently downgrades", async () => {
    const deps = {
      getProjectSettings: async () => {
        const err = new Error("Cosmos unavailable");
        err.code = 503;
        throw err;
      },
      getMeeting: async () => null,
    };
    await assert.rejects(
      () => resolveDeploySlug({ projectName: "crm", meetingId: "2026-04-03" }, deps),
      /Cosmos unavailable/,
    );
  });
});

describe("deployProjectIndex suppression", () => {
  let savedAccount;
  before(() => {
    savedAccount = process.env.DASHBOARD_STORAGE_ACCOUNT;
    process.env.DASHBOARD_STORAGE_ACCOUNT = "dummyaccount";
  });
  after(() => {
    if (savedAccount === undefined) delete process.env.DASHBOARD_STORAGE_ACCOUNT;
    else process.env.DASHBOARD_STORAGE_ACCOUNT = savedAccount;
  });

  it("returns null and uploads nothing when obfuscate is true", async () => {
    const result = await deployProjectIndex({
      projectName: "crm",
      displayName: "CRM",
      currentMeeting: { meetingId: "2026-04-03", meetingDate: "2026-04-03" },
      obfuscate: true,
    });
    assert.equal(result, null);
  });
});
