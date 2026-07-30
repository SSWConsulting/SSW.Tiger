const test = require("node:test");
const assert = require("node:assert/strict");
const { createSubmissionStore } = require("./submissionStore");

// Minimal Cosmos double: records every query spec so we can assert on the shape
// the store sends, without a live account.
function fakeCosmos(resources = [], { patch } = {}) {
  const queries = [];
  const patches = [];
  let containersBuilt = 0;
  const container = {
    items: {
      query(spec) {
        queries.push(spec);
        return { fetchAll: async () => ({ resources }) };
      },
      create: async () => {},
    },
    item: (id, partitionKey) => ({
      delete: async () => {},
      patch: async (operations) => {
        patches.push({ id, partitionKey, operations });
        if (patch) await patch(id);
      },
    }),
  };
  return {
    queries,
    patches,
    containersBuilt: () => containersBuilt,
    client: {
      database: () => ({
        container: () => {
          containersBuilt += 1;
          return container;
        },
      }),
    },
  };
}

test("sweepStale fails only records older than the cutoff, per partition", async () => {
  const cosmos = fakeCosmos([
    { id: "r1", projectName: "tiger" },
    { id: "r2", projectName: "northwind" },
  ]);
  const store = createSubmissionStore({ endpoint: "https://cosmos.example", client: cosmos.client });
  const now = Date.parse("2026-07-30T12:00:00.000Z");

  const swept = await store.sweepStale({ now });

  assert.equal(swept, 2);
  // The cutoff must clear the Job's own 60-minute replicaTimeout, or a slow but
  // healthy run would be marked failed underneath itself.
  const cutoff = cosmos.queries[0].parameters[0].value;
  assert.ok(now - Date.parse(cutoff) >= 90 * 60 * 1000);
  assert.match(cosmos.queries[0].query, /c\.status IN \('accepted', 'processing'\)/);
  // Each row is patched under its OWN partition key — these rows are in different
  // partitions, which is exactly why this cannot be a transactional batch.
  assert.deepEqual(
    cosmos.patches.map((p) => [p.id, p.partitionKey]),
    [
      ["r1", "tiger"],
      ["r2", "northwind"],
    ],
  );
  const ops = Object.fromEntries(cosmos.patches[0].operations.map((o) => [o.path, o.value]));
  assert.equal(ops["/status"], "failed");
  assert.match(ops["/failureReason"], /did not finish in time/);
});

test("sweepStale keeps going when one record cannot be patched", async () => {
  // A row the Job finished between our query and our patch is the common case;
  // abandoning the rest of the sweep because of it would leave them stuck forever.
  const cosmos = fakeCosmos(
    [
      { id: "r1", projectName: "tiger" },
      { id: "r2", projectName: "northwind" },
    ],
    {
      patch: async (id) => {
        if (id === "r1") throw Object.assign(new Error("not found"), { code: 404 });
      },
    },
  );
  const store = createSubmissionStore({ endpoint: "https://cosmos.example", client: cosmos.client });

  assert.equal(await store.sweepStale({ now: Date.now() }), 1);
  assert.equal(cosmos.patches.length, 2);
});

test("listByUser scopes the query to the caller's subject", async () => {
  const cosmos = fakeCosmos([{ requestId: "r1" }]);
  const store = createSubmissionStore({ endpoint: "https://cosmos.example", client: cosmos.client });

  const rows = await store.listByUser("u-1");

  assert.deepEqual(rows, [{ requestId: "r1" }]);
  assert.deepEqual(cosmos.queries[0].parameters, [{ name: "@sub", value: "u-1" }]);
  assert.match(cosmos.queries[0].query, /c\.userSubject = @sub/);
  // The password must be in the projection — the portal list is the only place a
  // portal submitter ever learns it (no Teams notification carries it).
  assert.match(cosmos.queries[0].query, /c\.dashboardPassword/);
  // Likewise the failure reason — a failed row with no explanation just reads
  // "Unavailable" and generates a support ticket.
  assert.match(cosmos.queries[0].query, /c\.failureReason/);
});

test("warm runs the real listByUser query shape so it primes the same path", async () => {
  const cosmos = fakeCosmos();
  const store = createSubmissionStore({ endpoint: "https://cosmos.example", client: cosmos.client });

  await store.warm();

  assert.equal(cosmos.queries.length, 1);
  // A sentinel subject no real principal can hold, so warming never returns rows.
  assert.deepEqual(cosmos.queries[0].parameters, [{ name: "@sub", value: "__warm__" }]);
  assert.match(cosmos.queries[0].query, /c\.userSubject = @sub/);
});

test("warm leaves the container built and reused by the next real request", async () => {
  const cosmos = fakeCosmos();
  const store = createSubmissionStore({ endpoint: "https://cosmos.example", client: cosmos.client });

  await store.warm();
  await store.listByUser("u-1");

  // The whole point of warming: the request that follows reuses the primed
  // client rather than constructing (and re-authenticating) its own.
  assert.equal(cosmos.containersBuilt(), 1);
});

test("fails clearly when Cosmos is not configured", async () => {
  const store = createSubmissionStore({ endpoint: "" });
  await assert.rejects(() => store.listByUser("u-1"), /COSMOS_ENDPOINT is not configured/);
});

test("deleteIfExists swallows a 404 but surfaces anything else", async () => {
  const build = (code) =>
    createSubmissionStore({
      endpoint: "https://cosmos.example",
      client: {
        database: () => ({
          container: () => ({
            item: () => ({
              delete: async () => {
                const error = new Error("boom");
                error.code = code;
                throw error;
              },
            }),
          }),
        }),
      },
    });

  await build(404).deleteIfExists("r1", "tiger");
  await assert.rejects(() => build(500).deleteIfExists("r1", "tiger"), /boom/);
});
