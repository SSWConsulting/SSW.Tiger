const { app } = require("@azure/functions");
const { createSubmissionStorage, DEFAULT_CONTAINER } = require("../services/submissionStorage");
const { createSubmissionQueue } = require("../services/submissionQueue");
const { createSubmissionService } = require("../services/submissionService");
const { createSubmissionStore } = require("../services/submissionStore");
const { MAX_TRANSCRIPT_BYTES, SubmissionValidationError } = require("../services/submissionValidation");
const { createSubmissionActorResolver } = require("../services/submissionActor");
const { json } = require("../http");

function createSubmitTranscriptHandler({ service, actorResolver = createSubmissionActorResolver() } = {}) {
  return async function submitTranscript(request, context) {
    const contentLength = Number(request.headers?.get?.("content-length") || 0);
    if (contentLength > MAX_TRANSCRIPT_BYTES + 1024 * 1024) {
      return json(413, { error: { code: "file_too_large", message: "The transcript must be 10 MB or smaller." } });
    }

    // Only a real signed-in user may submit — never the service-identity fallback.
    // Kept consistent with SubmitMeetingLink / ListSubmissions so the endpoint
    // fails closed even if the SWA linked-backend boundary is ever misconfigured.
    const actor = await actorResolver.resolve(request);
    if (actor?.type !== "user" || !actor.subject) {
      return json(401, { error: { code: "unauthenticated", message: "Sign in to submit a transcript." } });
    }

    try {
      const contentType = request.headers?.get?.("content-type") || "";
      if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
        throw new SubmissionValidationError("The request must use multipart/form-data.", 400, "invalid_multipart");
      }
      let form;
      try {
        form = await request.formData();
      } catch {
        throw new SubmissionValidationError("The multipart request could not be parsed.", 400, "invalid_multipart");
      }
      const projectName = form.get("projectName");
      const file = form.get("file");
      if (!file || typeof file.arrayBuffer !== "function") {
        throw new SubmissionValidationError("A transcript file is required.", 400, "file_required");
      }

      const result = await service.submit({
        projectName,
        fileName: file.name,
        bytes: Buffer.from(await file.arrayBuffer()),
        actor,
      });
      context?.log?.(`[TIGER] Transcript submission accepted requestId=${result.requestId}`);
      return json(202, result);
    } catch (error) {
      if (error instanceof SubmissionValidationError) {
        return json(error.status, { error: { code: error.code, message: error.message } });
      }
      context?.error?.(`[TIGER] Transcript submission failed: ${error.message}`);
      return json(503, {
        error: {
          code: "submission_unavailable",
          message: "The transcript could not be submitted. Please try again.",
        },
      });
    }
  };
}

function createDefaultService() {
  const accountName = process.env.TRANSCRIPT_STORAGE_ACCOUNT;
  const containerName = process.env.TRANSCRIPT_STORAGE_CONTAINER || DEFAULT_CONTAINER;
  return createSubmissionService({
    accountName,
    containerName,
    storage: createSubmissionStorage({ accountName, containerName }),
    queue: createSubmissionQueue(),
    // History persistence is optional — only when Cosmos is configured.
    store: process.env.COSMOS_ENDPOINT ? createSubmissionStore() : null,
  });
}

// Memoize the handler (and its Blob/Queue/Cosmos clients + managed-identity
// credential) at module scope so they are reused across invocations instead of
// rebuilt — and re-authenticated to IMDS — on every request.
let _handler = null;
function getHandler() {
  if (!_handler) _handler = createSubmitTranscriptHandler({ service: createDefaultService() });
  return _handler;
}

// authLevel is "anonymous" because this app sits behind Static Web Apps: SWA
// forwards the trusted `x-ms-client-principal` header but does NOT inject a
// function key (that is a SWA managed-functions behaviour, not a linked-backend
// one). The trust boundary is the auto-provisioned "Azure Static Web Apps
// (Linked)" EasyAuth provider on this app, which rejects any request not proxied
// through SWA — verified post-deploy (infra/scripts/portal-post-deploy.sh §2).
// Identity is resolved by the actor resolver, never from request fields.
app.http("SubmitTranscript", {
  methods: ["POST"],
  route: "v1/submissions",
  authLevel: "anonymous",
  handler: (request, context) => getHandler()(request, context),
});

module.exports = { createSubmitTranscriptHandler, createDefaultService };
