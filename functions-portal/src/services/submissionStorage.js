const { BlobServiceClient } = require("@azure/storage-blob");
const { getDataPlaneCredential } = require("./credential");

const DEFAULT_BLOB_CONTAINER = "transcript-submissions";

/**
 * Local-dev seam, mirroring createSubmissionQueue's connection-string support.
 *
 * Deployed apps authenticate with the shared user-assigned managed identity, which
 * holds Storage Blob Data Contributor scoped to this container (infra/modules/
 * storage.bicep). A developer with only control-plane Contributor cannot write
 * blobs that way — Contributor grants no data-plane access and cannot self-assign
 * it — but it CAN read the account key (or mint a SAS), which bypasses data-plane
 * RBAC. TRANSCRIPT_STORAGE_CONNECTION exists for exactly that case.
 *
 * ⚠️ Deliberately its OWN variable: do NOT fall back to AzureWebJobsStorage. That
 * one IS set in production (portalApiApp.bicep injects it with an account key for
 * the Functions runtime), so falling back to it would silently downgrade every
 * deployed blob write from managed identity to a long-lived account key.
 */
function createSubmissionStorage({
  accountName,
  containerName = DEFAULT_BLOB_CONTAINER,
  credential,
  connectionString,
} = {}) {
  const resolvedConnection = connectionString || process.env.TRANSCRIPT_STORAGE_CONNECTION;
  let service;
  if (resolvedConnection) {
    service = BlobServiceClient.fromConnectionString(resolvedConnection);
  } else {
    const resolvedAccount = accountName || process.env.TRANSCRIPT_STORAGE_ACCOUNT;
    if (!resolvedAccount) throw new Error("TRANSCRIPT_STORAGE_ACCOUNT is not configured");
    service = new BlobServiceClient(
      `https://${resolvedAccount}.blob.core.windows.net`,
      credential || getDataPlaneCredential(),
    );
  }
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

module.exports = { DEFAULT_BLOB_CONTAINER, createSubmissionStorage };
