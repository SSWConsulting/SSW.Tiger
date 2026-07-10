#!/usr/bin/env node

/**
 * Toggle a project's non-guessable (obfuscated) dashboard URLs.
 *
 * When ON, every dashboard deployed AFTER this point for the project is
 * published to a non-guessable GUID path (/{project}/{guid}/) instead of the
 * human-readable /{project}/{meetingId}/, and the public per-project index page
 * is suppressed. Existing dashboards are untouched (their URLs keep working).
 *
 * Usage:
 *   node scripts/set-project-obfuscation.js <projectSlug> <true|false>
 *
 * Example:
 *   node scripts/set-project-obfuscation.js crm true
 *
 * Access control: this writes to the Cosmos "projects" container, which is
 * gated by Azure RBAC (Cosmos DB Built-in Data Contributor on cosmos-tiger-*).
 * The repo being public does not grant anyone the ability to run this — you
 * need that Cosmos role. No credentials live in this file; auth is via
 * DefaultAzureCredential (az login locally / managed identity in Azure).
 *
 * Prerequisites:
 *   - Azure CLI installed and logged in (az login) with the Cosmos role above
 *   - COSMOS_ENDPOINT set (in .env or the environment), e.g.
 *       https://cosmos-tiger-staging.documents.azure.com:443/
 *
 * Equivalent az fallback (if you'd rather not run Node):
 *   az cosmosdb sql ... — or use the Data Explorer to upsert
 *   { "id": "<slug>", "projectName": "<slug>", "obfuscateUrls": true } into
 *   the tiger/projects container.
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { upsertProjectSettings, getProjectSettings } = require("../lib/cosmosClient");

function parseBool(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

async function main() {
  const [projectSlug, flagArg] = process.argv.slice(2);
  const obfuscateUrls = parseBool(flagArg);

  if (!projectSlug || obfuscateUrls === null) {
    console.error("Usage: node scripts/set-project-obfuscation.js <projectSlug> <true|false>");
    console.error("Example: node scripts/set-project-obfuscation.js crm true");
    process.exit(1);
  }

  if (!process.env.COSMOS_ENDPOINT) {
    console.error("COSMOS_ENDPOINT is not set. Set it in .env or the environment.");
    process.exit(1);
  }

  const result = await upsertProjectSettings({ projectName: projectSlug, obfuscateUrls });
  const confirmed = await getProjectSettings(projectSlug);

  console.log(
    `Project '${result.projectName}' obfuscateUrls = ${confirmed.obfuscateUrls}. ` +
      `New dashboards will use ${confirmed.obfuscateUrls ? "GUID (non-guessable)" : "human-readable"} URLs.`,
  );
}

main().catch((err) => {
  console.error(`Failed to update project setting: ${err.message}`);
  process.exit(1);
});
