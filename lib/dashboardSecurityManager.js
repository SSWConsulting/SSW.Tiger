const {
  generateDashboardPassword,
  encryptDashboardHtml,
  decryptDashboardPayload,
  extractEncryptedPayloadFromUnlockPage,
  renderUnlockPage,
} = require("./dashboardEncryption");
const {
  getPasswordEncryptionKey,
  encryptDashboardPassword,
  decryptDashboardPassword,
} = require("./keyVaultPasswords");
const {
  getProjectPolicy,
  upsertProjectPolicy,
  getMeetingSecurity,
  upsertMeetingSecurity,
} = require("./cosmosClient");
const {
  downloadDashboardHtml,
  uploadDashboardHtml,
} = require("./dashboardBlob");
const { log } = require("./logger");

function createDashboardSecurityManager(deps = {}) {
  const services = {
    getPasswordEncryptionKey,
    encryptDashboardPassword,
    decryptDashboardPassword,
    getProjectPolicy,
    upsertProjectPolicy,
    getMeetingSecurity,
    upsertMeetingSecurity,
    downloadDashboardHtml,
    uploadDashboardHtml,
    generateDashboardPassword,
    encryptDashboardHtml,
    decryptDashboardPayload,
    extractEncryptedPayloadFromUnlockPage,
    renderUnlockPage,
    ...deps,
  };

  async function showPassword(target) {
    const { record, password } = await readMeetingPassword(target);
    return {
      projectName: record.projectName,
      meetingId: record.meetingId,
      password,
    };
  }

  async function rotatePassword(target) {
    return replaceMeetingPassword(target, { revealPassword: true });
  }

  async function revokePassword(target) {
    return replaceMeetingPassword(target, { revealPassword: false });
  }

  async function setProjectPasswordProtection({
    projectName,
    enabled,
    updatedBy,
  }) {
    if (!projectName) {
      throw new Error("projectName is required");
    }
    log("info", "Setting project password protection", {
      projectName,
      enabled: !!enabled,
      updatedBy,
    });
    const existing = await services.getProjectPolicy(projectName);
    return services.upsertProjectPolicy({
      projectName,
      passwordProtectionEnabled: !!enabled,
      projectAdmins: existing?.projectAdmins || [],
      updatedBy,
    });
  }

  async function readMeetingPassword(target) {
    const record = await readProtectedMeetingSecurity(target);
    const encryption = record.passwordEncryption;
    if (!encryption.keyVersion) {
      throw new Error("passwordEncryption.keyVersion is required");
    }
    const keyInfo = await services.getPasswordEncryptionKey({
      secretName: encryption.keySecretName,
      secretVersion: encryption.keyVersion,
    });
    const password = services.decryptDashboardPassword(
      encryption,
      keyInfo.key,
    );
    return { record, password };
  }

  async function replaceMeetingPassword(target, { revealPassword }) {
    const { record, password: oldPassword } = await readMeetingPassword(target);
    const originalHtml = await services.downloadDashboardHtml(
      target.projectName,
      target.meetingId,
    );
    const encryptedPayload =
      services.extractEncryptedPayloadFromUnlockPage(originalHtml);
    if (!encryptedPayload) {
      throw new Error("Dashboard HTML is not a Tiger encrypted unlock page");
    }

    const dashboardHtml = services.decryptDashboardPayload(
      encryptedPayload,
      oldPassword,
    );
    const newPassword = services.generateDashboardPassword();
    const newPayload = services.encryptDashboardHtml(dashboardHtml, newPassword);
    const newUnlockHtml = services.renderUnlockPage({
      projectName: target.projectName,
      meetingId: target.meetingId,
      encryptedPayload: newPayload,
    });

    const keyInfo = await services.getPasswordEncryptionKey();
    const passwordEncryption = services.encryptDashboardPassword(
      newPassword,
      keyInfo,
    );

    await services.uploadDashboardHtml(
      target.projectName,
      target.meetingId,
      newUnlockHtml,
    );

    try {
      await services.upsertMeetingSecurity({
        projectName: target.projectName,
        meetingId: target.meetingId,
        passwordEnabled: true,
        passwordEncryption,
        encryptedAt: new Date().toISOString(),
        updatedBy: target.updatedBy || "tiger-security-cli",
      });
    } catch (error) {
      try {
        await services.uploadDashboardHtml(
          target.projectName,
          target.meetingId,
          originalHtml,
        );
        await services.upsertMeetingSecurity({
          projectName: record.projectName,
          meetingId: record.meetingId,
          passwordEnabled: true,
          passwordEncryption: record.passwordEncryption,
          encryptedAt: record.encryptedAt || null,
          updatedBy: target.updatedBy || "tiger-security-cli-rollback",
        });
      } catch (rollbackError) {
        throw new Error(
          `Failed to update meeting security and rollback dashboard state: ${error.message}; rollback: ${rollbackError.message}`,
        );
      }
      throw error;
    }

    return {
      projectName: record.projectName,
      meetingId: record.meetingId,
      password: revealPassword ? newPassword : undefined,
      passwordRevealed: !!revealPassword,
    };
  }

  async function readProtectedMeetingSecurity(target) {
    if (!target?.projectName || !target?.meetingId) {
      throw new Error("projectName and meetingId are required");
    }
    const record = await services.getMeetingSecurity(
      target.projectName,
      target.meetingId,
    );
    if (!record?.passwordEnabled || !record.passwordEncryption) {
      throw new Error("No protected meeting security record found");
    }
    return record;
  }

  return {
    showPassword,
    rotatePassword,
    revokePassword,
    setProjectPasswordProtection,
  };
}

module.exports = {
  createDashboardSecurityManager,
};
