const { BlobServiceClient } = require("@azure/storage-blob");
const { DefaultAzureCredential } = require("@azure/identity");

const DEFAULT_CONTAINER = "transcript-submissions";

function createSubmissionStorage({ accountName, containerName = DEFAULT_CONTAINER, credential } = {}) {
  const resolvedAccount = accountName || process.env.TRANSCRIPT_STORAGE_ACCOUNT;
  if (!resolvedAccount) throw new Error("TRANSCRIPT_STORAGE_ACCOUNT is not configured");
  const service = new BlobServiceClient(
    `https://${resolvedAccount}.blob.core.windows.net`,
    credential || new DefaultAzureCredential(),
  );
  const container = service.getContainerClient(containerName);

  return {
    async upload(blobName, buffer, metadata) {
      const blob = container.getBlockBlobClient(blobName);
      await blob.uploadData(buffer, {
        blobHTTPHeaders: { blobContentType: "text/vtt; charset=utf-8" },
        metadata,
        conditions: { ifNoneMatch: "*" },
      });
    },
    async deleteIfExists(blobName) {
      await container.getBlockBlobClient(blobName).deleteIfExists();
    },
  };
}

module.exports = { DEFAULT_CONTAINER, createSubmissionStorage };
