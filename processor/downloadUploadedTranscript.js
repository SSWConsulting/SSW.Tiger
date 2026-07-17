#!/usr/bin/env node

const fs = require("fs").promises;
const path = require("path");
const { BlobServiceClient } = require("@azure/storage-blob");
const { DefaultAzureCredential } = require("@azure/identity");
const { log } = require("../lib/logger");

const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024;
const FILE_NAME_PATTERN = /^(\d{4}-\d{2}-\d{2})-(\d{6})(?:-([a-f0-9]{8}))?\.vtt$/;
const VTT_CUE_PATTERN = /^\s*(?:\d{2}:)?\d{2}:\d{2}\.\d{3}\s+-->\s+(?:\d{2}:)?\d{2}:\d{2}\.\d{3}(?:\s|$)/m;

function readConfig(env = process.env) {
  const config = {
    accountName: env.TRANSCRIPT_STORAGE_ACCOUNT,
    containerName: env.TRANSCRIPT_STORAGE_CONTAINER,
    blobName: env.TRANSCRIPT_BLOB_NAME,
    fileName: env.UPLOAD_FILENAME,
    requestId: env.UPLOAD_REQUEST_ID,
    projectName: env.UPLOAD_PROJECT_NAME,
    projectSlug: env.UPLOAD_PROJECT_SLUG,
    outputDir: env.OUTPUT_PATH ? path.dirname(env.OUTPUT_PATH) : path.join(process.cwd(), "dropzone"),
  };
  const missing = Object.entries(config)
    .filter(([key, value]) => key !== "outputDir" && !value)
    .map(([key]) => key);
  if (missing.length) throw new Error(`Missing uploaded transcript configuration: ${missing.join(", ")}`);
  if (!FILE_NAME_PATTERN.test(config.fileName) || path.basename(config.fileName) !== config.fileName) {
    throw new Error("Invalid canonical uploaded transcript filename");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.projectSlug)) {
    throw new Error("Invalid uploaded transcript project slug");
  }
  return config;
}

function validateDownloadedVtt(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || []);
  if (!buffer.length) throw new Error("Uploaded transcript is empty");
  if (buffer.length > MAX_TRANSCRIPT_BYTES) throw new Error("Uploaded transcript exceeds 10 MB");
  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^\uFEFF/, "");
  } catch {
    throw new Error("Uploaded transcript is not valid UTF-8");
  }
  if (!content.startsWith("WEBVTT") || (content.charAt(6) && !/[\r\n \t]/.test(content.charAt(6)))) {
    throw new Error("Uploaded transcript does not have a valid WEBVTT header");
  }
  if (!VTT_CUE_PATTERN.test(content)) {
    throw new Error("Uploaded transcript does not contain a valid WEBVTT cue");
  }
  return content;
}

async function downloadUploadedTranscript({ env = process.env, credential, blobServiceClient } = {}) {
  const config = readConfig(env);
  const service = blobServiceClient || new BlobServiceClient(
    `https://${config.accountName}.blob.core.windows.net`,
    credential || new DefaultAzureCredential(),
  );
  const blob = service.getContainerClient(config.containerName).getBlockBlobClient(config.blobName);
  const properties = await blob.getProperties();
  if (properties.contentLength > MAX_TRANSCRIPT_BYTES) throw new Error("Uploaded transcript exceeds 10 MB");
  const buffer = await blob.downloadToBuffer();
  const content = validateDownloadedVtt(buffer);

  await fs.mkdir(config.outputDir, { recursive: true });
  const transcriptPath = env.OUTPUT_PATH || path.join(config.outputDir, config.fileName);
  await fs.writeFile(transcriptPath, content, "utf8");
  const match = config.fileName.match(FILE_NAME_PATTERN);

  return {
    success: true,
    transcriptPath,
    projectName: config.projectSlug,
    displayName: config.projectName,
    meetingDate: match[1],
    filename: config.fileName,
    meetingSubject: `${config.projectName} - Uploaded transcript`,
    participants: [],
    invitees: [],
    meetingDuration: "",
    vttInfo: {},
    requestId: config.requestId,
  };
}

async function main() {
  try {
    const result = await downloadUploadedTranscript();
    console.log(JSON.stringify(result));
  } catch (error) {
    log("error", "Failed to download uploaded transcript", { error: error.message });
    console.log(JSON.stringify({ error: true, message: error.message }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { MAX_TRANSCRIPT_BYTES, readConfig, validateDownloadedVtt, downloadUploadedTranscript };
