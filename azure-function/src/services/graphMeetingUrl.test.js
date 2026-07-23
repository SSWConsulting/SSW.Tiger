const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMeetingFilterUrl } = require("./graphMeetingUrl");

// Mirrors processor/downloadFromMeetingLink.test.js — keep both in sync.
const joinUrl = `https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=${encodeURIComponent(
  JSON.stringify({ Tid: "tenant-1", Oid: "organizer-1" }),
)}&anon=true`;

test("percent-encodes the join URL into a single $filter query value", () => {
  const url = buildMeetingFilterUrl("organizer-1", joinUrl);
  const parsed = new URL(url);

  // The whole filter is ONE query param and decodes back to the exact join URL,
  // including the "?" and the trailing "&anon=true" the link carries itself.
  assert.equal(parsed.searchParams.get("$filter"), `JoinWebUrl eq '${joinUrl}'`);
  assert.equal([...parsed.searchParams.keys()].length, 1);

  // Regression guard: exactly one "?" in the raw URL. Before the fix the join
  // URL's own "?" leaked through as a second query separator and Graph silently
  // truncated the filter at the "&", so no meeting ever matched.
  assert.equal(url.split("?").length, 2);
});

test("doubles single quotes so they cannot terminate the OData literal", () => {
  const url = buildMeetingFilterUrl("u", "https://teams.microsoft.com/l/x?context='or'1'='1");
  assert.equal(
    new URL(url).searchParams.get("$filter"),
    "JoinWebUrl eq 'https://teams.microsoft.com/l/x?context=''or''1''=''1'",
  );
});
