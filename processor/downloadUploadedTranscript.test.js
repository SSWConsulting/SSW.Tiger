const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs").promises;
const os = require("os");
const path = require("path");
const { readConfig, validateDownloadedVtt, downloadUploadedTranscript } = require("./downloadUploadedTranscript");

const baseEnv = {
  TRANSCRIPT_STORAGE_ACCOUNT: "satiger",
  TRANSCRIPT_STORAGE_CONTAINER: "transcript-submissions",
  TRANSCRIPT_BLOB_NAME: "submissions/r1/2026-07-17-110203-a1b2c3d4.vtt",
  UPLOAD_FILENAME: "2026-07-17-110203-a1b2c3d4.vtt",
  UPLOAD_REQUEST_ID: "r1",
  UPLOAD_PROJECT_NAME: "Tiger Portal",
  UPLOAD_PROJECT_SLUG: "tiger-portal",
};

test("validates uploaded source configuration", () => {
  assert.equal(readConfig(baseEnv).projectSlug, "tiger-portal");
  assert.equal(readConfig({ ...baseEnv, UPLOAD_FILENAME: "2026-07-17-110203.vtt" }).fileName, "2026-07-17-110203.vtt");
  assert.throws(() => readConfig({ ...baseEnv, UPLOAD_FILENAME: "../bad.vtt" }), /canonical/);
  assert.throws(() => readConfig({ ...baseEnv, UPLOAD_PROJECT_SLUG: "Bad Slug" }), /slug/);
});

test("strictly validates the downloaded bytes", () => {
  assert.equal(validateDownloadedVtt(Buffer.from("WEBVTT\n\n00:00.000 --> 00:01.000\nhello")).startsWith("WEBVTT"), true);
  assert.throws(() => validateDownloadedVtt(Buffer.from([0xc3, 0x28])), /UTF-8/);
  assert.throws(() => validateDownloadedVtt(Buffer.from("hello")), /WEBVTT/);
  assert.throws(() => validateDownloadedVtt(Buffer.from("WEBVTT\n\nnotes only")), /cue/);
});

test("downloads to the canonical processor filename and returns Graph-compatible shape", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tiger-upload-"));
  const bytes = Buffer.from("WEBVTT\n\n00:00.000 --> 00:01.000\nHello");
  const client = {
    getContainerClient: () => ({
      getBlockBlobClient: () => ({
        getProperties: async () => ({ contentLength: bytes.length }),
        downloadToBuffer: async () => bytes,
      }),
    }),
  };
  const result = await downloadUploadedTranscript({ env: { ...baseEnv, OUTPUT_PATH: path.join(dir, baseEnv.UPLOAD_FILENAME) }, blobServiceClient: client });
  assert.equal(result.projectName, "tiger-portal");
  assert.deepEqual(result.participants, []);
  assert.equal(await fs.readFile(result.transcriptPath, "utf8"), bytes.toString());
});
