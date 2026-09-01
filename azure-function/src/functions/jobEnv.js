/**
 * Builds the env array for the Container App Job template override.
 *
 * Starting a job with a template override REPLACES the container's env array
 * outright, so anything the processor reads has to be re-declared here even
 * when it is already set on the job. A var missing from this list is simply
 * unset at runtime, which is how the transcript hub publish silently no-opped
 * for its first two weeks (SSWConsulting/SSW.Tiger#134).
 *
 * Job-level secrets live under properties.configuration.secrets and are NOT
 * touched by the override, so secretRef entries stay valid.
 */
function buildJobEnv({
  userId,
  meetingId,
  transcriptId,
  executionId,
  cancelUrl,
  checkCancellationUrl,
  restartUrl,
  skipSubjectFilter,
  env = process.env,
}) {
  return [
    // Dynamic values passed from queue message
    { name: "GRAPH_USER_ID", value: userId },
    { name: "GRAPH_MEETING_ID", value: meetingId },
    { name: "GRAPH_TRANSCRIPT_ID", value: transcriptId },
    // Execution tracking for cancel functionality
    { name: "JOB_EXECUTION_ID", value: executionId },
    { name: "CANCEL_URL", value: cancelUrl },
    { name: "CHECK_CANCELLATION_URL", value: checkCancellationUrl },
    // Restart URL - sent in failed/cancelled Teams cards so users can re-run
    { name: "RESTART_URL", value: restartUrl },
    // Manual trigger: skip subject filter when explicitly requested
    ...(skipSubjectFilter ? [{ name: "SKIP_SUBJECT_FILTER", value: "true" }] : []),
    // Static values - must be included as template override replaces the env array
    { name: "NODE_ENV", value: "production" },
    { name: "AZURE_CLIENT_ID", value: env.AZURE_CLIENT_ID },
    { name: "DASHBOARD_STORAGE_ACCOUNT", value: env.DASHBOARD_STORAGE_ACCOUNT },
    { name: "DASHBOARD_BASE_URL", value: env.DASHBOARD_BASE_URL },
    { name: "KEY_VAULT_URL", value: env.KEY_VAULT_URL || "" },
    // Secrets from job configuration (defined in containerApp.bicep)
    { name: "CLAUDE_CODE_OAUTH_TOKEN", secretRef: "anthropic-oauth-token" },
    { name: "GRAPH_CLIENT_ID", secretRef: "graph-client-id" },
    { name: "GRAPH_CLIENT_SECRET", secretRef: "graph-client-secret" },
    { name: "GRAPH_TENANT_ID", secretRef: "graph-tenant-id" },
    { name: "LOGIC_APP_URL", secretRef: "logic-app-url" },
    // Cosmos DB for meeting metadata persistence
    { name: "COSMOS_ENDPOINT", value: env.COSMOS_ENDPOINT || "" },
    { name: "COSMOS_PROJECT_POLICIES_CONTAINER", value: env.COSMOS_PROJECT_POLICIES_CONTAINER || "projectPolicies" },
    { name: "COSMOS_MEETING_SECURITY_CONTAINER", value: env.COSMOS_MEETING_SECURITY_CONTAINER || "meetingSecurity" },
    // Claude model override
    { name: "CLAUDE_MODEL", value: env.CLAUDE_MODEL || "" },
    // Transcript hub: archives the raw .vtt before analysis, no-ops when REPO is unset
    { name: "TRANSCRIPT_HUB_REPO", value: env.TRANSCRIPT_HUB_REPO || "" },
    { name: "TRANSCRIPT_HUB_APP_ID", value: env.TRANSCRIPT_HUB_APP_ID || "" },
    { name: "TRANSCRIPT_HUB_APP_INSTALLATION_ID", value: env.TRANSCRIPT_HUB_APP_INSTALLATION_ID || "" },
    { name: "TRANSCRIPT_HUB_APP_PRIVATE_KEY", secretRef: "transcript-hub-app-private-key" },
  ];
}

module.exports = { buildJobEnv };
