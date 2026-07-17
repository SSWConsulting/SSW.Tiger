const { app } = require("@azure/functions");
const crypto = require("node:crypto");
const { json } = require("../http");
const { slugifyProjectName, SubmissionValidationError } = require("../services/submissionValidation");
const { validateMeetingLink } = require("../services/meetingLinkValidation");
const { createSubmissionQueue } = require("../services/submissionQueue");
const { createSubmissionStore } = require("../services/submissionStore");
const { createSubmissionActorResolver } = require("../services/submissionActor");

function createSubmitMeetingLinkHandler({
  queue,
  store = null,
  actorResolver = createSubmissionActorResolver(),
  now = () => new Date(),
  randomUUID = crypto.randomUUID,
} = {}) {
  if (!queue) throw new Error("Submission queue is required");

  return async function submitMeetingLink(request, context) {
    // Only a real signed-in user may submit — never the service-identity fallback.
    const actor = await actorResolver.resolve(request);
    if (actor?.type !== "user" || !actor.subject) {
      return json(401, { error: { code: "unauthenticated", message: "Sign in to submit a meeting link." } });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: { code: "invalid_body", message: "Expected a JSON body." } });
    }

    try {
      const project = slugifyProjectName(body?.projectName);
      const link = validateMeetingLink(body?.meetingLink);
      const requestId = randomUUID();
      const submittedAtIso = now().toISOString();

      if (store) {
        await store.create({
          id: requestId,
          type: "submission",
          projectName: project.slug,
          requestId,
          displayName: project.displayName,
          userSubject: actor.subject,
          userEmail: actor.email || null,
          status: "accepted",
          dashboardUrl: null,
          submittedAt: submittedAtIso,
          updatedAt: submittedAtIso,
        });
      }

      const message = {
        schemaVersion: 2,
        sourceType: "meetingLink",
        requestId,
        submittedAt: submittedAtIso,
        project,
        joinUrl: link.joinUrl,
        organizerId: link.organizerId,
        actor,
      };
      try {
        await queue.publish(message);
      } catch (error) {
        if (store) {
          try {
            await store.deleteIfExists(requestId, project.slug);
          } catch {
            /* best effort */
          }
        }
        throw error;
      }

      context?.log?.(`[TIGER] Meeting link submission accepted requestId=${requestId}`);
      return json(202, { requestId, status: "accepted" });
    } catch (error) {
      if (error instanceof SubmissionValidationError) {
        return json(error.status, { error: { code: error.code, message: error.message } });
      }
      context?.error?.(`[TIGER] Meeting link submission failed: ${error.message}`);
      return json(503, {
        error: {
          code: "submission_unavailable",
          message: "The meeting link could not be submitted. Please try again.",
        },
      });
    }
  };
}

// See SubmitTranscript for the authLevel:"anonymous" + memoization rationale.
let _handler = null;
function getHandler() {
  if (!_handler) {
    _handler = createSubmitMeetingLinkHandler({
      queue: createSubmissionQueue(),
      store: process.env.COSMOS_ENDPOINT ? createSubmissionStore() : null,
    });
  }
  return _handler;
}

app.http("SubmitMeetingLink", {
  methods: ["POST"],
  route: "v1/meetings",
  authLevel: "anonymous",
  handler: (request, context) => getHandler()(request, context),
});

module.exports = { createSubmitMeetingLinkHandler };
