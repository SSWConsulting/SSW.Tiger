#!/usr/bin/env node

// Best-effort update of a portal submission's status after the pipeline runs.
// Called by entrypoint.sh ONLY for uploadedTranscript sources. Never fails the
// pipeline: any error is logged and swallowed (exit 0).
//
// Env:
//   UPLOAD_REQUEST_ID        - submission id (Cosmos item id)
//   UPLOAD_PROJECT_SLUG      - partition key (raw slug), as written by the Portal API
//   SUBMISSION_STATUS        - "processing" | "completed" | "failed"
//   SUBMISSION_DASHBOARD_URL - deployed dashboard URL (only for "completed")
//   COSMOS_ENDPOINT          - required; skipped if unset

const { log } = require("../lib/logger");

async function main() {
  const requestId = process.env.UPLOAD_REQUEST_ID;
  const projectName = process.env.UPLOAD_PROJECT_SLUG;
  const status = process.env.SUBMISSION_STATUS;
  const dashboardUrl = process.env.SUBMISSION_DASHBOARD_URL || undefined;

  if (!process.env.COSMOS_ENDPOINT) {
    log("warn", "updateSubmissionStatus: COSMOS_ENDPOINT unset, skipping");
    return;
  }
  if (!requestId || !projectName || !status) {
    log("warn", "updateSubmissionStatus: missing config, skipping", {
      hasRequestId: !!requestId,
      hasProjectSlug: !!projectName,
      status: status || "(none)",
    });
    return;
  }

  try {
    const { updateSubmissionStatus } = require("../lib/cosmosClient");
    const updated = await updateSubmissionStatus({
      requestId,
      projectName,
      status,
      dashboardUrl: status === "completed" ? dashboardUrl : undefined,
    });
    log("info", "Submission status updated", { requestId, status, recordFound: !!updated });
  } catch (error) {
    // Best effort: the dashboard already deployed; a stale history row is not
    // worth failing the run over.
    log("error", "Failed to update submission status", { requestId, status, error: error.message });
  }
}

main();
