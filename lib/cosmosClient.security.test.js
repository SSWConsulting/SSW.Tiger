const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { createMeetingSecurityDocument } = require("./meetingSecurity");
const { isCosmosInfrastructureNotFound } = require("./cosmosClient");

describe("meeting security documents", () => {
  it("stores a protected password envelope without plaintext", () => {
    const password = "W2C5-8PKS-XSV9";
    const document = createMeetingSecurityDocument({
      projectName: "crm",
      meetingId: "2026-07-10-001",
      passwordEnabled: true,
      passwordEncryption: {
        algorithm: "AES-256-GCM",
        keySecretName: "tiger-password-encryption-key",
        keyVersion: "abc123",
        iv: "aXY=",
        authTag: "dGFn",
        ciphertext: "Y2lwaGVydGV4dA==",
      },
      encryptedAt: "2026-07-10T00:00:00.000Z",
    });

    assert.equal(document.passwordEncryption.algorithm, "AES-256-GCM");
    assert.equal(document.passwordSecretName, undefined);
    assert.equal(JSON.stringify(document).includes(password), false);
  });

  it("rejects protected records without a complete password envelope", () => {
    assert.throws(
      () => createMeetingSecurityDocument({
        projectName: "crm",
        meetingId: "2026-07-10-001",
        passwordEnabled: true,
        passwordEncryption: { algorithm: "AES-256-GCM" },
      }),
      /keySecretName/,
    );
  });
});

describe("Cosmos security policy errors", () => {
  it("distinguishes infrastructure 404s from missing policy documents", () => {
    assert.equal(
      isCosmosInfrastructureNotFound({
        code: 404,
        message: "Entity with the specified id does not exist in the system.",
      }),
      false,
    );
    assert.equal(
      isCosmosInfrastructureNotFound({
        code: 404,
        message: "Owner resource does not exist: Database tiger",
      }),
      true,
    );
    assert.equal(
      isCosmosInfrastructureNotFound({
        code: 404,
        message: "Owner resource does not exist: Container meetingSecurity",
      }),
      true,
    );
  });
});
