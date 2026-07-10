const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  validateParticipantsForNotification,
  validateRequiredConfig,
} = require("./sendNotification");

describe("sendNotification config validation", () => {
  it("rejects password-protected completed notifications without a password", () => {
    assert.throws(
      () =>
        validateRequiredConfig({
          logicAppUrl: "https://example.test/logic-app",
          dashboardUrl: "https://dashboards-test.sswtiger.com/crm/meeting/",
          notificationType: "completed",
          passwordProtected: true,
          dashboardPassword: "",
        }),
      /DASHBOARD_PASSWORD/,
    );
  });

  it("rejects password-protected completed notifications with whitespace password", () => {
    assert.throws(
      () =>
        validateRequiredConfig({
          logicAppUrl: "https://example.test/logic-app",
          dashboardUrl: "https://dashboards-test.sswtiger.com/crm/meeting/",
          notificationType: "completed",
          passwordProtected: true,
          dashboardPassword: "   ",
        }),
      /DASHBOARD_PASSWORD/,
    );
  });

  it("allows public completed notifications without a password", () => {
    assert.doesNotThrow(() =>
      validateRequiredConfig({
        logicAppUrl: "https://example.test/logic-app",
        dashboardUrl: "https://dashboards-test.sswtiger.com/crm/meeting/",
        notificationType: "completed",
        passwordProtected: false,
        dashboardPassword: "",
      }),
    );
  });

  it("rejects password-protected completed notifications without recipients", () => {
    assert.throws(
      () =>
        validateParticipantsForNotification(
          {
            notificationType: "completed",
            passwordProtected: true,
          },
          [],
        ),
      /Participants/,
    );
  });
});
