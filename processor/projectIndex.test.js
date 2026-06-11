const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs").promises;
const path = require("path");

const {
  formatDate,
  meetingLabel,
  buildChips,
  normalizeMeetings,
  mergeCurrentMeeting,
  renderProjectIndex,
} = require("./projectIndex");

describe("formatDate", () => {
  it("converts ISO dates to Australian format", () => {
    assert.equal(formatDate("2026-01-22"), "22/01/2026");
  });

  it("handles ISO timestamps", () => {
    assert.equal(formatDate("2026-01-22T09:45:00.000Z"), "22/01/2026");
  });

  it("passes through unrecognized values", () => {
    assert.equal(formatDate("not-a-date"), "not-a-date");
    assert.equal(formatDate(""), "");
    assert.equal(formatDate(null), "");
  });
});

describe("meetingLabel", () => {
  it("formats a 6-digit time suffix as HH:MM", () => {
    assert.equal(meetingLabel("2026-01-22-094557", "2026-01-22"), "09:45");
  });

  it("title-cases a descriptive suffix", () => {
    assert.equal(meetingLabel("2026-01-22-sprint-review", "2026-01-22"), "Sprint Review");
  });

  it("returns empty for a date-only meeting ID", () => {
    assert.equal(meetingLabel("2026-01-22", "2026-01-22"), "");
  });
});

describe("buildChips", () => {
  it("builds chips from metadata", () => {
    assert.deepEqual(
      buildChips({ totalDurationMinutes: 62.4, participantCount: 8, actionItemsCount: 5 }),
      ["62 min", "8 people", "5 action items"],
    );
  });

  it("omits missing values", () => {
    assert.deepEqual(buildChips({ participantCount: 3 }), ["3 people"]);
    assert.deepEqual(buildChips(), []);
    assert.deepEqual(buildChips({}), []);
  });
});

describe("normalizeMeetings", () => {
  it("sorts newest first and de-duplicates by meetingId", () => {
    const meetings = normalizeMeetings([
      { meetingId: "2026-01-15", meetingDate: "2026-01-15" },
      { meetingId: "2026-01-22-094557", meetingDate: "2026-01-22" },
      { meetingId: "2026-01-15", meetingDate: "2026-01-15" },
      { meetingId: "2026-01-22-sprint-review", meetingDate: "2026-01-22" },
    ]);
    assert.deepEqual(
      meetings.map((m) => m.meetingId),
      ["2026-01-22-sprint-review", "2026-01-22-094557", "2026-01-15"],
    );
  });

  it("ignores entries without a meetingId", () => {
    assert.deepEqual(normalizeMeetings([null, {}, { meetingId: "x", meetingDate: "2026-01-01" }]).length, 1);
  });
});

describe("mergeCurrentMeeting", () => {
  it("adds the current meeting when missing", () => {
    const merged = mergeCurrentMeeting(
      [{ meetingId: "a", meetingDate: "2026-01-01" }],
      { meetingId: "b", meetingDate: "2026-01-02" },
    );
    assert.equal(merged.length, 2);
  });

  it("does not duplicate an already-persisted meeting", () => {
    const merged = mergeCurrentMeeting(
      [{ meetingId: "a", meetingDate: "2026-01-01" }],
      { meetingId: "a", meetingDate: "2026-01-01" },
    );
    assert.equal(merged.length, 1);
  });

  it("tolerates a missing list or current meeting", () => {
    assert.equal(mergeCurrentMeeting(null, { meetingId: "a" }).length, 1);
    assert.equal(mergeCurrentMeeting([{ meetingId: "a" }], null).length, 1);
  });
});

describe("renderProjectIndex", () => {
  const template = [
    "<title>{{PROJECT_NAME}}</title>",
    "<p>{{MEETING_COUNT}}</p>",
    "<main>{{MEETING_LIST}}</main>",
    "<footer>{{GENERATED_AT}}</footer>",
  ].join("\n");

  it("replaces all placeholders", () => {
    const html = renderProjectIndex({
      template,
      displayName: "YakShaver",
      meetings: [
        {
          meetingId: "2026-01-22-094557",
          meetingDate: "2026-01-22",
          metadata: { participantCount: 8 },
        },
      ],
      generatedAt: "2026-06-11T00:00:00.000Z",
    });

    assert.ok(!html.includes("{{"), "no unreplaced placeholders");
    assert.ok(html.includes("<title>YakShaver</title>"));
    assert.ok(html.includes("<p>1</p>"));
    assert.ok(html.includes('href="./2026-01-22-094557/"'));
    assert.ok(html.includes("22/01/2026"));
    assert.ok(html.includes("8 people"));
    assert.ok(html.includes("11/06/2026"));
  });

  it("escapes HTML in the project name", () => {
    const html = renderProjectIndex({
      template,
      displayName: '<script>alert("x")</script>',
      meetings: [],
    });
    assert.ok(!html.includes("<script>alert"));
    assert.ok(html.includes("&lt;script&gt;"));
  });

  it("renders an empty state when there are no meetings", () => {
    const html = renderProjectIndex({ template, displayName: "Empty", meetings: [] });
    assert.ok(html.includes("No meetings yet"));
    assert.ok(html.includes("<p>0</p>"));
  });

  it("fills the real template without leaving placeholders", async () => {
    const realTemplate = await fs.readFile(
      path.join(__dirname, "..", "templates", "project-index.html"),
      "utf-8",
    );
    const html = renderProjectIndex({
      template: realTemplate,
      displayName: "YakShaver",
      meetings: [{ meetingId: "2026-01-22", meetingDate: "2026-01-22" }],
      generatedAt: "2026-06-11T00:00:00.000Z",
    });
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), "no unreplaced placeholders in real template");
  });
});
