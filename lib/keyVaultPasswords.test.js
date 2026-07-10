const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  decodePasswordEncryptionKey,
  encryptDashboardPassword,
  decryptDashboardPassword,
} = require("./keyVaultPasswords");

describe("Dashboard password encryption", () => {
  it("encrypts a password into a recoverable envelope", () => {
    const key = decodePasswordEncryptionKey(
      Buffer.alloc(32, 7).toString("base64"),
    );
    const password = "W2C5-8PKS-XSV9";
    const envelope = encryptDashboardPassword(password, {
      key,
      keySecretName: "tiger-password-encryption-key",
      keyVersion: "abc123",
    });

    assert.equal(envelope.algorithm, "AES-256-GCM");
    assert.equal(envelope.keySecretName, "tiger-password-encryption-key");
    assert.equal(envelope.keyVersion, "abc123");
    assert.notEqual(envelope.ciphertext, password);
    assert.equal(decryptDashboardPassword(envelope, key), password);

    envelope.authTag = Buffer.alloc(16, 1).toString("base64");
    assert.throws(() => decryptDashboardPassword(envelope, key));
  });

  it("rejects an invalid master key", () => {
    assert.throws(
      () => decodePasswordEncryptionKey(Buffer.alloc(31).toString("base64")),
      /32 bytes/,
    );
    assert.throws(() => decodePasswordEncryptionKey("not a key"), /Base64/);
  });
});
