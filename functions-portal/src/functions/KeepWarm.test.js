const test = require("node:test");
const assert = require("node:assert/strict");
const { EVERY_4_MINUTES, createKeepWarmHandler } = require("./KeepWarm");

test("fires more often than the observed ~5 minute idle teardown", () => {
  // If this interval ever drifts past the platform's idle window, users start
  // paying the cold start again — which is the whole bug this function exists for.
  assert.equal(EVERY_4_MINUTES, "0 */4 * * * *");
});

test("warms the store on each tick", async () => {
  let warmed = 0;
  const handler = createKeepWarmHandler({
    store: {
      warm: async () => {
        warmed += 1;
      },
    },
  });
  await handler({}, {});
  assert.equal(warmed, 1);
});

test("swallows a warm failure so the timer keeps the instance resident", async () => {
  const logged = [];
  const handler = createKeepWarmHandler({
    store: {
      warm: async () => {
        throw new Error("cosmos unreachable");
      },
    },
  });
  // Must not reject: a failed warm-up is not a failed function.
  await handler({}, { log: (m) => logged.push(m) });
  assert.match(logged[0], /Keep-warm skipped: cosmos unreachable/);
});
