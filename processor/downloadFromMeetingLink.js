#!/usr/bin/env node

// Resolve a Teams meeting JOIN URL to its transcript and save it for the
// pipeline. Runs in the Container App Job (which already has Graph credentials),
// so the Portal API stays Graph-free — it only validates the link format and
// enqueues. The webhook `graphTranscript` path is untouched.
//
// Env:
//   MEETING_JOIN_URL, MEETING_ORGANIZER_ID  - the link + parsed organizer (Oid)
//   UPLOAD_REQUEST_ID, UPLOAD_PROJECT_NAME, UPLOAD_PROJECT_SLUG - shared history + project
//   GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET - app-only Graph
//   OUTPUT_PATH (optional)

const fs = require("node:fs").promises;
const path = require("node:path");
const crypto = require("node:crypto");
const { log } = require("../lib/logger");
const { validateDownloadedVtt, detectVttSpeakers } = require("./downloadUploadedTranscript");

function readConfig(env = process.env) {
  const config = {
    joinUrl: env.MEETING_JOIN_URL,
    organizerId: env.MEETING_ORGANIZER_ID,
    requestId: env.UPLOAD_REQUEST_ID,
    projectName: env.UPLOAD_PROJECT_NAME,
    projectSlug: env.UPLOAD_PROJECT_SLUG,
    tenantId: env.GRAPH_TENANT_ID,
    clientId: env.GRAPH_CLIENT_ID,
    clientSecret: env.GRAPH_CLIENT_SECRET,
    outputDir: env.OUTPUT_PATH ? path.dirname(env.OUTPUT_PATH) : path.join(process.cwd(), "dropzone"),
  };
  const required = ["joinUrl", "requestId", "projectName", "projectSlug", "tenantId", "clientId", "clientSecret"];
  const missing = required.filter((key) => !config[key]);
  if (missing.length) throw new Error(`Missing meeting link configuration: ${missing.join(", ")}`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.projectSlug)) {
    throw new Error("Invalid meeting link project slug");
  }
  return config;
}

// Extract the organizer (Oid) + tenant (Tid) from a Teams meeting join URL's
// `context` param. Mirrors TriggerProcessing.parseJoinUrl.
function parseJoinUrl(joinUrl) {
  let url;
  try {
    url = new URL(joinUrl);
  } catch {
    return { error: "The meeting link is not a valid URL." };
  }
  if (!url.hostname.includes("teams.microsoft.com") && !url.hostname.includes("teams.live.com")) {
    return { error: "That is not a Teams meeting link." };
  }
  const contextParam = url.searchParams.get("context");
  if (!contextParam) {
    return { error: "The meeting link is missing meeting info — copy the full link from Teams." };
  }
  let context;
  try {
    context = JSON.parse(contextParam);
  } catch {
    return { error: "The meeting link could not be parsed." };
  }
  if (!context.Oid) return { error: "The meeting link does not identify the organizer." };
  return { userId: context.Oid, tenantId: context.Tid };
}

function canonicalFileName(createdDateTime, requestId) {
  const now = createdDateTime ? new Date(createdDateTime) : new Date();
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
  const v = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const suffix = requestId ? `-${crypto.createHash("sha256").update(requestId).digest("hex").slice(0, 8)}` : "";
  return `${v.year}-${v.month}-${v.day}-${v.hour}${v.minute}${v.second}${suffix}.vtt`;
}

// Default Graph client (client-credentials). Injectable for tests.
function createGraphClient(config, fetchImpl = fetch) {
  async function token() {
    const response = await fetchImpl(`https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }).toString(),
    });
    if (!response.ok) throw new Error(`Failed to acquire Graph token: ${response.status}`);
    return (await response.json()).access_token;
  }
  async function get(accessToken, url, accept) {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}`, ...(accept ? { Accept: accept } : {}) },
    });
    if (!response.ok) throw new Error(`Graph request failed: ${response.status}`);
    return response;
  }
  return {
    token,
    async findMeeting(accessToken, userId, joinUrl) {
      const escaped = joinUrl.replace(/'/g, "''");
      const url = `https://graph.microsoft.com/v1.0/users/${userId}/onlineMeetings?$filter=JoinWebUrl eq '${escaped}'`;
      const body = await (await get(accessToken, url)).json();
      return body.value?.[0] || null;
    },
    async latestTranscript(accessToken, userId, meetingId) {
      const url = `https://graph.microsoft.com/v1.0/users/${userId}/onlineMeetings/${meetingId}/transcripts`;
      const body = await (await get(accessToken, url)).json();
      const transcripts = body.value || [];
      if (!transcripts.length) return null;
      return transcripts.sort((a, b) => new Date(b.createdDateTime) - new Date(a.createdDateTime))[0];
    },
    async content(accessToken, userId, meetingId, transcriptId) {
      const url = `https://graph.microsoft.com/v1.0/users/${userId}/onlineMeetings/${meetingId}/transcripts/${transcriptId}/content?$format=text/vtt`;
      return (await get(accessToken, url, "text/vtt")).text();
    },
  };
}

async function downloadFromMeetingLink({ env = process.env, graph } = {}) {
  const config = readConfig(env);
  const parsed = parseJoinUrl(config.joinUrl);
  if (parsed.error) throw new Error(parsed.error);
  const userId = config.organizerId || parsed.userId;

  const client = graph || createGraphClient(config);
  const token = await client.token();
  const meeting = await client.findMeeting(token, userId, config.joinUrl);
  if (!meeting) throw new Error("No meeting was found for that link (check it is from this tenant).");
  const transcript = await client.latestTranscript(token, userId, meeting.id);
  if (!transcript)
    throw new Error("No transcript is available for this meeting yet. Try again after Teams has processed it.");

  const rawContent = await client.content(token, userId, meeting.id, transcript.id);
  const content = validateDownloadedVtt(Buffer.from(rawContent, "utf8"));

  const filename = canonicalFileName(transcript.createdDateTime, config.requestId);
  await fs.mkdir(config.outputDir, { recursive: true });
  const transcriptPath = env.OUTPUT_PATH || path.join(config.outputDir, filename);
  await fs.writeFile(transcriptPath, content, "utf8");

  return {
    success: true,
    transcriptPath,
    projectName: config.projectSlug,
    displayName: config.projectName,
    meetingDate: filename.slice(0, 10),
    filename,
    meetingSubject: meeting.subject
      ? `${config.projectName} - ${meeting.subject}`
      : `${config.projectName} - Meeting link`,
    participants: [],
    invitees: [],
    meetingDuration: "",
    vttInfo: detectVttSpeakers(content),
    requestId: config.requestId,
  };
}

async function main() {
  try {
    const result = await downloadFromMeetingLink();
    console.log(JSON.stringify(result));
  } catch (error) {
    log("error", "Failed to download from meeting link", { error: error.message });
    console.log(JSON.stringify({ error: true, message: error.message }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { readConfig, parseJoinUrl, canonicalFileName, createGraphClient, downloadFromMeetingLink };
