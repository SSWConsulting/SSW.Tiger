const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { buildMeetingsQuery } = require("./cosmosClient");

const param = (parameters, name) => parameters.find((p) => p.name === name)?.value;

describe("buildMeetingsQuery", () => {
  it("scopes to the project's partition and orders by meeting ID", () => {
    const { query, parameters, partitionKey } = buildMeetingsQuery({ projectName: "tina" });

    assert.equal(partitionKey, "tina");
    assert.equal(param(parameters, "@projectName"), "tina");
    assert.match(query, /ORDER BY c\.meetingId DESC$/);
    assert.doesNotMatch(query, /OFFSET|ARRAY_CONTAINS|consolidated/);
  });

  it("builds the history query: earlier, unprotected, analysed meetings, capped", () => {
    const { query, parameters } = buildMeetingsQuery({
      projectName: "tina",
      beforeMeetingId: "2026-10-13-130104",
      excludeMeetingIds: ["2026-09-29-100000"],
      requireConsolidated: true,
      limit: 4,
    });

    assert.match(query, /c\.meetingId < @beforeMeetingId/);
    assert.match(query, /NOT ARRAY_CONTAINS\(@excludeMeetingIds, c\.meetingId\)/);
    assert.match(query, /IS_DEFINED\(c\.consolidated\) AND NOT IS_NULL\(c\.consolidated\)/);
    assert.match(query, /ORDER BY c\.meetingId DESC OFFSET 0 LIMIT @limit$/);
    assert.equal(param(parameters, "@beforeMeetingId"), "2026-10-13-130104");
    assert.deepEqual(param(parameters, "@excludeMeetingIds"), ["2026-09-29-100000"]);
    assert.equal(param(parameters, "@limit"), 4);
  });
});
