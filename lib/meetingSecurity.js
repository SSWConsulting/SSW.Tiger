const { sanitizeId } = require("./sanitize");

function meetingSecurityId(projectName, meetingId) {
  const sanitizedProject = sanitizeId(projectName) || "general";
  return `meetingSecurity-${sanitizedProject}-${sanitizeId(meetingId)}`;
}

function createMeetingSecurityDocument({
  projectName,
  meetingId,
  passwordEnabled,
  passwordEncryption,
  encryptedAt,
  updatedBy = "system",
}) {
  const missing = [
    !projectName && "projectName",
    !meetingId && "meetingId",
    passwordEnabled && !passwordEncryption && "passwordEncryption",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(`upsertMeetingSecurity: missing required fields: ${missing.join(", ")}`);
  }

  const sanitizedProject = sanitizeId(projectName) || "general";
  return {
    id: meetingSecurityId(sanitizedProject, meetingId),
    type: "meetingSecurity",
    projectName: sanitizedProject,
    meetingId,
    passwordEnabled: !!passwordEnabled,
    passwordEncryption: passwordEnabled
      ? validatePasswordEncryption(passwordEncryption)
      : null,
    encryptedAt: encryptedAt || null,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
}

function validatePasswordEncryption(passwordEncryption) {
  const requiredFields = [
    "algorithm",
    "keySecretName",
    "iv",
    "authTag",
    "ciphertext",
  ];
  const missing = requiredFields.filter(
    (field) => !passwordEncryption?.[field],
  );
  if (missing.length > 0) {
    throw new Error(
      `upsertMeetingSecurity: passwordEncryption is missing ${missing.join(", ")}`,
    );
  }
  if (passwordEncryption.algorithm !== "AES-256-GCM") {
    throw new Error("upsertMeetingSecurity: unsupported password encryption algorithm");
  }

  return {
    algorithm: passwordEncryption.algorithm,
    keySecretName: String(passwordEncryption.keySecretName),
    keyVersion: passwordEncryption.keyVersion || null,
    iv: String(passwordEncryption.iv),
    authTag: String(passwordEncryption.authTag),
    ciphertext: String(passwordEncryption.ciphertext),
  };
}

module.exports = {
  meetingSecurityId,
  createMeetingSecurityDocument,
  validatePasswordEncryption,
};
