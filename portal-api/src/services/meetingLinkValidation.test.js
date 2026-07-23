const test = require("node:test");
const assert = require("node:assert/strict");
const { validateMeetingLink, validateAttendeeEmail } = require("./meetingLinkValidation");

const longLink = `https://teams.microsoft.com/l/meetup-join/19%3ax%40thread.v2/0?context=${encodeURIComponent(
  JSON.stringify({ Tid: "t1", Oid: "org-1" }),
)}`;

test("classifies a long meetup-join link as organizer mode", () => {
  assert.deepEqual(validateMeetingLink(longLink), {
    mode: "organizer",
    joinUrl: longLink,
    organizerId: "org-1",
    tenantId: "t1",
  });
});

test("classifies a short /meet link as joinMeetingId mode", () => {
  assert.deepEqual(validateMeetingLink("https://teams.microsoft.com/meet/47769649877490?p=abc"), {
    mode: "joinMeetingId",
    joinMeetingId: "47769649877490",
  });
});

test("classifies a bare numeric Meeting ID (spaces allowed) as joinMeetingId mode", () => {
  assert.deepEqual(validateMeetingLink("477 696 498 774 90"), {
    mode: "joinMeetingId",
    joinMeetingId: "47769649877490",
  });
});

test("rejects a meetup-join link with no context/organizer", () => {
  assert.throws(() => validateMeetingLink("https://teams.microsoft.com/l/meetup-join/19:x/0"), /missing meeting info/i);
});

test("rejects non-Teams links and empty input", () => {
  assert.throws(() => validateMeetingLink("https://example.com/meet/123456789"), /not a Teams/i);
  assert.throws(() => validateMeetingLink(""), /required/i);
});

test("validateAttendeeEmail: null when empty, lowercased when valid, throws when malformed", () => {
  assert.equal(validateAttendeeEmail(""), null);
  assert.equal(validateAttendeeEmail(undefined), null);
  assert.equal(validateAttendeeEmail("Colleague@SSW.com.au"), "colleague@ssw.com.au");
  assert.throws(() => validateAttendeeEmail("not-an-email"), /valid attendee email/i);
});
