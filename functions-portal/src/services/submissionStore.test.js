const test = require("node:test");
const assert = require("node:assert/strict");
const { createSubmissionStore } = require("./submissionStore");

// Minimal Cosmos double: records every query spec so we can assert on the shape
// the store sends, without a live account.
function fakeCosmos(resources = []) {
  const queries = [];
  let containersBuilt = 0;
  const container = {
    items: {
      query(spec) {
        queries.push(spec);
        return { fetchAll: async () => ({ resources }) };
      },
      create: async () => {},
    },
    item: () => ({ delete: async () => {} }),
  };
  return {
    queries,
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
