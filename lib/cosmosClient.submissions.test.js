const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { buildSubmissionPatchOperations } = require("./cosmosClient");

// Patch ops as a map, so a test asserts on intent rather than array order.
function opsFor(fields) {
  return Object.fromEntries(
    buildSubmissionPatchOperations({ updatedAt: "2026-07-31T00:00:00.000Z", ...fields }).map((o) => [o.path, o.value]),
  );
}

describe("submission status patch operations", () => {
  it("writes the dashboard password only on a completed run", () => {
    const ops = opsFor({
      status: "completed",
      dashboardUrl: "https://dashboards.sswtiger.com/tiger/2026-07-31",
      passwordProtected: true,
      dashboardPassword: "W2C5-8PKS-XSV9",
    });

    assert.equal(ops["/status"], "completed");
    assert.equal(ops["/passwordProtected"], true);
    assert.equal(ops["/dashboardPassword"], "W2C5-8PKS-XSV9");
    assert.equal(ops["/failureReason"], null);
  });

  it("CLEARS a stale password when a re-run produces an unprotected dashboard", () => {
    // The regression: patching only on a truthy value left the previous run's
    // password readable in the portal history forever.
    const ops = opsFor({ status: "completed", passwordProtected: false, dashboardPassword: null });

    assert.ok("/passwordProtected" in ops, "passwordProtected must be written, not skipped");
    assert.equal(ops["/passwordProtected"], false);
    assert.ok("/dashboardPassword" in ops, "dashboardPassword must be written, not skipped");
    assert.equal(ops["/dashboardPassword"], null);
  });

  it("clears the password when a row leaves completed for processing or failed", () => {
    for (const status of ["processing", "failed"]) {
      const ops = opsFor({ status, passwordProtected: false, dashboardPassword: null });
      assert.equal(ops["/passwordProtected"], false, `${status} must not keep a password flag`);
      assert.equal(ops["/dashboardPassword"], null, `${status} must not keep a password`);
    }
  });

  it("leaves password fields untouched when the caller says nothing about them", () => {
    const ops = opsFor({ status: "processing" });

    assert.equal("/passwordProtected" in ops, false);
    assert.equal("/dashboardPassword" in ops, false);
  });

  it("clears the failure reason on a status that is no longer failed", () => {
    assert.equal(opsFor({ status: "failed", failureReason: "No transcript yet." })["/failureReason"], "No transcript yet.");
    assert.equal(opsFor({ status: "completed" })["/failureReason"], null);
  });

  it("skips an empty display name so an early failure cannot blank the title", () => {
    assert.equal("/displayName" in opsFor({ status: "failed", displayName: "" }), false);
    assert.equal(opsFor({ status: "completed", displayName: "Sprint Review" })["/displayName"], "Sprint Review");
  });
});
