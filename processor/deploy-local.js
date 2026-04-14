#!/usr/bin/env node

/**
 * Deploy a locally-generated dashboard to Azure Blob Storage + Cosmos DB.
 *
 * Usage:
 *   node processor/deploy-local.js <project-name> <meeting-id>
 *
 * Example:
 *   node processor/deploy-local.js yakshaver 2026-01-22-094557
 *
 * Prerequisites:
 *   - Azure CLI installed and logged in (az login)
 *   - DASHBOARD_STORAGE_ACCOUNT set in .env
 *   - DASHBOARD_BASE_URL set in .env (optional, falls back to Azure hostname)
 *   - COSMOS_ENDPOINT set in .env
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const path = require("path");
const { log } = require("../lib/logger");
const { checkOutputExists, deployDashboard, persistToCosmos } = require("./deployer");

const ROOT_DIR = path.join(__dirname, "..");

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error("Usage: node processor/deploy-local.js <project-name> <meeting-id>");
    console.error("Example: node processor/deploy-local.js yakshaver 2026-01-22-094557");
    process.exit(1);
  }

  const [projectName, meetingId] = args;
  const meetingPath = path.join(ROOT_DIR, "projects", projectName, meetingId);

  // Find the dashboard HTML
  const dashboardPath = await checkOutputExists({
    meetingPath,
    outputDir: path.join(ROOT_DIR, "output"),
    projectName,
    meetingId,
  });

  // Deploy to Azure Blob Storage
  const { deployedUrl, dashboardPath: storagePath } = await deployDashboard({
    dashboardPath,
    projectName,
    meetingId,
  });

  console.log(`Deployed: ${deployedUrl}`);

  // Persist to Cosmos DB
  const meetingDate = meetingId.substring(0, 10);
  await persistToCosmos({
    projectName,
    meetingId,
    meetingDate,
    dashboardPath: storagePath,
    meetingPath,
  });
  console.log("Saved to Cosmos DB");
}

main().catch((err) => {
  console.error(`Deploy failed: ${err.message}`);
  process.exit(1);
});
