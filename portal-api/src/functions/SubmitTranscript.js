const { app } = require("@azure/functions");
const { createSubmissionStorage, DEFAULT_CONTAINER } = require("../services/submissionStorage");
const { createSubmissionQueue } = require("../services/submissionQueue");
const { createSubmissionService } = require("../services/submissionService");
const { createSubmissionStore } = require("../services/submissionStore");
const { MAX_TRANSCRIPT_BYTES, SubmissionValidationError } = require("../services/submissionValidation");
const { createSubmissionActorResolver } = require("../services/submissionActor");

function json(status, body) {
  return {
    status,
    jsonBody: body,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  };
}

function createSubmitTranscriptHandler({ service, actorResolver = createSubmissionActorResolver() } = {}) {
  return async function submitTranscript(request, context) {
    const contentLength = Number(request.headers?.get?.("content-length") || 0);
    if (contentLength > MAX_TRANSCRIPT_BYTES + 1024 * 1024) {
      return json(413, { error: { code: "file_too_large", message: "The transcript must be 10 MB or smaller." } });
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

      const actor = await actorResolver.resolve(request);
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

// authLevel is "anonymous" because this app sits behind Static Web Apps: SWA
// forwards the trusted `x-ms-client-principal` header but does NOT inject a
// function key (that is a SWA managed-functions behaviour, not a linked-backend
// one). The trust boundary is enforced at the platform level — the app must be
// reachable ONLY via SWA (access restrictions) so the principal header can't be
// forged by a direct caller. Identity is resolved by the actor resolver, never
// from request fields.
app.http("SubmitTranscript", {
  methods: ["POST"],
  route: "v1/submissions",
  authLevel: "anonymous",
  handler: async (request, context) =>
    createSubmitTranscriptHandler({ service: createDefaultService() })(request, context),
});

module.exports = { createSubmitTranscriptHandler, createDefaultService };
