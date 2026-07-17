function parseQueueMessage(message) {
  if (typeof message !== "string") return message;
  try {
    return JSON.parse(message);
  } catch {
    throw new Error("Invalid JSON in queue message");
  }
}

function normalizeQueueMessage(message) {
  const data = parseQueueMessage(message);
  if (!data || typeof data !== "object") throw new Error("Invalid queue message");

  if (!data.sourceType || data.sourceType === "graphTranscript") {
    const { userId, meetingId, transcriptId } = data;
    if (!userId || !meetingId || !transcriptId) {
      throw new Error("Missing required Graph IDs in queue message");
    }
    return {
      sourceType: "graphTranscript",
      userId,
      meetingId,
      transcriptId,
      skipSubjectFilter: !!data.skipSubjectFilter,
      manualTrigger: !!data.manualTrigger,
      restartTrigger: !!data.restartTrigger,
      restartId: data.restartId,
      restartedFromExecutionId: data.restartedFromExecutionId,
    };
  }

  if (data.sourceType === "uploadedTranscript") {
    if (data.schemaVersion !== 2 || !data.requestId || !data.project?.slug || !data.project?.displayName) {
      throw new Error("Invalid uploaded transcript queue message");
    }
    const source = data.source;
    if (!source?.storageAccount || !source?.containerName || !source?.blobName || !source?.fileName) {
      throw new Error("Missing uploaded transcript blob locator");
    }
    return {
      schemaVersion: 2,
      sourceType: "uploadedTranscript",
      requestId: data.requestId,
      submittedAt: data.submittedAt,
      project: { displayName: data.project.displayName, slug: data.project.slug },
      source: {
        storageAccount: source.storageAccount,
        containerName: source.containerName,
        blobName: source.blobName,
        fileName: source.fileName,
      },
    };
  }

  if (data.sourceType === "meetingLink") {
    if (data.schemaVersion !== 2 || !data.requestId || !data.project?.slug || !data.project?.displayName) {
      throw new Error("Invalid meeting link queue message");
    }
    if (!data.joinUrl || !data.organizerId) {
      throw new Error("Missing meeting link locator");
    }
    return {
      schemaVersion: 2,
      sourceType: "meetingLink",
      requestId: data.requestId,
      submittedAt: data.submittedAt,
      project: { displayName: data.project.displayName, slug: data.project.slug },
      joinUrl: data.joinUrl,
      organizerId: data.organizerId,
    };
  }

  throw new Error(`Unsupported transcript source type: ${data.sourceType}`);
}

function buildDedupKey(data, now = Date.now()) {
  if (data.sourceType === "uploadedTranscript") return `upload-${data.requestId}`;
  if (data.sourceType === "meetingLink") return `meeting-${data.requestId}`;
  if (data.restartTrigger) return `restart-${data.restartId || `${data.meetingId}-${data.transcriptId}-${now}`}`;
  if (data.manualTrigger) return `manual-${data.meetingId}-${data.transcriptId}`;
  return `${data.meetingId}-${data.transcriptId}`;
}

function buildDynamicJobEnvironment(data) {
  if (data.sourceType === "uploadedTranscript") {
    return [
      { name: "TRANSCRIPT_SOURCE_TYPE", value: "uploadedTranscript" },
      { name: "UPLOAD_REQUEST_ID", value: data.requestId },
      { name: "TRANSCRIPT_STORAGE_ACCOUNT", value: data.source.storageAccount },
      { name: "TRANSCRIPT_STORAGE_CONTAINER", value: data.source.containerName },
      { name: "TRANSCRIPT_BLOB_NAME", value: data.source.blobName },
      { name: "UPLOAD_FILENAME", value: data.source.fileName },
      { name: "UPLOAD_PROJECT_NAME", value: data.project.displayName },
      { name: "UPLOAD_PROJECT_SLUG", value: data.project.slug },
    ];
  }
  if (data.sourceType === "meetingLink") {
    return [
      { name: "TRANSCRIPT_SOURCE_TYPE", value: "meetingLink" },
      // UPLOAD_REQUEST_ID / UPLOAD_PROJECT_* are reused for the shared history
      // record + status write-back (same as the upload path).
      { name: "UPLOAD_REQUEST_ID", value: data.requestId },
      { name: "MEETING_JOIN_URL", value: data.joinUrl },
      { name: "MEETING_ORGANIZER_ID", value: data.organizerId },
      { name: "UPLOAD_PROJECT_NAME", value: data.project.displayName },
      { name: "UPLOAD_PROJECT_SLUG", value: data.project.slug },
    ];
  }
  return [
    { name: "TRANSCRIPT_SOURCE_TYPE", value: "graphTranscript" },
    { name: "GRAPH_USER_ID", value: data.userId },
    { name: "GRAPH_MEETING_ID", value: data.meetingId },
    { name: "GRAPH_TRANSCRIPT_ID", value: data.transcriptId },
    ...(data.skipSubjectFilter ? [{ name: "SKIP_SUBJECT_FILTER", value: "true" }] : []),
  ];
}

function buildJobEnvironment(data, runtimeEnv, tracking = {}) {
  const dynamic = buildDynamicJobEnvironment(data);

  return [
    ...dynamic,
    { name: "JOB_EXECUTION_ID", value: tracking.executionId || "" },
    { name: "CANCEL_URL", value: tracking.cancelUrl || "" },
    { name: "CHECK_CANCELLATION_URL", value: tracking.checkCancellationUrl || "" },
    { name: "RESTART_URL", value: tracking.restartUrl || "" },
    { name: "NODE_ENV", value: "production" },
    { name: "AZURE_CLIENT_ID", value: runtimeEnv.AZURE_CLIENT_ID || "" },
    { name: "DASHBOARD_STORAGE_ACCOUNT", value: runtimeEnv.DASHBOARD_STORAGE_ACCOUNT || "" },
    { name: "DASHBOARD_BASE_URL", value: runtimeEnv.DASHBOARD_BASE_URL || "" },
    { name: "KEY_VAULT_URL", value: runtimeEnv.KEY_VAULT_URL || "" },
    { name: "CLAUDE_CODE_OAUTH_TOKEN", secretRef: "anthropic-oauth-token" },
    { name: "GRAPH_CLIENT_ID", secretRef: "graph-client-id" },
    { name: "GRAPH_CLIENT_SECRET", secretRef: "graph-client-secret" },
    { name: "GRAPH_TENANT_ID", secretRef: "graph-tenant-id" },
    { name: "LOGIC_APP_URL", secretRef: "logic-app-url" },
    { name: "COSMOS_ENDPOINT", value: runtimeEnv.COSMOS_ENDPOINT || "" },
    {
      name: "COSMOS_PROJECT_POLICIES_CONTAINER",
      value: runtimeEnv.COSMOS_PROJECT_POLICIES_CONTAINER || "projectPolicies",
    },
    {
      name: "COSMOS_MEETING_SECURITY_CONTAINER",
      value: runtimeEnv.COSMOS_MEETING_SECURITY_CONTAINER || "meetingSecurity",
    },
    // Must match the Portal API's submissions container so upload status write-back
    // patches the same records the Portal API created.
    { name: "COSMOS_SUBMISSIONS_CONTAINER", value: runtimeEnv.COSMOS_SUBMISSIONS_CONTAINER || "submissions" },
    { name: "CLAUDE_MODEL", value: runtimeEnv.CLAUDE_MODEL || "" },
  ];
}

module.exports = { normalizeQueueMessage, buildDedupKey, buildJobEnvironment };
