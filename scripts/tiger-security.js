#!/usr/bin/env node

const { createDashboardSecurityManager } = require("../lib/dashboardSecurityManager");

function usage() {
  return [
    "Usage:",
    "  node scripts/tiger-security.js show --dashboard-url <url>",
    "  node scripts/tiger-security.js rotate --dashboard-url <url> --yes",
    "  node scripts/tiger-security.js revoke --dashboard-url <url> --yes",
    "  node scripts/tiger-security.js project set --project <name> --password-protection on|off",
    "",
    "Alternative meeting target:",
    "  --project <name> --meeting-id <id>",
  ].join("\n");
}

function parseArgs(argv) {
  const command = argv[0];
  const hasSubcommand = command === "project";
  const subcommand = hasSubcommand ? argv[1] : undefined;
  const rest = argv.slice(hasSubcommand ? 2 : 1);
  const flags = {};

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--yes") {
      flags.yes = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    flags[arg.slice(2)] = value;
    index += 1;
  }

  return { command, subcommand, flags };
}

function parseDashboardTarget(flags) {
  if (flags["dashboard-url"]) {
    return parseDashboardUrl(flags["dashboard-url"]);
  }

  if (flags.project && flags["meeting-id"]) {
    return {
      projectName: flags.project,
      meetingId: flags["meeting-id"],
    };
  }

  throw new Error("Provide --dashboard-url or both --project and --meeting-id");
}

function parseDashboardUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid dashboard URL");
  }

  const segments = url.pathname
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);

  if (segments.length < 2) {
    throw new Error("Dashboard URL must include /{project}/{meetingId}/");
  }

  return {
    projectName: decodeURIComponent(segments[0]),
    meetingId: decodeURIComponent(segments[1]),
  };
}

function requireEnv(names) {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

async function run(argv = process.argv.slice(2), output = console.log) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    output(usage());
    return;
  }

  const { command, subcommand, flags } = parseArgs(argv);
  const manager = createDashboardSecurityManager();

  if (command === "show") {
    requireEnv(["COSMOS_ENDPOINT", "KEY_VAULT_URL", "DASHBOARD_STORAGE_ACCOUNT"]);
    const result = await manager.showPassword(parseDashboardTarget(flags));
    output(result.password);
    return;
  }

  if (command === "rotate") {
    requireEnv(["COSMOS_ENDPOINT", "KEY_VAULT_URL", "DASHBOARD_STORAGE_ACCOUNT"]);
    if (!flags.yes) {
      throw new Error("rotate modifies the dashboard and requires --yes");
    }
    const result = await manager.rotatePassword({
      ...parseDashboardTarget(flags),
      updatedBy: currentUser(),
    });
    output(result.password);
    return;
  }

  if (command === "revoke") {
    requireEnv(["COSMOS_ENDPOINT", "KEY_VAULT_URL", "DASHBOARD_STORAGE_ACCOUNT"]);
    if (!flags.yes) {
      throw new Error("revoke modifies the dashboard and requires --yes");
    }
    const result = await manager.revokePassword({
      ...parseDashboardTarget(flags),
      updatedBy: currentUser(),
    });
    output(`Password revoked for ${result.projectName}/${result.meetingId}`);
    return;
  }

  if (command === "project" && subcommand === "set") {
    requireEnv(["COSMOS_ENDPOINT"]);
    if (!flags.project) {
      throw new Error("--project is required");
    }
    if (!["on", "off"].includes(flags["password-protection"])) {
      throw new Error("--password-protection must be on or off");
    }
    const policy = await manager.setProjectPasswordProtection({
      projectName: flags.project,
      enabled: flags["password-protection"] === "on",
      updatedBy: currentUser(),
    });
    output(
      `Password protection ${policy.passwordProtectionEnabled ? "on" : "off"} for ${policy.projectName}`,
    );
    return;
  }

  throw new Error(`Unknown command: ${[command, subcommand].filter(Boolean).join(" ")}`);
}

function currentUser() {
  return process.env.USERNAME || process.env.USER || "tiger-security-cli";
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error.message);
    console.error("");
    console.error(usage());
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  parseDashboardTarget,
  parseDashboardUrl,
  run,
  usage,
};
