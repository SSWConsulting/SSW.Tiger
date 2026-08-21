const test = require("node:test");
const assert = require("node:assert/strict");
const { EVERY_4_MINUTES, SWEEP_EVERY_MS, createKeepWarmHandler } = require("./KeepWarm");

// Store double: counts warms and sweeps so we can assert the two run on their own
// cadences off the SAME timer.
function fakeStore({ warm, sweepStale } = {}) {
  const calls = { warmed: 0, swept: 0 };
  return {
    calls,
    warm: async () => {
      calls.warmed += 1;
      if (warm) await warm();
    },
    sweepStale: async () => {
      calls.swept += 1;
      return sweepStale ? sweepStale() : 0;
    },
  };
}

test("fires more often than the observed ~5 minute idle teardown", () => {
  // If this interval ever drifts past the platform's idle window, users start
  // paying the cold start again — which is the whole bug this function exists for.
  assert.equal(EVERY_4_MINUTES, "0 */4 * * * *");
});

test("warms the store on each tick", async () => {
  const store = fakeStore();
  const handler = createKeepWarmHandler({ store });
  await handler({}, {});
  assert.equal(store.calls.warmed, 1);
});

test("swallows a warm failure so the timer keeps the instance resident", async () => {
  const logged = [];
  const store = fakeStore({
    warm: () => {
      throw new Error("cosmos unreachable");
    },
  });
  const handler = createKeepWarmHandler({ store });
  // Must not reject: a failed warm-up is not a failed function.
  await handler({}, { log: (m) => logged.push(m) });
  assert.match(logged[0], /Keep-warm skipped: cosmos unreachable/);
  // Cosmos is down, so the sweep would fail identically — and skipping it must NOT
  // consume the hourly slot, or an outage would silently postpone the next sweep.
  assert.equal(store.calls.swept, 0);
});

test("sweeps stale submissions hourly, not on every 4-minute tick", async () => {
  const store = fakeStore({ sweepStale: () => 2 });
  let clock = 1_000_000;
  const logged = [];
  const handler = createKeepWarmHandler({ store, now: () => clock });
  const context = { log: (m) => logged.push(m) };

  await handler({}, context);
  assert.equal(store.calls.swept, 1, "first tick sweeps");
  assert.match(logged[0], /Swept 2 stale submission\(s\)/);

  // Several more keep-warm ticks inside the same hour.
  for (let i = 0; i < 5; i++) {
    clock += 4 * 60 * 1000;
    await handler({}, context);
  }
  assert.equal(store.calls.warmed, 6, "every tick still warms");
  assert.equal(store.calls.swept, 1, "but none of them sweeps again");

  clock += SWEEP_EVERY_MS;
  await handler({}, context);
  assert.equal(store.calls.swept, 2);
});

test("the sweep throttle lives in the handler, so the handler must be reused", async () => {
  // Regression: the timer registration originally built a NEW handler on every
  // tick, which reset the throttle each time and made the "hourly" sweep run every
  // 4 minutes. Rebuilding here reproduces that; the module now memoizes instead.
  const store = fakeStore();
  const clock = 1_000_000;
  await createKeepWarmHandler({ store, now: () => clock })({}, {});
  await createKeepWarmHandler({ store, now: () => clock })({}, {});
  assert.equal(store.calls.swept, 2, "a rebuilt handler always sweeps — this is the trap");

  const reused = createKeepWarmHandler({ store, now: () => clock });
  await reused({}, {});
  await reused({}, {});
  assert.equal(store.calls.swept, 3, "a reused handler sweeps once and then throttles");
});

test("a sweep failure does not take down the keep-warm", async () => {
  const errors = [];
  const store = fakeStore({
    sweepStale: () => {
      throw new Error("query timed out");
    },
  });
  const handler = createKeepWarmHandler({ store });

  await handler({}, { error: (m) => errors.push(m) });

  assert.equal(store.calls.warmed, 1);
  assert.match(errors[0], /Stale submission sweep failed: query timed out/);
});
