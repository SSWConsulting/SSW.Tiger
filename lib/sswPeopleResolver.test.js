const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveSswProfileSlug,
  cleanName,
  splitName,
  splitSlug,
} = require("./sswPeopleResolver");

const SAMPLE_SLUGS = [
  "Adam-Cogan",
  "Thomas-Iwainski",
  "Daniel-Mackay",
  "Tiago-Araujo",
  "John-Smith",
  "Jane-Smith",
  "Mary-Jane-Wilson",
];

describe("cleanName", () => {
  it("strips bracketed suffixes like [SSW]", () => {
    assert.equal(cleanName("Tiago Araujo [SSW]"), "Tiago Araujo");
  });

  it("trims whitespace", () => {
    assert.equal(cleanName("  Adam Cogan  "), "Adam Cogan");
  });

  it("handles empty input", () => {
    assert.equal(cleanName(""), "");
    assert.equal(cleanName(null), "");
    assert.equal(cleanName(undefined), "");
  });
});

describe("splitName", () => {
  it("splits a two-part name", () => {
    assert.deepEqual(splitName("Tom Iwainski"), {
      firstName: "Tom",
      lastName: "Iwainski",
    });
  });

  it("treats all but the last token as the first name", () => {
    assert.deepEqual(splitName("Mary Jane Wilson"), {
      firstName: "Mary Jane",
      lastName: "Wilson",
    });
  });

  it("returns empty lastName for a single token", () => {
    assert.deepEqual(splitName("Charlie"), {
      firstName: "Charlie",
      lastName: "",
    });
  });
});

describe("splitSlug", () => {
  it("splits a two-part slug", () => {
    assert.deepEqual(splitSlug("Thomas-Iwainski"), {
      firstName: "Thomas",
      lastName: "Iwainski",
    });
  });

  it("treats all but the last hyphen segment as the first name", () => {
    assert.deepEqual(splitSlug("Mary-Jane-Wilson"), {
      firstName: "Mary Jane",
      lastName: "Wilson",
    });
  });
});

describe("resolveSswProfileSlug", () => {
  it("rule 1: exact first+last match returns the slug", () => {
    assert.equal(
      resolveSswProfileSlug("Adam Cogan", SAMPLE_SLUGS),
      "Adam-Cogan",
    );
  });

  it("rule 1: case-insensitive exact match", () => {
    assert.equal(
      resolveSswProfileSlug("adam cogan", SAMPLE_SLUGS),
      "Adam-Cogan",
    );
  });

  it("rule 2: unique last name resolves nickname (Tom -> Thomas-Iwainski)", () => {
    assert.equal(
      resolveSswProfileSlug("Tom Iwainski", SAMPLE_SLUGS),
      "Thomas-Iwainski",
    );
  });

  it("rule 2: resolves when first name is missing entirely (single Adams in list)", () => {
    // Last-name-only input ("Adams" alone has no last name token, so use a
    // case where first name differs but last name is unique) - covered by
    // the Tom -> Thomas-Iwainski test above. This case asserts rule 2 still
    // fires when the input first name is unrelated but the last name is
    // unique in the directory.
    assert.equal(
      resolveSswProfileSlug("Tommy Iwainski", SAMPLE_SLUGS),
      "Thomas-Iwainski",
    );
  });

  it("rule 3: ambiguous last name with no exact first-name match returns null", () => {
    assert.equal(
      resolveSswProfileSlug("Bob Smith", SAMPLE_SLUGS),
      null,
    );
  });

  it("ambiguous last name still wins when first name matches exactly", () => {
    assert.equal(
      resolveSswProfileSlug("Jane Smith", SAMPLE_SLUGS),
      "Jane-Smith",
    );
  });

  it("returns null when last name is not in the list", () => {
    assert.equal(
      resolveSswProfileSlug("Random Person", SAMPLE_SLUGS),
      null,
    );
  });

  it("strips [SSW] suffix before matching", () => {
    assert.equal(
      resolveSswProfileSlug("Tom Iwainski [SSW]", SAMPLE_SLUGS),
      "Thomas-Iwainski",
    );
  });

  it("returns null for single-token names (no last name)", () => {
    assert.equal(resolveSswProfileSlug("Charlie", SAMPLE_SLUGS), null);
  });

  it("returns null for empty/missing inputs", () => {
    assert.equal(resolveSswProfileSlug("", SAMPLE_SLUGS), null);
    assert.equal(resolveSswProfileSlug(null, SAMPLE_SLUGS), null);
    assert.equal(resolveSswProfileSlug("Tom Iwainski", []), null);
    assert.equal(resolveSswProfileSlug("Tom Iwainski", null), null);
  });

  it("resolves multi-part-first-name slugs (Mary Jane Wilson)", () => {
    assert.equal(
      resolveSswProfileSlug("Mary Jane Wilson", SAMPLE_SLUGS),
      "Mary-Jane-Wilson",
    );
  });
});
