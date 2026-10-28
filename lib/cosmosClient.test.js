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

it('persists the original subject and retains recovered subjects during manual reprocessing', async () => {
  const { upsertMeeting } = require('./cosmosClient');
  let saved;
  const container = {
    item: () => ({ read: async () => ({ resource: saved }) }),
    items: { upsert: async document => { saved = document; return { resource: document }; } },
  };
  const params = { projectName: 'yak', meetingId: '2026-10-28-120000', meetingDate: '2026-10-28', dashboardPath: 'yak/2026-10-28-120000', metadata: { participantCount: 6 }, consolidated: {} };
  await upsertMeeting({ ...params, meetingSubject: ' [YakShaver] Sprint Review ' }, { container });
  assert.equal(saved.meetingSubject, '[YakShaver] Sprint Review');
  await upsertMeeting(params, { container });
  assert.equal(saved.meetingSubject, '[YakShaver] Sprint Review');
  assert.equal(saved.metadata.participantCount, 6);
  assert.match(buildMeetingsQuery({ projectName: 'yak', excludeConsolidated: true }).query, /c\.meetingSubject/);
});
