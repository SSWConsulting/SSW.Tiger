#!/usr/bin/env node

// Resolve a Teams meeting JOIN URL to its transcript and save it for the
// pipeline. Runs in the Container App Job (which already has Graph credentials),
// so the Portal API stays Graph-free — it only validates the link format and
// enqueues. The webhook `graphTranscript` path is untouched.
//
// Two resolution modes (exactly one is used):
//   A. Long link  — MEETING_JOIN_URL carries context.Oid (the organizer); resolve
//      by JoinWebUrl under that organizer. Works regardless of the submitter.
//   B. Short link / Meeting ID — MEETING_JOIN_MEETING_ID (the numeric joinMeetingId)
//      has NO organizer. Resolve by filtering joinMeetingId under each candidate in
//      MEETING_RESOLVER_USER_IDS (the submitter first, then any attendee email they
//      supplied). Graph's onlineMeetings filter returns a meeting for ANY invited
//      attendee, not just the organizer (verified), so the submitter can resolve a
//      meeting they merely attended. Transcripts are then fetched as the meeting's
//      REAL organizer (read from the resolved meeting), which is always authorized.
//
// Env:
//   MEETING_JOIN_URL, MEETING_ORGANIZER_ID   - mode A: the link + parsed organizer (Oid)
//   MEETING_JOIN_MEETING_ID                  - mode B: numeric joinMeetingId
//   MEETING_RESOLVER_USER_IDS                - mode B: comma-separated user ids/UPNs to try
//   UPLOAD_REQUEST_ID, UPLOAD_PROJECT_NAME, UPLOAD_PROJECT_SLUG - shared history + project
//   GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET - app-only Graph
//   OUTPUT_PATH (optional)

const fs = require("node:fs").promises;
const path = require("node:path");
const crypto = require("node:crypto");
const { log } = require("../lib/logger");
const { validateDownloadedVtt, detectVttSpeakers, describeError } = require("./downloadUploadedTranscript");
const { parseSubject } = require("./parseSubject");

function readConfig(env = process.env) {
  const config = {
    joinUrl: env.MEETING_JOIN_URL,
    organizerId: env.MEETING_ORGANIZER_ID,
    joinMeetingId: env.MEETING_JOIN_MEETING_ID,
    resolverUserIds: (env.MEETING_RESOLVER_USER_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    requestId: env.UPLOAD_REQUEST_ID,
    projectName: env.UPLOAD_PROJECT_NAME,
    projectSlug: env.UPLOAD_PROJECT_SLUG,
    tenantId: env.GRAPH_TENANT_ID,
    clientId: env.GRAPH_CLIENT_ID,
    clientSecret: env.GRAPH_CLIENT_SECRET,
    outputDir: env.OUTPUT_PATH ? path.dirname(env.OUTPUT_PATH) : path.join(process.cwd(), "dropzone"),
  };
  const required = ["requestId", "projectSlug", "tenantId", "clientId", "clientSecret"];
  const missing = required.filter((key) => !config[key]);
  if (missing.length) throw new Error(`Missing meeting link configuration: ${missing.join(", ")}`);
  if (!config.joinUrl && !config.joinMeetingId) {
    throw new Error("Missing meeting link configuration: joinUrl or joinMeetingId");
  }
  if (config.joinMeetingId && !config.resolverUserIds.length) {
    throw new Error("Missing meeting link configuration: resolverUserIds (needed to resolve a Meeting ID)");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.projectSlug)) {
    throw new Error("Invalid meeting link project slug");
  }
  return config;
}

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The meeting's true organizer (used to fetch transcripts — always authorized),
// read from a resolved onlineMeeting's participants. Null if Graph omitted it.
function organizerIdOf(meeting) {
  return meeting?.participants?.organizer?.identity?.user?.id || null;
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

/**
 * Build the Graph `onlineMeetings?$filter=JoinWebUrl eq '...'` URL.
 *
 * Two layers of escaping are required:
 *   1. OData — a single quote inside a string literal is doubled.
 *   2. URL   — the whole $filter expression is a query VALUE, so it must be
 *      encodeURIComponent'd. A join URL carries its own "?"/"&"/"%", which would
 *      otherwise break query parsing: the "?" leaks a second query separator, an
 *      "&" truncates the filter mid-literal, and Graph decodes %3a -> ":" while it
 *      stores the encoded form, so an un-encoded filter never matches.
 *
 * ⚠️ DUPLICATED — azure-function and processor are separate deploy units (only the
 * container image gets lib/), so this cannot be a shared module today. An identical
 * copy lives in azure-function/src/functions/TriggerProcessing.js. Change one, change
 * both; each side has its own regression test asserting the encoded URL shape.
 */
function buildMeetingFilterUrl(userId, joinUrl) {
  const filter = `JoinWebUrl eq '${joinUrl.replace(/'/g, "''")}'`;
  return (
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}` +
    `/onlineMeetings?$filter=${encodeURIComponent(filter)}`
  );
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
  // `what` names the call (findMeeting / latestTranscript / …) and the response body
  // carries Graph's real reason — a bare "Graph request failed: 403" cannot tell
  // "permission not granted to the app" from "Teams application access policy does
  // not cover this user", which need completely different fixes.
  async function get(accessToken, url, accept, what = "request") {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}`, ...(accept ? { Accept: accept } : {}) },
    });
    if (!response.ok) {
      let detail = "";
      let graphCode;
      try {
        const body = await response.text();
        const parsed = JSON.parse(body);
        graphCode = parsed?.error?.code;
        const message = parsed?.error?.message;
        detail = [graphCode, message].filter(Boolean).join(": ") || body.slice(0, 300);
      } catch {
        /* non-JSON or unreadable body — status alone is all we have */
      }
      // Carry the HTTP status + Graph error code on the thrown error so callers can
      // tell apart failures that need different fixes — notably an app-permission
      // problem (403 Authorization_RequestDenied) from a per-user access-policy 403.
      const error = new Error(`Graph ${what} failed: ${response.status}${detail ? ` — ${detail}` : ""}`);
      error.status = response.status;
      error.graphCode = graphCode;
      throw error;
    }
    return response;
  }
  return {
    token,
    // /users/{id}/onlineMeetings requires the OBJECT ID under app-only auth — Graph
    // rejects a UPN with "The userId in request URL is not a valid GUID". The portal
    // can only collect email addresses, so resolve them here. Needs User.Read.All.
    async resolveUserId(accessToken, idOrUpn) {
      if (GUID_PATTERN.test(idOrUpn)) return idOrUpn;
      const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(idOrUpn)}?$select=id`;
      const body = await (await get(accessToken, url, undefined, `resolveUserId(${idOrUpn})`)).json();
      if (!body?.id) throw new Error(`Graph returned no object id for ${idOrUpn}`);
      return body.id;
    },
    async findMeeting(accessToken, userId, joinUrl) {
      const body = await (await get(accessToken, buildMeetingFilterUrl(userId, joinUrl))).json();
      return body.value?.[0] || null;
    },
    // Resolve a meeting by its numeric joinMeetingId under `userId`'s onlineMeetings.
    // `userId` need NOT be the organizer — any invited attendee's collection returns
    // the meeting, which is what lets the submitter resolve a meeting they attended.
    async findMeetingByJoinMeetingId(accessToken, userId, joinMeetingId) {
      const filter = `joinMeetingIdSettings/joinMeetingId eq '${String(joinMeetingId).replace(/'/g, "''")}'`;
      const url =
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}` +
        `/onlineMeetings?$filter=${encodeURIComponent(filter)}`;
      const body = await (await get(accessToken, url)).json();
      return body.value?.[0] || null;
    },
    async latestTranscript(accessToken, userId, meetingId) {
      const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`;
      const body = await (await get(accessToken, url)).json();
      const transcripts = body.value || [];
      if (!transcripts.length) return null;
      return transcripts.sort((a, b) => new Date(b.createdDateTime) - new Date(a.createdDateTime))[0];
    },
    async content(accessToken, userId, meetingId, transcriptId) {
      const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content?$format=text/vtt`;
      return (await get(accessToken, url, "text/vtt")).text();
    },
  };
}

// Resolve the onlineMeeting and pick the user id to fetch transcripts as.
// Returns { meeting, transcriptUserId }.
async function resolveMeeting(client, token, config) {
  // Mode B: Meeting ID — no organizer in hand. Try each candidate (submitter first,
  // then any supplied attendee) until one's collection holds the meeting, then fetch
  // transcripts as the meeting's REAL organizer (always authorized). Fall back to the
  // candidate that found it if Graph omitted the organizer identity.
  if (config.joinMeetingId) {
    const failures = [];
    let permissionError = null;
    for (const uid of config.resolverUserIds) {
      try {
        // Candidates arrive as email addresses from the portal; onlineMeetings needs
        // the object id. Resolving inside the try means an unknown address is just
        // another failed candidate, not the end of the search.
        const objectId = await client.resolveUserId(token, uid);
        const meeting = await client.findMeetingByJoinMeetingId(token, objectId, config.joinMeetingId);
        if (meeting) return { meeting, transcriptUserId: organizerIdOf(meeting) || objectId };
        failures.push(`${uid}: no match`);
      } catch (error) {
        // A candidate can fail for reasons that say nothing about the next one:
        // 403 from findMeetingByJoinMeetingId = the Teams application access policy
        // does not cover THIS user, 404/other = this user cannot see the meeting.
        // Neither should end the search — record it and try the next candidate.
        //
        // But Authorization_RequestDenied when resolving an email → object id means
        // the Graph app is missing the User.Read.All APPLICATION permission — a
        // server-config problem that fails every candidate identically. Capture it so
        // the final error names the real cause instead of blaming the submitter.
        if (error.graphCode === "Authorization_RequestDenied") permissionError = error;
        failures.push(`${uid}: ${error.message}`);
      }
    }
    if (permissionError) {
      throw new Error(
        "Could not resolve the Meeting ID: the transcript service is missing the Microsoft Graph " +
          "User.Read.All application permission needed to look up attendees by email. This is a server " +
          `configuration issue, not a problem with your submission — please contact the administrator. (${permissionError.message})`,
      );
    }
    throw new Error(
      "No meeting was found for that Meeting ID. If you did not attend it, add the email of someone who did." +
        (failures.length ? ` (tried — ${failures.join("; ")})` : ""),
    );
  }

  // Mode A: long link — the organizer is embedded in the link's context.Oid.
  const parsed = parseJoinUrl(config.joinUrl);
  if (parsed.error) throw new Error(parsed.error);
  const userId = config.organizerId || parsed.userId;
  const meeting = await client.findMeeting(token, userId, config.joinUrl);
  if (!meeting) throw new Error("No meeting was found for that link (check it is from this tenant).");
  return { meeting, transcriptUserId: userId };
}

async function downloadFromMeetingLink({ env = process.env, graph } = {}) {
  const config = readConfig(env);

  const client = graph || createGraphClient(config);
  const token = await client.token();
  const { meeting, transcriptUserId } = await resolveMeeting(client, token, config);
  // The meeting (hence its subject) is known from here on. If a later step fails,
  // attach the subject so the failed history row can show the real title instead of
  // the "Meeting <id>" placeholder the Portal API wrote at submission time.
  try {
    return await fetchAndSaveTranscript(client, token, config, meeting, transcriptUserId, env);
  } catch (error) {
    if (meeting?.subject && error.meetingSubject === undefined) error.meetingSubject = meeting.subject;
    throw error;
  }
}

// Fetch the latest transcript for a resolved meeting, save the VTT, and build the
// pipeline result shape. Split out so downloadFromMeetingLink can tag any failure
// here with the (already known) meeting subject.
async function fetchAndSaveTranscript(client, token, config, meeting, transcriptUserId, env) {
  const transcript = await client.latestTranscript(token, transcriptUserId, meeting.id);
  if (!transcript)
    throw new Error("No transcript is available for this meeting yet. Try again after Teams has processed it.");

  const rawContent = await client.content(token, transcriptUserId, meeting.id, transcript.id);
  const content = validateDownloadedVtt(Buffer.from(rawContent, "utf8"));

  const filename = canonicalFileName(transcript.createdDateTime, config.requestId);
  await fs.mkdir(config.outputDir, { recursive: true });
  const transcriptPath = env.OUTPUT_PATH || path.join(config.outputDir, filename);
  await fs.writeFile(transcriptPath, content, "utf8");

  // When the submitter left the project name blank, fall back to the meeting's own
  // subject for the history display name + dashboard title.
  const userProjectName = String(config.projectName || "").trim();
  const subject = meeting.subject || "";
  // Unnamed submission: file the dashboard under the project derived from the meeting
  // subject (same "[Proj] / Proj - Title / Proj: Title" rule the webhook path uses),
  // so it merges with that project instead of the Portal API's synthetic slug. (The
  // submissions history record keeps its own partition key; only the dashboard/meetings
  // record and URL use this project.)
  const projectSlug = userProjectName ? config.projectSlug : parseSubject(subject).projectSlug;
  const displayName = userProjectName || subject || "Meeting";
  const meetingSubject = userProjectName
    ? subject
      ? `${userProjectName} - ${subject}`
      : `${userProjectName} - Meeting link`
    : subject || "Meeting link";

  return {
    success: true,
    transcriptPath,
    projectName: projectSlug,
    displayName,
    meetingDate: filename.slice(0, 10),
    filename,
    meetingSubject,
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
    // Shared with the upload path — surfaces statusCode/code when the message is
    // empty (e.g. a HEAD 403, or a Graph error the SDK could not describe).
    const message = describeError(error);
    log("error", "Failed to download from meeting link", { error: message });
    // Emit the meeting subject when the failure happened AFTER the meeting resolved,
    // so entrypoint.sh can show the real title on the failed history row.
    const out = { error: true, message };
    if (error.meetingSubject) out.meetingSubject = error.meetingSubject;
    console.log(JSON.stringify(out));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  readConfig,
  parseJoinUrl,
  canonicalFileName,
  buildMeetingFilterUrl,
  createGraphClient,
  downloadFromMeetingLink,
};
