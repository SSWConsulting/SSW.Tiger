const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const { parseJoinUrl, readConfig, downloadFromMeetingLink, createGraphClient } = require("./downloadFromMeetingLink");
const { parseSubject } = require("./parseSubject");

const joinUrl = `https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=${encodeURIComponent(
  JSON.stringify({ Tid: "tenant-1", Oid: "organizer-1" }),
)}`;

const baseEnv = {
  MEETING_JOIN_URL: joinUrl,
  MEETING_ORGANIZER_ID: "organizer-1",
  UPLOAD_REQUEST_ID: "r1",
  UPLOAD_PROJECT_NAME: "Tiger Portal",
  UPLOAD_PROJECT_SLUG: "tiger-portal",
  GRAPH_TENANT_ID: "tenant-1",
  GRAPH_CLIENT_ID: "client-1",
  GRAPH_CLIENT_SECRET: "secret-1",
};

test("parses organizer + tenant from a Teams join URL, and reports link problems", () => {
  assert.deepEqual(parseJoinUrl(joinUrl), { userId: "organizer-1", tenantId: "tenant-1" });
  assert.match(parseJoinUrl("https://example.com").error, /Teams meeting link/);
  assert.match(parseJoinUrl("https://teams.microsoft.com/l/meetup-join/19:x/0").error, /missing meeting info/);
});

test("resolves the latest transcript and returns a Graph-compatible shape", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tiger-link-"));
  const graph = {
    token: async () => "tok",
    findMeeting: async () => ({ id: "meeting-9", subject: "Sprint Review" }),
    latestTranscript: async () => ({ id: "t2", createdDateTime: "2026-07-10T04:05:06Z" }),
    content: async () => "WEBVTT\n\n00:00.000 --> 00:01.000\n<v Willow Lyu>Hello",
  };
  const result = await downloadFromMeetingLink({ env: { ...baseEnv, OUTPUT_PATH: path.join(dir, "out.vtt") }, graph });
  assert.equal(result.projectName, "tiger-portal");
  assert.equal(result.meetingDate, "2026-07-10");
  assert.match(result.filename, /^2026-07-10-\d{6}-[a-f0-9]{8}\.vtt$/);
  assert.match(result.meetingSubject, /Sprint Review/);
  assert.deepEqual(result.vttInfo, { hasSpeakerLabels: true, taggedSpeakerCount: 1, taggedSpeakers: ["Willow Lyu"] });
  assert.equal((await fs.readFile(result.transcriptPath, "utf8")).startsWith("WEBVTT"), true);
});

test("percent-encodes the join URL into the OData filter query", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ value: [{ id: "m1" }] }) };
  };
  const client = createGraphClient({ tenantId: "t", clientId: "c", clientSecret: "s" }, fetchImpl);

  // A real join URL carries its own "?" plus extra "&" params — both must survive.
  const link = `${joinUrl}&anon=true`;
  await client.findMeeting("tok", "organizer-1", link);

  const requested = new URL(calls[0]);
  // The whole filter is ONE query param and decodes back to the exact join URL.
  assert.equal(requested.searchParams.get("$filter"), `JoinWebUrl eq '${link}'`);
  // Regression guard: the raw URL must have exactly one "?" (the join URL's own
  // "?" must be encoded, not leak a second query separator into the Graph URL).
  assert.equal(calls[0].split("?").length, 2);
});

test("surfaces a clear error when no transcript exists yet", async () => {
  const graph = {
    token: async () => "tok",
    findMeeting: async () => ({ id: "meeting-9" }),
    latestTranscript: async () => null,
    content: async () => {
      throw new Error("should not be called");
    },
  };
  await assert.rejects(downloadFromMeetingLink({ env: baseEnv, graph }), /No transcript is available/);
});

// --- Mode B: short link / Meeting ID (no organizer in hand) ---

const meetingIdEnv = {
  MEETING_JOIN_MEETING_ID: "47769649877490",
  MEETING_RESOLVER_USER_IDS: "missing@ssw.com.au, attendee@ssw.com.au",
  UPLOAD_REQUEST_ID: "r2",
  UPLOAD_PROJECT_NAME: "Tiger Portal",
  UPLOAD_PROJECT_SLUG: "tiger-portal",
  GRAPH_TENANT_ID: "tenant-1",
  GRAPH_CLIENT_ID: "client-1",
  GRAPH_CLIENT_SECRET: "secret-1",
};

test("mode B: resolves by joinMeetingId trying candidates, then fetches transcript as the REAL organizer", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tiger-jmi-"));
  const tried = [];
  let transcriptUser = null;
  let contentUser = null;
  const meeting = {
    id: "meeting-xyz",
    subject: "Sprint Review",
    // The submitter is only an attendee; the true organizer differs (YakShaver case).
    participants: { organizer: { identity: { user: { id: "organizer-real" } } } },
  };
  const graph = {
    token: async () => "tok",
    resolveUserId: async (_t, id) => id,
    findMeetingByJoinMeetingId: async (_t, uid) => {
      tried.push(uid);
      return uid === "attendee@ssw.com.au" ? meeting : null; // first candidate can't see it
    },
    latestTranscript: async (_t, uid) => {
      transcriptUser = uid;
      return { id: "t9", createdDateTime: "2026-07-10T04:05:06Z" };
    },
    content: async (_t, uid) => {
      contentUser = uid;
      return "WEBVTT\n\n00:00.000 --> 00:01.000\n<v Willow Lyu>Hi";
    },
  };
  const result = await downloadFromMeetingLink({
    env: { ...meetingIdEnv, OUTPUT_PATH: path.join(dir, "out.vtt") },
    graph,
  });
  assert.deepEqual(tried, ["missing@ssw.com.au", "attendee@ssw.com.au"]); // in order, stops at first hit
  assert.equal(transcriptUser, "organizer-real"); // transcript fetched as the discovered organizer, not the attendee
  assert.equal(contentUser, "organizer-real");
  assert.match(result.meetingSubject, /Sprint Review/);
});

test("mode B without a project name: name from subject, project derived from subject (not the synthetic slug)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tiger-noname-"));
  const subject = "SSW.AI - Sprint Review";
  const meeting = {
    id: "m",
    subject,
    participants: { organizer: { identity: { user: { id: "org" } } } },
  };
  const graph = {
    token: async () => "tok",
    resolveUserId: async (_t, id) => id,
    findMeetingByJoinMeetingId: async () => meeting,
    latestTranscript: async () => ({ id: "t", createdDateTime: "2026-07-10T04:05:06Z" }),
    content: async () => "WEBVTT\n\n00:00.000 --> 00:01.000\nHi",
  };
  // meetingIdEnv carries UPLOAD_PROJECT_SLUG "tiger-portal"; with no project NAME the
  // dashboard should instead file under the project parsed from the subject.
  const env = { ...meetingIdEnv, UPLOAD_PROJECT_NAME: "", OUTPUT_PATH: path.join(dir, "o.vtt") };
  const result = await downloadFromMeetingLink({ env, graph });
  assert.equal(result.displayName, subject);
  assert.equal(result.meetingSubject, subject);
  assert.equal(result.projectName, parseSubject(subject).projectSlug);
  assert.notEqual(result.projectName, "tiger-portal");
});

test("mode B: clear, actionable error when no candidate can see the meeting", async () => {
  const graph = {
    token: async () => "tok",
    resolveUserId: async (_t, id) => id,
    findMeetingByJoinMeetingId: async () => null,
    latestTranscript: async () => {
      throw new Error("should not be called");
    },
    content: async () => {
      throw new Error("should not be called");
    },
  };
  await assert.rejects(
    downloadFromMeetingLink({ env: { ...meetingIdEnv, MEETING_RESOLVER_USER_IDS: "me@ssw.com.au" }, graph }),
    /did not attend/,
  );
});

test("readConfig rejects a Meeting ID with no resolver candidates, and a config with neither link nor Meeting ID", () => {
  const base = {
    UPLOAD_REQUEST_ID: "r",
    UPLOAD_PROJECT_NAME: "P",
    UPLOAD_PROJECT_SLUG: "p",
    GRAPH_TENANT_ID: "t",
    GRAPH_CLIENT_ID: "c",
    GRAPH_CLIENT_SECRET: "s",
  };
  assert.throws(() => readConfig({ ...base, MEETING_JOIN_MEETING_ID: "123" }), /resolverUserIds/);
  assert.throws(() => readConfig(base), /joinUrl or joinMeetingId/);
});

test("mode B: a candidate that throws (403 app access policy) does not abort the search", async () => {
  // Real Graph THROWS on 403 — the previous fake only returned null, so the
  // candidate loop looked like it tolerated failures when it did not.
  const tried = [];
  const graph = {
    token: async () => "tok",
    resolveUserId: async (_t, id) => id,
    findMeetingByJoinMeetingId: async (_t, uid) => {
      tried.push(uid);
      if (uid === "me@ssw.com.au") throw new Error("Graph findMeetingByJoinMeetingId failed: 403 — Forbidden");
      return { id: "meeting-7", participants: { organizer: { identity: { user: { id: "organizer-9" } } } } };
    },
    latestTranscript: async (_t, uid) => {
      assert.equal(uid, "organizer-9", "transcripts must be fetched as the real organizer");
      return { id: "t1", createdDateTime: "2026-07-10T04:05:06Z" };
    },
    content: async () => "WEBVTT\n\n00:00.000 --> 00:01.000\n<v Willow Lyu>Hello",
  };
  const result = await downloadFromMeetingLink({
    env: { ...meetingIdEnv, MEETING_RESOLVER_USER_IDS: "me@ssw.com.au,attendee@ssw.com.au" },
    graph,
  });
  assert.deepEqual(tried, ["me@ssw.com.au", "attendee@ssw.com.au"], "must continue past the 403");
  assert.equal(result.success, true);
});

test("mode B: when every candidate fails, the error names each reason", async () => {
  const graph = {
    token: async () => "tok",
    resolveUserId: async (_t, id) => id,
    findMeetingByJoinMeetingId: async (_t, uid) => {
      throw new Error(`Graph findMeetingByJoinMeetingId failed: 403 — Forbidden (${uid})`);
    },
    latestTranscript: async () => {
      throw new Error("should not be called");
    },
    content: async () => {
      throw new Error("should not be called");
    },
  };
  await assert.rejects(
    downloadFromMeetingLink({
      env: { ...meetingIdEnv, MEETING_RESOLVER_USER_IDS: "me@ssw.com.au,attendee@ssw.com.au" },
      graph,
    }),
    (error) =>
      /did not attend/.test(error.message) &&
      /me@ssw\.com\.au: .*403/.test(error.message) &&
      /attendee@ssw\.com\.au: .*403/.test(error.message),
  );
});

test("mode B: resolves an email candidate to its object id before querying onlineMeetings", async () => {
  // Graph rejects a UPN here with 400 "The userId in request URL is not a valid GUID",
  // so the email the portal collected must be turned into an object id first.
  const queried = [];
  const graph = {
    token: async () => "tok",
    resolveUserId: async (_t, idOrUpn) =>
      idOrUpn === "attendee@ssw.com.au" ? "11111111-2222-3333-4444-555555555555" : idOrUpn,
    findMeetingByJoinMeetingId: async (_t, uid) => {
      queried.push(uid);
      return { id: "meeting-3", participants: { organizer: { identity: { user: { id: "organizer-1" } } } } };
    },
    latestTranscript: async () => ({ id: "t1", createdDateTime: "2026-07-10T04:05:06Z" }),
    content: async () => "WEBVTT\n\n00:00.000 --> 00:01.000\n<v Willow Lyu>Hi",
  };
  await downloadFromMeetingLink({
    env: { ...meetingIdEnv, MEETING_RESOLVER_USER_IDS: "attendee@ssw.com.au" },
    graph,
  });
  assert.deepEqual(queried, ["11111111-2222-3333-4444-555555555555"], "must query by object id, not the email");
});

test("mode B: an unresolvable email is just another failed candidate", async () => {
  const graph = {
    token: async () => "tok",
    resolveUserId: async (_t, id) => {
      if (id === "ghost@ssw.com.au") throw new Error("Graph resolveUserId(ghost@ssw.com.au) failed: 404");
      return "11111111-2222-3333-4444-555555555555";
    },
    findMeetingByJoinMeetingId: async () => ({ id: "meeting-4" }),
    latestTranscript: async () => ({ id: "t1", createdDateTime: "2026-07-10T04:05:06Z" }),
    content: async () => "WEBVTT\n\n00:00.000 --> 00:01.000\n<v W>Hi",
  };
  const result = await downloadFromMeetingLink({
    env: { ...meetingIdEnv, MEETING_RESOLVER_USER_IDS: "ghost@ssw.com.au,real@ssw.com.au" },
    graph,
  });
  assert.equal(result.success, true, "the second candidate must still be tried");
});
