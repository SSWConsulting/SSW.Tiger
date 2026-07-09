const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { buildMeetingPasswordSecretName } = require("./keyVaultPasswords");

describe("Key Vault dashboard password secret names", () => {
  it("keeps names within Key Vault length limits", () => {
    const name = buildMeetingPasswordSecretName(
      "project-" + "a".repeat(160),
      "2026-07-09-" + "b".repeat(160),
    );

    assert.ok(name.length <= 127);
    assert.match(name, /^tiger-[a-z0-9-]+-[a-f0-9]{12}-password$/);
  });

  it("uses a hash suffix so truncated names do not collide", () => {
    const project = "project-" + "a".repeat(120);
    const meetingA = "meeting-" + "b".repeat(120) + "1";
    const meetingB = "meeting-" + "b".repeat(120) + "2";

    assert.notEqual(
      buildMeetingPasswordSecretName(project, meetingA),
      buildMeetingPasswordSecretName(project, meetingB),
    );
  });
});
