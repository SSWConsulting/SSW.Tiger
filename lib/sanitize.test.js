const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeId } = require("./sanitize");
const { parseSubject } = require("../processor/downloadTranscript");

describe("sanitizeId", () => {
  it("strips emojis", () => {
    assert.equal(sanitizeId("tinacms 🚀"), "tinacms");
  });

  it("strips Cosmos DB illegal characters (\\, /, #, ?)", () => {
    assert.equal(sanitizeId("my/project#1?v2\\test"), "my-project1v2-test");
  });

  it("converts spaces and slashes to hyphens", () => {
    assert.equal(sanitizeId("hello world"), "hello-world");
    assert.equal(sanitizeId("TinaCloud/TinaCMS"), "tinacloud-tinacms");
  });

  it("collapses consecutive hyphens", () => {
    assert.equal(sanitizeId("a - - b"), "a-b");
  });

  it("trims leading and trailing hyphens", () => {
    assert.equal(sanitizeId("--hello--"), "hello");
  });

  it("converts dots to hyphens", () => {
    assert.equal(sanitizeId("SSW.Rewards"), "ssw-rewards");
    assert.equal(sanitizeId("a.b.c"), "a-b-c");
  });

  it("preserves digits and hyphens", () => {
    assert.equal(sanitizeId("2026-01-22-094557"), "2026-01-22-094557");
  });

  it("lowercases input", () => {
    assert.equal(sanitizeId("TinaCMS"), "tinacms");
  });

  it("returns empty string for all-emoji input", () => {
    assert.equal(sanitizeId("🎉🎊🎈"), "");
  });

  it("handles null and undefined without crashing", () => {
    assert.equal(sanitizeId(null), "");
    assert.equal(sanitizeId(undefined), "");
  });
});

describe("parseSubject — displayName preserves original", () => {
  it("preserves slashes and casing", () => {
    const r = parseSubject("TinaCloud/TinaCMS - Sprint Review, Retro and Planning");
    assert.equal(r.displayName, "TinaCloud/TinaCMS");
    assert.equal(r.title, "Sprint Review, Retro and Planning");
  });

  it("preserves emojis", () => {
    const r = parseSubject("TinaCMS 🚀 - Sprint Review");
    assert.equal(r.displayName, "TinaCMS 🚀");
  });

  it("preserves dots", () => {
    const r = parseSubject("SSW.Rewards: Weekly Sync");
    assert.equal(r.displayName, "SSW.Rewards");
  });

  it("preserves bracket format casing", () => {
    const r = parseSubject("[YakShaver] Sprint Review");
    assert.equal(r.displayName, "YakShaver");
    assert.equal(r.title, "Sprint Review");
  });

  it("defaults to general for null input", () => {
    const r = parseSubject(null);
    assert.equal(r.displayName, "general");
    assert.equal(r.title, "meeting");
  });

  it("defaults to general for no separator", () => {
    const r = parseSubject("Just a plain subject");
    assert.equal(r.displayName, "general");
    assert.equal(r.title, "Just a plain subject");
  });
});

describe("parseSubject — projectSlug is safe for Cosmos DB / URLs", () => {
  it("lowercases and converts slashes to hyphens", () => {
    const r = parseSubject("TinaCloud/TinaCMS - Sprint Review, Retro and Planning");
    assert.equal(r.projectSlug, "tinacloud-tinacms");
  });

  it("strips emojis", () => {
    const r = parseSubject("TinaCMS 🚀 - Sprint Review");
    assert.equal(r.projectSlug, "tinacms");
  });

  it("preserves dots", () => {
    const r = parseSubject("SSW.Rewards: Weekly Sync");
    assert.equal(r.projectSlug, "ssw-rewards");
  });

  it("lowercases normal names", () => {
    const r = parseSubject("[YakShaver] Sprint Review");
    assert.equal(r.projectSlug, "yakshaver");
  });

  it("falls back to general for all-emoji project name", () => {
    const r = parseSubject("🎉🎊🎈 - Party Meeting");
    assert.equal(r.projectSlug, "general");
  });

  it("falls back to general for null input", () => {
    const r = parseSubject(null);
    assert.equal(r.projectSlug, "general");
  });

  it("converts spaces to hyphens", () => {
    const r = parseSubject("Normal Project - Standup");
    assert.equal(r.projectSlug, "normal-project");
  });
});
