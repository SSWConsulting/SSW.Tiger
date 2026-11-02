const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { meetingIdFromJoinUrl, latestOccurrenceTranscripts } = require("./meetingId");

const TENANT = "ac2f7c34-b935-48e9-abdc-11e5d4fcb2b0";

function joinUrl(threadAndMessage, organizerId) {
  const context = encodeURIComponent(JSON.stringify({ Tid: TENANT, Oid: organizerId }));
  return `https://teams.microsoft.com/l/meetup-join/${threadAndMessage}?context=${context}`;
}

describe("meetingIdFromJoinUrl", () => {
  it("builds the Graph ID of a channel meeting (matches the ID Graph sent for SSW Design)", () => {
    const url = joinUrl(
      "19%3a881bf4b4ec6d41a1aeebf5b2d174fa44%40thread.skype/1694564692495",
      "c5d711a1-8a57-4384-b4f3-aa20462296c4",
    );

    assert.equal(
      meetingIdFromJoinUrl(url, "c5d711a1-8a57-4384-b4f3-aa20462296c4"),
      "MSpjNWQ3MTFhMS04YTU3LTQzODQtYjRmMy1hYTIwNDYyMjk2YzQqMTY5NDU2NDY5MjQ5NSoqMTk6ODgxYmY0YjRlYzZkNDFhMWFlZWJmNWIyZDE3NGZhNDRAdGhyZWFkLnNreXBl",
    );
  });

  it("builds the Graph ID of a regular scheduled meeting", () => {
    const url = joinUrl(
      "19%3ameeting_MjhlZmFhNzEtMDMyMi00YzA1LTk4ZDktNjEwYWFkNjU2ZGFh%40thread.v2/0",
      "9d6afcad-19cd-4a22-8686-e2c8170f905a",
    );

    assert.equal(
      meetingIdFromJoinUrl(url, "9d6afcad-19cd-4a22-8686-e2c8170f905a"),
      "MSo5ZDZhZmNhZC0xOWNkLTRhMjItODY4Ni1lMmM4MTcwZjkwNWEqMCoqMTk6bWVldGluZ19NamhsWm1GaE56RXRNRE15TWkwMFl6QTFMVGs0WkRrdE5qRXdZV0ZrTmpVMlpHRmhAdGhyZWFkLnYy",
    );
  });

  it("returns null when the URL has no thread/message path", () => {
    assert.equal(meetingIdFromJoinUrl("https://teams.microsoft.com/meet/123?p=abc", "oid"), null);
  });
});

describe("latestOccurrenceTranscripts", () => {
  it("returns every transcript from the latest occurrence, oldest first", () => {
    const transcripts = [
      { id: "last-week-a", createdDateTime: "2026-10-15T23:01:57Z" },
      { id: "today-b", createdDateTime: "2026-10-30T00:32:31Z" },
      { id: "last-week-b", createdDateTime: "2026-10-16T00:47:22Z" },
      { id: "today-a", createdDateTime: "2026-10-29T23:33:01Z" },
    ];

    assert.deepEqual(
      latestOccurrenceTranscripts(transcripts).map((t) => t.id),
      ["today-a", "today-b"],
    );
  });

  it("returns a single transcript as-is and nothing for an empty list", () => {
    assert.deepEqual(latestOccurrenceTranscripts([{ id: "a", createdDateTime: "2026-10-30T00:00:00Z" }]).map((t) => t.id), ["a"]);
    assert.deepEqual(latestOccurrenceTranscripts([]), []);
  });
});
