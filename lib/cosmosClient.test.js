const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildMeetingsQuery,
  buildPriorSubjectQuery,
  findPriorMeetingSubject,
  upsertMeeting,
} = require("./cosmosClient");
const { latestUnalertedSeries } = require("../azure-function/src/functions/organizerCheck");

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

/**
 * In-memory stand-in for a Cosmos container: just the calls upsertMeeting and
 * the organizer check's markAlerted() make.
 */
function fakeContainer() {
  const docs = new Map();
  const key = (id, partitionKey) => `${partitionKey}/${id}`;
  return {
    docs,
    item(id, partitionKey) {
      return {
        async read() {
          const doc = docs.get(key(id, partitionKey));
          if (!doc) throw Object.assign(new Error("Entity not found"), { code: 404 });
          return { resource: structuredClone(doc) };
        },
        async patch(ops) {
          const doc = docs.get(key(id, partitionKey));
          for (const op of ops) doc[op.path.slice(1)] = op.value;
          return { resource: structuredClone(doc) };
        },
      };
    },
    items: {
      async upsert(doc) {
        docs.set(key(doc.id, doc.projectName), structuredClone(doc));
        return { resource: structuredClone(doc) };
      },
    },
  };
}

describe("upsertMeeting", () => {
  const meeting = {
    projectName: "tina",
    meetingId: "2026-10-13-130104",
    meetingDate: "2026-10-13",
    dashboardPath: "tina/2026-10-13-130104",
    consolidated: { participants: [] },
    teamsMeeting: { onlineMeetingId: "series-1", organizerUserId: "gone-user" },
  };

  it("keeps the organizer alert marker when an alerted meeting is reprocessed", async () => {
    const container = fakeContainer();

    // Processed, then alerted by CheckMeetingOrganizers
    await upsertMeeting(meeting, { container });
    await container
      .item("tina-2026-10-13-130104", "tina")
      .patch([{ op: "add", path: "/organizerAlertSentAt", value: "2026-10-20T22:00:00Z" }]);

    // Reprocessed (e.g. via the manual trigger)
    const result = await upsertMeeting(
      { ...meeting, consolidated: { participants: ["Ada"] } },
      { container },
    );

    assert.equal(result.organizerAlertSentAt, "2026-10-20T22:00:00Z");
    assert.deepEqual(result.consolidated, { participants: ["Ada"] });

    // The next organizer check must not alert this series again
    const stored = [...container.docs.values()];
    assert.deepEqual(latestUnalertedSeries(stored), []);
  });

  it("writes a new meeting without an alert marker", async () => {
    const container = fakeContainer();

    const result = await upsertMeeting(meeting, { container });

    assert.equal(result.id, "tina-2026-10-13-130104");
    assert.equal("organizerAlertSentAt" in result, false);
    assert.equal(latestUnalertedSeries([...container.docs.values()]).length, 1);
  });

  it("fails rather than overwrite when the existing record can't be read", async () => {
    const container = fakeContainer();
    container.item = () => ({
      async read() {
        throw Object.assign(new Error("Request rate is large"), { code: 429 });
      },
    });

    await assert.rejects(upsertMeeting(meeting, { container }), /Request rate is large/);
    assert.equal(container.docs.size, 0);
  });
});

describe("findPriorMeetingSubject", () => {
  it("asks for the latest run of the series that has a subject", () => {
    const { query, parameters } = buildPriorSubjectQuery("series-1");

    assert.equal(param(parameters, "@onlineMeetingId"), "series-1");
    assert.match(query, /c\.teamsMeeting\.onlineMeetingId = @onlineMeetingId/);
    // Runs made after the organizer left stored an empty subject; skip them
    assert.match(query, /LENGTH\(c\.teamsMeeting\.subject\) > 0/);
    assert.match(query, /^SELECT TOP 1 .* ORDER BY c\.meetingId DESC$/);
  });

  it("returns the first match, or null when the series has never been processed", async () => {
    const queried = [];
    const containerWith = (resources) => ({
      items: {
        query(spec) {
          queried.push(spec);
          return { fetchAll: async () => ({ resources }) };
        },
      },
    });
    const prior = { subject: "SSW Design - Sprint Review", projectName: "ssw-design", meetingId: "2026-11-06-103000" };

    assert.deepEqual(await findPriorMeetingSubject("series-1", { container: containerWith([prior]) }), prior);
    assert.equal(await findPriorMeetingSubject("series-1", { container: containerWith([]) }), null);
    assert.equal(await findPriorMeetingSubject("", { container: containerWith([prior]) }), null);
    assert.equal(queried.length, 2);
  });
});
