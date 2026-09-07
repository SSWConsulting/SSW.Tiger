const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { buildJobEnv } = require("./jobEnv");

const BICEP = path.join(__dirname, "../../../infra/modules/containerApp.bicep");

// Declared on the job but deliberately not forwarded: nothing in processor/ or
// lib/ reads it, so passing it through would only widen the container's secrets.
const NOT_FORWARDED = new Set(["STORAGE_CONNECTION_STRING"]);

function jobEnvNamesFromBicep() {
  const bicep = fs.readFileSync(BICEP, "utf8");
  // Whole file, not just the template block: vars like transcriptHubEnv are
  // declared above it and concat'd into env, and those are the ones that go missing
  const names = [...bicep.matchAll(/\{\s*name:\s*'([A-Z0-9_]+)'/g)].map((m) => m[1]);
  // A parse that silently finds nothing would make every assertion below vacuous
  assert.ok(names.length > 10, `Parsed only ${names.length} env names from ${BICEP}`);
  return names;
}

describe("buildJobEnv", () => {
  const args = {
    userId: "user-1",
    meetingId: "meeting-1",
    transcriptId: "transcript-1",
    executionId: "exec-1",
    cancelUrl: "https://example.test/cancel",
    checkCancellationUrl: "https://example.test/check",
    restartUrl: "https://example.test/restart",
    skipSubjectFilter: false,
  };

  it("forwards the transcript hub settings, private key by secretRef", () => {
    const env = buildJobEnv({
      ...args,
      env: {
        TRANSCRIPT_HUB_REPO: "SSWConsulting/SSW.Tiger-Transcripts",
        TRANSCRIPT_HUB_APP_ID: "4645246",
        TRANSCRIPT_HUB_APP_INSTALLATION_ID: "154848166",
      },
    });
    const byName = Object.fromEntries(env.map((e) => [e.name, e]));

    assert.equal(byName.TRANSCRIPT_HUB_REPO.value, "SSWConsulting/SSW.Tiger-Transcripts");
    assert.equal(byName.TRANSCRIPT_HUB_APP_ID.value, "4645246");
    assert.equal(byName.TRANSCRIPT_HUB_APP_INSTALLATION_ID.value, "154848166");
    assert.equal(byName.TRANSCRIPT_HUB_APP_PRIVATE_KEY.secretRef, "transcript-hub-app-private-key");
  });

  it("omits the hub block entirely when no repo is configured", () => {
    const names = buildJobEnv({ ...args, env: {} }).map((e) => e.name);

    // A lone secretRef would point at a secret the job never declares
    assert.deepEqual(names.filter((n) => n.startsWith("TRANSCRIPT_HUB")), []);
  });

  it("re-declares every env var the job template sets", () => {
    const built = new Set(
      buildJobEnv({ ...args, env: { TRANSCRIPT_HUB_REPO: "o/r" } }).map((e) => e.name),
    );
    const missing = jobEnvNamesFromBicep().filter(
      (name) => !built.has(name) && !NOT_FORWARDED.has(name),
    );
    assert.deepEqual(
      missing,
      [],
      `Set on the job but dropped by the override, so unset at runtime: ${missing.join(", ")}`,
    );
  });

  it("omits the subject filter override unless asked for", () => {
    const off = buildJobEnv({ ...args, env: {} }).map((e) => e.name);
    const on = buildJobEnv({ ...args, skipSubjectFilter: true, env: {} }).map((e) => e.name);

    assert.ok(!off.includes("SKIP_SUBJECT_FILTER"));
    assert.ok(on.includes("SKIP_SUBJECT_FILTER"));
  });
});
