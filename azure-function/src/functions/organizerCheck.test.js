const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  latestUnalertedSeries,
  isOrganizerGone,
  buildOrganizerAlert,
} = require("./organizerCheck");

function meeting(overrides = {}) {
  return {
    id: "ssw-design-2026-10-16-114722",
    projectName: "ssw-design",
    meetingDate: "2026-10-16",
    teamsMeeting: {
      organizerUserId: "uly",
      onlineMeetingId: "series-1",
      subject: "SSW Design - Sprint Review",
      participantUserIds: ["uly", "isaac", "tiago"],
    },
    ...overrides,
  };
}

describe("latestUnalertedSeries", () => {
  it("keeps only the latest occurrence of each recurring series", () => {
    const series = latestUnalertedSeries([
      meeting({ id: "a", meetingDate: "2026-10-02" }),
      meeting({ id: "b", meetingDate: "2026-10-16" }),
      meeting({ id: "c", meetingDate: "2026-10-09" }),
    ]);

    assert.equal(series.length, 1);
    assert.equal(series[0].id, "b");
  });

  it("skips a series that was already alerted, even on an older occurrence", () => {
    const series = latestUnalertedSeries([
      meeting({ id: "a", meetingDate: "2026-10-09", organizerAlertSentAt: "2026-10-20T22:00:00Z" }),
      meeting({ id: "b", meetingDate: "2026-10-16" }),
    ]);

    assert.deepEqual(series, []);
  });

  it("treats different Teams meetings as separate series", () => {
    const series = latestUnalertedSeries([
      meeting({ id: "a" }),
      meeting({ id: "b", teamsMeeting: { ...meeting().teamsMeeting, onlineMeetingId: "series-2" } }),
    ]);

    assert.deepEqual(series.map((s) => s.id).sort(), ["a", "b"]);
  });

  it("ignores records without a Teams meeting (local runs)", () => {
    assert.deepEqual(latestUnalertedSeries([meeting({ teamsMeeting: undefined })]), []);
  });
});

describe("isOrganizerGone", () => {
  it("is true for a disabled account", () => {
    assert.equal(isOrganizerGone({ status: 200, accountEnabled: false }), true);
  });

  it("is true for a deleted account", () => {
    assert.equal(isOrganizerGone({ status: 404 }), true);
  });

  it("is false for an active account", () => {
    assert.equal(isOrganizerGone({ status: 200, accountEnabled: true }), false);
  });

  it("is false when Graph errors, so a blip never sends a false alarm", () => {
    assert.equal(isOrganizerGone({ status: 403 }), false);
    assert.equal(isOrganizerGone({ status: 500 }), false);
  });
});

describe("buildOrganizerAlert", () => {
  it("notifies everyone except the departed organizer and links the fix", () => {
    const payload = buildOrganizerAlert({
      series: meeting(),
      organizerName: "Ulysses Maclaren [SSW]",
      docsUrl: "https://sswtiger.com/docs/when-a-meeting-organiser-leaves",
    });

    assert.deepEqual(payload, {
      notificationType: "organizer-disabled",
      projectName: "ssw-design",
      meetingSubject: "SSW Design - Sprint Review",
      organizerName: "Ulysses Maclaren [SSW]",
      docsUrl: "https://sswtiger.com/docs/when-a-meeting-organiser-leaves",
      participants: [{ userId: "isaac" }, { userId: "tiago" }],
    });
  });

  it("falls back to placeholders when the subject or name is missing", () => {
    const payload = buildOrganizerAlert({
      series: meeting({ teamsMeeting: { ...meeting().teamsMeeting, subject: "" } }),
      organizerName: "",
      docsUrl: "https://example.test/docs",
    });

    assert.equal(payload.meetingSubject, "Untitled Meeting");
    assert.equal(payload.organizerName, "the original organiser");
  });
});
