const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  generateDashboardPassword,
  encryptDashboardHtml,
  decryptDashboardPayload,
  extractEncryptedPayloadFromUnlockPage,
  renderUnlockPage,
} = require("./dashboardEncryption");

describe("dashboard encryption", () => {
  it("round-trips dashboard HTML with the generated password", () => {
    const password = generateDashboardPassword();
    const html = "<!DOCTYPE html><html><body><h1>Secret dashboard</h1></body></html>";
    const payload = encryptDashboardHtml(html, password, { iterations: 1000 });

    assert.equal(decryptDashboardPayload(payload, password), html);
    assert.throws(() => decryptDashboardPayload(payload, "wrong-password"));
  });

  it("renders an unlock page with an extractable encrypted payload", () => {
    const password = "ABCD-EFGH-IJKL";
    const html = "<main>Dashboard</main>";
    const payload = encryptDashboardHtml(html, password, { iterations: 1000 });
    const unlockPage = renderUnlockPage({
      projectName: "crm",
      meetingId: "2026-07-09-100000",
      encryptedPayload: payload,
    });

    const extracted = extractEncryptedPayloadFromUnlockPage(unlockPage);
    assert.equal(decryptDashboardPayload(extracted, password), html);
    assert.equal(unlockPage.includes(html), false);
  });
});
