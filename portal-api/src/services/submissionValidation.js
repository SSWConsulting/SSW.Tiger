const path = require("node:path");
const crypto = require("node:crypto");

const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024;
const VTT_CUE_PATTERN = /^\s*(?:\d{2}:)?\d{2}:\d{2}\.\d{3}\s+-->\s+(?:\d{2}:)?\d{2}:\d{2}\.\d{3}(?:\s|$)/m;

class SubmissionValidationError extends Error {
  constructor(message, status = 400, code = "invalid_submission") {
    super(message);
    this.name = "SubmissionValidationError";
    this.status = status;
    this.code = code;
  }
}

function slugifyProjectName(value) {
  const name = String(value || "").trim();
  if (!name) {
    throw new SubmissionValidationError("Project name is required.", 400, "project_required");
  }
  if (name.length > 100) {
    throw new SubmissionValidationError("Project name must be 100 characters or fewer.", 400, "project_too_long");
  }

  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  if (!slug) {
    throw new SubmissionValidationError(
      "Project name must contain at least one letter or number.",
      400,
      "project_invalid",
    );
  }
  return { displayName: name, slug };
}

function sanitizeOriginalFileName(value) {
  const base = path.basename(String(value || "transcript.vtt"));
  return (
    base
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — strip control chars from an untrusted filename before it is stored/echoed.
      .replace(/[\x00-\x1f\x7f]/g, "")
      .replace(/[^a-zA-Z0-9._ -]/g, "_")
      .slice(0, 120) || "transcript.vtt"
  );
}

function decodeAndValidateVtt(buffer, fileName) {
  if (!fileName || path.extname(fileName).toLowerCase() !== ".vtt") {
    throw new SubmissionValidationError("Only .vtt transcript files are supported.", 400, "invalid_file_type");
  }
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || []);
  if (buffer.length === 0) {
    throw new SubmissionValidationError("The transcript file is empty.", 400, "empty_file");
  }
  if (buffer.length > MAX_TRANSCRIPT_BYTES) {
    throw new SubmissionValidationError("The transcript must be 10 MB or smaller.", 413, "file_too_large");
  }

  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new SubmissionValidationError("The transcript must be valid UTF-8 text.", 400, "invalid_encoding");
  }

  const withoutBom = content.replace(/^\uFEFF/, "");
  if (!withoutBom.startsWith("WEBVTT")) {
    throw new SubmissionValidationError("The transcript must start with WEBVTT.", 400, "invalid_vtt");
  }
  const boundary = withoutBom.charAt(6);
  if (boundary && !/[\r\n \t]/.test(boundary)) {
    throw new SubmissionValidationError("The transcript has an invalid WEBVTT header.", 400, "invalid_vtt");
  }
  if (!VTT_CUE_PATTERN.test(withoutBom)) {
    throw new SubmissionValidationError(
      "The transcript must contain at least one valid WEBVTT cue.",
      400,
      "invalid_vtt",
    );
  }
  return withoutBom;
}

function createCanonicalFileName(now = new Date(), requestId = "") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const suffix = requestId ? `-${crypto.createHash("sha256").update(requestId).digest("hex").slice(0, 8)}` : "";
  return `${values.year}-${values.month}-${values.day}-${values.hour}${values.minute}${values.second}${suffix}.vtt`;
}

module.exports = {
  MAX_TRANSCRIPT_BYTES,
  SubmissionValidationError,
  slugifyProjectName,
  sanitizeOriginalFileName,
  decodeAndValidateVtt,
  createCanonicalFileName,
};
