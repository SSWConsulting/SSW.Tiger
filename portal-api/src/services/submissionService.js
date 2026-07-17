const crypto = require("crypto");
const {
  slugifyProjectName,
  sanitizeOriginalFileName,
  decodeAndValidateVtt,
  createCanonicalFileName,
} = require("./submissionValidation");
const { DEFAULT_CONTAINER } = require("./submissionStorage");

// store is optional: when Cosmos isn't configured (local/tests) the submission
// still succeeds, it just doesn't get a history record.
function createSubmissionService({
  storage,
  queue,
  store = null,
  accountName,
  containerName = DEFAULT_CONTAINER,
  now = () => new Date(),
  randomUUID = crypto.randomUUID,
} = {}) {
  if (!storage || !queue) throw new Error("Submission storage and queue are required");

  return {
    async submit({ projectName, fileName, bytes, actor }) {
      const project = slugifyProjectName(projectName);
      const content = decodeAndValidateVtt(bytes, fileName);
      const requestId = randomUUID();
      const submittedAt = now();
      const canonicalFileName = createCanonicalFileName(submittedAt, requestId);
      const blobName = `submissions/${requestId}/${canonicalFileName}`;
      const originalFileName = sanitizeOriginalFileName(fileName);
      const normalizedBytes = Buffer.from(content, "utf8");
      const resolvedActor = actor || {
        type: "service",
        subject: "function-key",
        email: null,
        roles: ["submission:create"],
      };

      await storage.upload(blobName, normalizedBytes, {
        requestid: requestId,
        projectslug: project.slug,
        originalfilename: originalFileName,
      });

      // History record (owner + status) — written before the queue publish so a
      // publish failure can roll it back alongside the blob.
      if (store) {
        const submittedAtIso = submittedAt.toISOString();
        try {
          await store.create({
            id: requestId,
            type: "submission",
            projectName: project.slug,
            requestId,
            displayName: project.displayName,
            userSubject: resolvedActor.subject,
            userEmail: resolvedActor.email || null,
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
        actor: resolvedActor,
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
