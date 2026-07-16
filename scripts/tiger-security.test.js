const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  parseArgs,
  parseDashboardTarget,
  parseDashboardUrl,
  run,
} = require("./tiger-security");

describe("tiger security CLI parsing", () => {
  it("parses a dashboard URL target", () => {
    assert.deepEqual(
      parseDashboardUrl("https://dashboards-test.sswtiger.com/crm/2026-07-10-001/"),
      {
        projectName: "crm",
        meetingId: "2026-07-10-001",
      },
    );
  });

  it("parses explicit project and meeting target", () => {
    assert.deepEqual(
      parseDashboardTarget({
        project: "crm",
        "meeting-id": "2026-07-10-001",
      }),
      {
        projectName: "crm",
        meetingId: "2026-07-10-001",
      },
    );
  });

  it("requires values for flags", () => {
    assert.throws(
      () => parseArgs(["show", "--dashboard-url"]),
      /Missing value/,
    );
  });

  it("parses an optional env file flag", () => {
    assert.deepEqual(
      parseArgs(["project", "set", "--project", "crm", "--password-protection", "on", "--env-file", ".env.test"]).flags,
      {
        project: "crm",
        "password-protection": "on",
        "env-file": ".env.test",
      },
    );
  });

  it("documents the protect command", async () => {
    const output = [];
    await run(["--help"], (line) => output.push(line));
    assert.match(output.join("\n"), /npm run tiger:security -- protect/);
  });

  it("prints help without Azure environment variables", async () => {
    const output = [];
    await run(["--help"], (line) => output.push(line));
    assert.match(output.join("\n"), /npm run tiger:security -- show/);
  });
});
