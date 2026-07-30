const { app } = require("@azure/functions");
const { getSharedSubmissionStore } = require("../services/submissionStore");

// Keeps one instance of the Portal API alive so a browser never pays the cold
// start. Measured on func-tiger-portal-test: ListSubmissions runs in 64 ms warm,
// but the platform tore the instance down roughly 5 minutes after it went idle
// ("DrainMode mode enabled" in the host logs), so an ordinary visit was landing
// on a cold worker and waiting seconds for the SAME 64 ms of work.
//
// A Y1 Consumption plan has no always-on switch and no always-ready instance, so
// this is the cheap substitute: keep executing something before the idle timer
// expires. Every 4 minutes stays comfortably inside that ~5 minute window.
//
// This is a mitigation, not a guarantee. If the platform deallocates anyway, the
// next timer tick pays the cold start instead of a user — which is the point.
// The proper fix is an always-ready instance (Flex Consumption / Premium), which
// costs money; see the notes in portalApiApp.bicep.
//
// Cost: ~10,800 executions/month of a query that matches no rows, against the
// 1,000,000-execution free grant.
//
// To switch it off without a code change, set the app setting
// AzureWebJobs.KeepWarm.Disabled = 1.
const EVERY_4_MINUTES = "0 */4 * * * *";

// This timer also carries the stale-submission sweep — it is the only thing in
// the portal stack already running on a schedule, so the alternative was a second
// timer for a job that runs for a few milliseconds an hour.
//
// Hourly, not every tick: the sweep is a cross-partition query, its cutoff is 90
// minutes, and nothing is gained by asking 15 times an hour. Tracked as a
// timestamp rather than a tick counter so a worker recycle doesn't reset progress
// to "sweep immediately" every time.
const SWEEP_EVERY_MS = 60 * 60 * 1000;

function createKeepWarmHandler({ store, now = () => Date.now() } = {}) {
  // null = "this worker has never swept", which is a deliberate first-tick sweep
  // rather than a timestamp comparison that happens to be true because the epoch
  // is a big number. A worker recycle resets it and costs one extra sweep — the
  // sweep is idempotent and its query matches almost nothing, so that is cheaper
  // than persisting a cursor.
  let lastSweptAt = null;
  return async function keepWarm(_timer, context) {
    const resolved = store || getSharedSubmissionStore();
    // Warming is best-effort. Cosmos being briefly unavailable must not fill the
    // logs with failures on a function whose only job is to stay resident.
    try {
      await resolved.warm();
    } catch (error) {
      context?.log?.(`[TIGER] Keep-warm skipped: ${error.message}`);
      // Cosmos is unreachable, so the sweep would fail for the same reason. Skip
      // it WITHOUT stamping lastSweptAt, so the next tick tries again.
      return;
    }

    if (lastSweptAt !== null && now() - lastSweptAt < SWEEP_EVERY_MS) return;
    lastSweptAt = now();
    try {
      const swept = await resolved.sweepStale();
      if (swept > 0) context?.log?.(`[TIGER] Swept ${swept} stale submission(s) to failed`);
    } catch (error) {
      context?.error?.(`[TIGER] Stale submission sweep failed: ${error.message}`);
    }
  };
}

// Memoized at module scope, NOT rebuilt per tick: the handler closes over the
// "when did I last sweep" timestamp, and building a fresh handler per tick would
// reset that on every invocation — turning the hourly sweep back into a 4-minutely
// one. This was a real bug in the first cut of this function.
let _handler = null;
function getHandler() {
  if (!_handler) _handler = createKeepWarmHandler();
  return _handler;
}

app.timer("KeepWarm", {
  schedule: EVERY_4_MINUTES,
  // The host is already warmed at module scope by ListSubmissions, so firing on
  // startup as well would only duplicate that work.
  runOnStartup: false,
  handler: (timer, context) => getHandler()(timer, context),
});

module.exports = { EVERY_4_MINUTES, SWEEP_EVERY_MS, createKeepWarmHandler };
