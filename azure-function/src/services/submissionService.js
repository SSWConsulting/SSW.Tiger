const crypto = require("crypto");
const {
  slugifyProjectName,
  sanitizeOriginalFileName,
  decodeAndValidateVtt,
  createCanonicalFileName,
} = require("./submissionValidation");
const { DEFAULT_CONTAINER } = require("./submissionStorage");

function createSubmissionService({ storage, queue, accountName, containerName = DEFAULT_CONTAINER, now = () => new Date(), randomUUID = crypto.randomUUID } = {}) {
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

      await storage.upload(blobName, normalizedBytes, {
        requestid: requestId,
        projectslug: project.slug,
        originalfilename: originalFileName,
      });

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
        actor: actor || { type: "service", subject: "function-key", roles: ["submission:create"] },
      };

      try {
        await queue.publish(message);
      } catch (error) {
        try {
          await storage.deleteIfExists(blobName);
        } catch {
          // Best effort cleanup; never replace the queue error or log transcript data.
        }
        throw error;
      }

      return { requestId, status: "accepted" };
    },
  };
}

module.exports = { createSubmissionService };
