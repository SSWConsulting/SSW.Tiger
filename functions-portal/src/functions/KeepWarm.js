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

function createKeepWarmHandler({ store } = {}) {
  return async function keepWarm(_timer, context) {
    // Warming is best-effort. Cosmos being briefly unavailable must not fill the
    // logs with failures on a function whose only job is to stay resident.
    try {
      await (store || getSharedSubmissionStore()).warm();
    } catch (error) {
      context?.log?.(`[TIGER] Keep-warm skipped: ${error.message}`);
    }
  };
}

app.timer("KeepWarm", {
  schedule: EVERY_4_MINUTES,
  // The host is already warmed at module scope by ListSubmissions, so firing on
  // startup as well would only duplicate that work.
  runOnStartup: false,
  handler: (timer, context) => createKeepWarmHandler()(timer, context),
});

module.exports = { EVERY_4_MINUTES, createKeepWarmHandler };
