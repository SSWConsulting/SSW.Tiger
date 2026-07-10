const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  createDashboardSecurityManager,
} = require("./dashboardSecurityManager");
const {
  encryptDashboardHtml,
  decryptDashboardPayload,
  extractEncryptedPayloadFromUnlockPage,
  renderUnlockPage,
} = require("./dashboardEncryption");
const {
  encryptDashboardPassword,
  decryptDashboardPassword,
} = require("./keyVaultPasswords");

const OLD_KEY = Buffer.alloc(32, 4);
const NEW_KEY = Buffer.alloc(32, 9);

function encryptedMeetingRecord(password = "OLDP-ASSW-ORD1") {
  return {
    projectName: "crm",
    meetingId: "2026-07-10-001",
    passwordEnabled: true,
    passwordEncryption: encryptDashboardPassword(password, {
      key: OLD_KEY,
      keySecretName: "tiger-password-encryption-key",
      keyVersion: "old-version",
    }),
  };
}

function protectedDashboardHtml(html, password) {
  return renderUnlockPage({
    projectName: "crm",
    meetingId: "2026-07-10-001",
    encryptedPayload: encryptDashboardHtml(html, password, { iterations: 1000 }),
  });
}

function createManager(overrides = {}) {
  return createDashboardSecurityManager({
    getPasswordEncryptionKey: async ({ secretVersion } = {}) => ({
      key: secretVersion === "old-version" ? OLD_KEY : NEW_KEY,
      keySecretName: "tiger-password-encryption-key",
      keyVersion: secretVersion || "new-version",
    }),
    generateDashboardPassword: () => "NEWP-ASSW-ORD2",
    ...overrides,
  });
}

describe("dashboard security manager", () => {
  it("shows a password using the exact Key Vault version from Cosmos", async () => {
    const seenVersions = [];
    const manager = createManager({
      getMeetingSecurity: async () => encryptedMeetingRecord(),
      getPasswordEncryptionKey: async ({ secretVersion } = {}) => {
        seenVersions.push(secretVersion);
        return {
          key: OLD_KEY,
          keySecretName: "tiger-password-encryption-key",
          keyVersion: secretVersion,
        };
      },
    });

    const result = await manager.showPassword({
      projectName: "crm",
      meetingId: "2026-07-10-001",
    });

    assert.equal(result.password, "OLDP-ASSW-ORD1");
    assert.deepEqual(seenVersions, ["old-version"]);
  });

  it("rejects password envelopes without an exact key version", async () => {
    const record = encryptedMeetingRecord();
    record.passwordEncryption.keyVersion = null;
    const manager = createManager({
      getMeetingSecurity: async () => record,
    });

    await assert.rejects(
      () =>
        manager.showPassword({
          projectName: "crm",
          meetingId: "2026-07-10-001",
        }),
      /keyVersion/,
    );
  });

  it("rotates the dashboard password and updates the Cosmos envelope", async () => {
    let uploadedHtml = null;
    let upserted = null;
    const oldDashboardHtml = "<html><body>Secret</body></html>";
    const manager = createManager({
      getMeetingSecurity: async () => encryptedMeetingRecord(),
      downloadDashboardHtml: async () =>
        protectedDashboardHtml(oldDashboardHtml, "OLDP-ASSW-ORD1"),
      uploadDashboardHtml: async (_project, _meeting, html) => {
        uploadedHtml = html;
      },
      upsertMeetingSecurity: async (document) => {
        upserted = document;
      },
    });

    const result = await manager.rotatePassword({
      projectName: "crm",
      meetingId: "2026-07-10-001",
    });

    assert.equal(result.password, "NEWP-ASSW-ORD2");
    assert.equal(
      decryptDashboardPayload(
        extractEncryptedPayloadFromUnlockPage(uploadedHtml),
        "NEWP-ASSW-ORD2",
      ),
      oldDashboardHtml,
    );
    assert.throws(() =>
      decryptDashboardPayload(
        extractEncryptedPayloadFromUnlockPage(uploadedHtml),
        "OLDP-ASSW-ORD1",
      ),
    );
    assert.equal(
      decryptDashboardPassword(upserted.passwordEncryption, NEW_KEY),
      "NEWP-ASSW-ORD2",
    );
  });

  it("rolls back the Blob HTML when Cosmos update fails after upload", async () => {
    const uploads = [];
    const upserts = [];
    const originalHtml = protectedDashboardHtml(
      "<html><body>Secret</body></html>",
      "OLDP-ASSW-ORD1",
    );
    const manager = createManager({
      getMeetingSecurity: async () => encryptedMeetingRecord(),
      downloadDashboardHtml: async () => originalHtml,
      uploadDashboardHtml: async (_project, _meeting, html) => {
        uploads.push(html);
      },
      upsertMeetingSecurity: async (document) => {
        upserts.push(document);
        if (upserts.length === 1) {
          throw new Error("Cosmos unavailable");
        }
      },
    });

    await assert.rejects(
      () =>
        manager.rotatePassword({
          projectName: "crm",
          meetingId: "2026-07-10-001",
        }),
      /Cosmos unavailable/,
    );
    assert.equal(uploads.length, 2);
    assert.notEqual(uploads[0], originalHtml);
    assert.equal(uploads[1], originalHtml);
    assert.equal(upserts.length, 2);
    assert.equal(upserts[1].passwordEncryption.keyVersion, "old-version");
  });

  it("revokes without returning the replacement password", async () => {
    const manager = createManager({
      getMeetingSecurity: async () => encryptedMeetingRecord(),
      downloadDashboardHtml: async () =>
        protectedDashboardHtml("<html>Secret</html>", "OLDP-ASSW-ORD1"),
      uploadDashboardHtml: async () => {},
      upsertMeetingSecurity: async () => {},
    });

    const result = await manager.revokePassword({
      projectName: "crm",
      meetingId: "2026-07-10-001",
    });

    assert.equal(result.password, undefined);
    assert.equal(result.passwordRevealed, false);
  });

  it("preserves project admins when toggling project policy", async () => {
    let upserted = null;
    const manager = createManager({
      getProjectPolicy: async () => ({
        projectName: "crm",
        projectAdmins: ["admin@ssw.com.au"],
      }),
      upsertProjectPolicy: async (policy) => {
        upserted = policy;
        return policy;
      },
    });

    await manager.setProjectPasswordProtection({
      projectName: "crm",
      enabled: false,
      updatedBy: "Willow",
    });

    assert.deepEqual(upserted.projectAdmins, ["admin@ssw.com.au"]);
    assert.equal(upserted.passwordProtectionEnabled, false);
  });
});
