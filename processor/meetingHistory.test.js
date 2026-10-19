const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { selectPriorMeetings } = require("./meetingHistory");

const meeting = (meetingId, consolidated = { ok: true }) => ({ meetingId, consolidated });

describe("selectPriorMeetings", () => {
  it("returns earlier meetings newest first, including same-day ones", () => {
    const meetings = [
      meeting("2026-09-29-100000"),
      meeting("2026-10-13-101845"),
      meeting("2026-09-15-100000"),
    ];
    const ids = selectPriorMeetings(meetings, "2026-10-13-130104").map((m) => m.meetingId);
    assert.deepEqual(ids, ["2026-10-13-101845", "2026-09-29-100000", "2026-09-15-100000"]);
  });

  it("excludes the current meeting and anything after it", () => {
    const meetings = [meeting("2026-10-13-101845"), meeting("2026-10-27-100000")];
    assert.deepEqual(selectPriorMeetings(meetings, "2026-10-13-101845"), []);
  });

  it("skips records without consolidated analysis", () => {
    const meetings = [meeting("2026-09-29-100000", null), meeting("2026-09-15-100000")];
    const ids = selectPriorMeetings(meetings, "2026-10-13-101845").map((m) => m.meetingId);
    assert.deepEqual(ids, ["2026-09-15-100000"]);
  });

  it("caps the number of meetings returned", () => {
    const meetings = ["01", "02", "03", "04", "05"].map((d) => meeting(`2026-09-${d}-100000`));
    const ids = selectPriorMeetings(meetings, "2026-10-01-100000", 2).map((m) => m.meetingId);
    assert.deepEqual(ids, ["2026-09-05-100000", "2026-09-04-100000"]);
  });
});
