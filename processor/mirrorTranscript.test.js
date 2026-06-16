const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  shouldMirror,
  buildCommitPath,
  isValidRepo,
  encodePath,
  buildCommitMessage,
} = require("./mirrorTranscript");

describe("shouldMirror", () => {
  it("mirrors everything when filter is empty or wildcard", () => {
    assert.equal(shouldMirror("", { meetingSubject: "anything" }), true);
    assert.equal(shouldMirror(".*", { meetingSubject: "anything" }), true);
    assert.equal(shouldMirror("*", { meetingSubject: "anything" }), true);
  });

  it("matches case-insensitively against subject, name, and slug", () => {
    assert.equal(
      shouldMirror("tinacloud", {
        meetingSubject: "TinaCloud/TinaCMS - Sprint Review, Retro and Planning",
      }),
      true,
    );
    assert.equal(shouldMirror("tinacloud", { projectName: "TinaCloud/TinaCMS" }), true);
    assert.equal(shouldMirror("tinacloud", { projectSlug: "tinacloud-tinacms" }), true);
  });

  it("does not match unrelated meetings", () => {
    assert.equal(
      shouldMirror("tinacloud", { meetingSubject: "SSW.Rewards - Sprint Review" }),
      false,
    );
  });

  it("falls back to substring match when the regex is invalid", () => {
    assert.equal(shouldMirror("(unclosed", { meetingSubject: "has (unclosed in it" }), true);
    assert.equal(shouldMirror("(unclosed", { meetingSubject: "nope" }), false);
  });
});

describe("buildCommitPath", () => {
  it("joins prefix and filename, adding a missing trailing slash", () => {
    assert.equal(
      buildCommitPath("recordings", "2026-06-16-101102.vtt"),
      "recordings/2026-06-16-101102.vtt",
    );
    assert.equal(
      buildCommitPath("recordings/", "2026-06-16-101102.vtt"),
      "recordings/2026-06-16-101102.vtt",
    );
  });

  it("supports an empty prefix (repo root)", () => {
    assert.equal(buildCommitPath("", "x.vtt"), "x.vtt");
  });
});

describe("isValidRepo", () => {
  it("accepts owner/repo", () => {
    assert.equal(isValidRepo("tinacms/sprint-meetings"), true);
  });

  it("rejects malformed values", () => {
    assert.equal(isValidRepo("noslash"), false);
    assert.equal(isValidRepo("too/many/parts"), false);
    assert.equal(isValidRepo(""), false);
    assert.equal(isValidRepo(null), false);
  });
});

describe("encodePath", () => {
  it("encodes segments but preserves the slashes between them", () => {
    assert.equal(encodePath("recordings/a b.vtt"), "recordings/a%20b.vtt");
    assert.equal(encodePath("recordings/2026-06-16-101102.vtt"), "recordings/2026-06-16-101102.vtt");
  });
});

describe("buildCommitMessage", () => {
  it("prefers display name, falls back to slug then 'meeting'", () => {
    assert.equal(
      buildCommitMessage({ projectName: "TinaCloud/TinaCMS", filename: "f.vtt" }),
      "Add transcript: TinaCloud/TinaCMS (f.vtt)",
    );
    assert.equal(
      buildCommitMessage({ projectSlug: "tinacloud-tinacms", filename: "f.vtt" }),
      "Add transcript: tinacloud-tinacms (f.vtt)",
    );
    assert.equal(buildCommitMessage({ filename: "f.vtt" }), "Add transcript: meeting (f.vtt)");
  });
});
