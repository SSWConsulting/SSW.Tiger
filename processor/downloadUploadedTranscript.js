#!/usr/bin/env node

const fs = require("node:fs").promises;
const path = require("node:path");
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
    connectionString: env.TRANSCRIPT_STORAGE_CONNECTION,
    outputDir: env.OUTPUT_PATH ? path.dirname(env.OUTPUT_PATH) : path.join(process.cwd(), "dropzone"),
  };
  // Explicit required list (matches downloadFromMeetingLink.readConfig) rather than
  // "everything except outputDir" — adding an optional field must not make it required.
  const required = ["containerName", "blobName", "fileName", "requestId", "projectName", "projectSlug"];
  const missing = required.filter((key) => !config[key]);
  if (missing.length) throw new Error(`Missing uploaded transcript configuration: ${missing.join(", ")}`);
  // accountName is only needed for the managed-identity path; a connection string
  // carries its own BlobEndpoint.
  if (!config.accountName && !config.connectionString) {
    throw new Error("Missing uploaded transcript configuration: accountName");
  }
  if (!FILE_NAME_PATTERN.test(config.fileName) || path.basename(config.fileName) !== config.fileName) {
    throw new Error("Invalid canonical uploaded transcript filename");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.projectSlug)) {
    throw new Error("Invalid uploaded transcript project slug");
  }
  return config;
}

/**
 * Detect <v> speaker labels in the uploaded VTT. Mirrors detectVttSpeakerLabels
 * in downloadTranscript.js so uploaded transcripts get the same boardroom /
 * profile-photo handling. The Graph path derives this from the meeting; the
 * upload path has no meeting object, so we recompute it from the VTT text.
 * @returns {{hasSpeakerLabels: boolean, taggedSpeakerCount: number, taggedSpeakers: string[]}}
 */
function detectVttSpeakers(content) {
  const speakerMatches = content.match(/<v ([^>]+)>/g);
  if (!speakerMatches || speakerMatches.length === 0) {
    return { hasSpeakerLabels: false, taggedSpeakerCount: 0, taggedSpeakers: [] };
  }
  const taggedSpeakers = [...new Set(speakerMatches.map((m) => m.replace(/<v ([^>]+)>/, "$1")))];
  return { hasSpeakerLabels: true, taggedSpeakerCount: taggedSpeakers.length, taggedSpeakers };
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
  // Same local-dev seam as functions-portal/src/services/submissionStorage.js — see the
  // rationale there. In Azure the Job uses its managed identity; a developer with
  // only control-plane Contributor supplies an account-key/SAS connection string.
  const service =
    blobServiceClient ||
    (config.connectionString
      ? BlobServiceClient.fromConnectionString(config.connectionString)
      : new BlobServiceClient(
          `https://${config.accountName}.blob.core.windows.net`,
          credential || new DefaultAzureCredential(),
        ));
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
    vttInfo: detectVttSpeakers(content),
    requestId: config.requestId,
  };
}

/**
 * Azure Storage errors are not always self-describing: getProperties() is a HEAD
 * request, and a HEAD response carries no body, so the SDK has nothing to build a
 * message from — a 403 from a missing Blob Data role surfaces as message:"".
 * Always surface statusCode/code so the cause is visible in the Job logs.
 */
function describeError(error) {
  const statusCode = error?.statusCode ?? error?.response?.status;
  const message = error?.message || error?.details?.message || "";
  // error.name only adds information when there is no message — otherwise it is
  // just the noise "code=Error" on every ordinary throw.
  const code = error?.code || (message ? undefined : error?.name);
  const parts = [message, code && `code=${code}`, statusCode && `status=${statusCode}`].filter(Boolean);
  return parts.length ? parts.join(" ") : "Unknown error (no message, code or status)";
}

async function main() {
  try {
    const result = await downloadUploadedTranscript();
    console.log(JSON.stringify(result));
  } catch (error) {
    const message = describeError(error);
    log("error", "Failed to download uploaded transcript", { error: message });
    console.log(JSON.stringify({ error: true, message }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  MAX_TRANSCRIPT_BYTES,
  readConfig,
  validateDownloadedVtt,
  detectVttSpeakers,
  describeError,
  downloadUploadedTranscript,
};
