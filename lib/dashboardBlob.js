let _serviceClient = null;

const DASHBOARD_HTML_CACHE_CONTROL =
  "no-cache, max-age=0, must-revalidate";

function dashboardHtmlHttpHeaders() {
  return {
    blobContentType: "text/html; charset=utf-8",
    blobCacheControl: DASHBOARD_HTML_CACHE_CONTROL,
  };
}

function getBlobServiceClient() {
  if (_serviceClient) return _serviceClient;

  const accountName = process.env.DASHBOARD_STORAGE_ACCOUNT;
  if (!accountName) {
    throw new Error("DASHBOARD_STORAGE_ACCOUNT is required");
  }

  let BlobServiceClient;
  let DefaultAzureCredential;
  try {
    ({ BlobServiceClient } = require("@azure/storage-blob"));
    ({ DefaultAzureCredential } = require("@azure/identity"));
  } catch {
    throw new Error(
      "Missing Azure Blob dependencies. Install @azure/storage-blob and @azure/identity.",
    );
  }

  _serviceClient = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    new DefaultAzureCredential(),
  );
  return _serviceClient;
}

function getWebContainerClient() {
  return getBlobServiceClient().getContainerClient("$web");
}

function dashboardBlobName(projectName, meetingId) {
  return `${projectName}/${meetingId}/index.html`;
}

async function downloadDashboardHtml(projectName, meetingId) {
  const blob = getWebContainerClient().getBlockBlobClient(
    dashboardBlobName(projectName, meetingId),
  );
  const response = await blob.download();
  return streamToString(response.readableStreamBody);
}

async function uploadDashboardHtml(projectName, meetingId, html) {
  const blob = getWebContainerClient().getBlockBlobClient(
    dashboardBlobName(projectName, meetingId),
  );
  await blob.upload(html, Buffer.byteLength(html), {
    blobHTTPHeaders: dashboardHtmlHttpHeaders(),
  });
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

module.exports = {
  DASHBOARD_HTML_CACHE_CONTROL,
  dashboardHtmlHttpHeaders,
  dashboardBlobName,
  downloadDashboardHtml,
  uploadDashboardHtml,
};
