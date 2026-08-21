const crypto = require("node:crypto");
const {
  slugifyProjectName,
  sanitizeOriginalFileName,
  decodeAndValidateVtt,
  createCanonicalFileName,
} = require("./submissionValidation");
const { DEFAULT_BLOB_CONTAINER } = require("./submissionStorage");

// store is optional: when Cosmos isn't configured (local/tests) the submission
// still succeeds, it just doesn't get a history record.
function createSubmissionService({
  storage,
  queue,
  store = null,
  accountName,
  containerName = DEFAULT_BLOB_CONTAINER,
  now = () => new Date(),
  randomUUID = crypto.randomUUID,
} = {}) {
  if (!storage || !queue) throw new Error("Submission storage and queue are required");

  return {
    async submit({ projectName, fileName, bytes, actor }) {
      // Programming-error guard, not user input: every caller resolves a signed-in
      // actor first (SubmitTranscript returns 401 otherwise). Without this a missing
      // actor would surface as a TypeError on actor.subject far below, which the
      // handler turns into an opaque 503.
      if (!actor?.subject) throw new Error("An authenticated actor is required");
      const project = slugifyProjectName(projectName);
      const content = decodeAndValidateVtt(bytes, fileName);
      const requestId = randomUUID();
      const submittedAt = now();
      const canonicalFileName = createCanonicalFileName(submittedAt, requestId);
      // Path prefix INSIDE the `transcript-submissions` blob container. Unrelated to
      // the Cosmos container also called `submissions` (see submissionStore.js) —
      // three similar names, three different layers.
      const blobName = `submissions/${requestId}/${canonicalFileName}`;
      const originalFileName = sanitizeOriginalFileName(fileName);
      const normalizedBytes = Buffer.from(content, "utf8");

      await storage.upload(blobName, normalizedBytes, {
        requestid: requestId,
        projectslug: project.slug,
        originalfilename: originalFileName,
      });

      // History record (owner + status) — written before the queue publish so a
      // publish failure can roll it back alongside the blob.
      // KNOWN LIMITATION: a hard process kill (host recycle/OOM) between create
      // and a successful publish can leave an orphan "accepted" record with no
      // queue message. Rare; the intended remedy is a periodic reconciliation
      // sweep (stale "accepted" > N min → "failed"), not in scope here.
      if (store) {
        const submittedAtIso = submittedAt.toISOString();
        try {
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
        } catch (error) {
          try {
            await storage.deleteIfExists(blobName);
          } catch {
            /* best effort */
          }
          throw error;
        }
      }

      const message = {
        schemaVersion: 2,
        requestId,
        sourceType: "uploadedTranscript",
        submittedAt: submittedAt.toISOString(),
        project,
        source: {
          storageAccount: accountName,
          containerName,
          blobName,
          fileName: canonicalFileName,
          originalFileName,
        },
        actor,
      };

      try {
        await queue.publish(message);
      } catch (error) {
        try {
          await storage.deleteIfExists(blobName);
        } catch {
          // Best effort cleanup; never replace the queue error or log transcript data.
        }
        if (store) {
          try {
            await store.deleteIfExists(requestId, project.slug);
          } catch {
            /* best effort */
          }
        }
        throw error;
      }

      return { requestId, status: "accepted" };
    },
  };
}

module.exports = { createSubmissionService };
