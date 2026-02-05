const { app } = require("@azure/functions");

const RENEWAL_DAYS = 2.5; // Use 2.5 days instead of 3 to avoid clock drift
const FETCH_TIMEOUT_MS = 30000; // 30 seconds timeout for fetch requests
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000; // Base delay for exponential backoff

// Log prefix for easy filtering
const LOG_PREFIX = "[TIGER]";

app.timer("RenewSubscription", {
  schedule: "0 0 0 * * *", // Every day at midnight (UTC by default)
  handler: async (myTimer, context) => {
    const subscriptionId = process.env.GRAPH_SUBSCRIPTION_ID;
    const invocationId = context.invocationId;

    const logContext = {
      invocationId,
      subscriptionId: subscriptionId?.substring(0, 8) || "N/A",
      operation: "RenewSubscription",
    };

    if (!subscriptionId) {
      structuredLog(context, "info", "SKIP: GRAPH_SUBSCRIPTION_ID not configured", logContext);
      return;
    }

    const tenantId = process.env.GRAPH_TENANT_ID;
    const clientId = process.env.GRAPH_CLIENT_ID;
    const clientSecret = process.env.GRAPH_CLIENT_SECRET;

    if (!tenantId || !clientId || !clientSecret) {
      structuredLog(context, "error", "Missing Graph credentials", {
        ...logContext,
        missingVars: [
          !tenantId && "GRAPH_TENANT_ID",
          !clientId && "GRAPH_CLIENT_ID",
          !clientSecret && "GRAPH_CLIENT_SECRET",
        ].filter(Boolean),
      });
      return;
    }

    try {
      // Get app token with retry and exponential backoff
      const accessToken = await getAccessTokenWithRetry(
        tenantId,
        clientId,
        clientSecret,
        context,
        logContext,
      );

      if (!accessToken) {
        return;
      }

      // Renew subscription
      const newExpiration = new Date(
        Date.now() + RENEWAL_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();

      await renewSubscriptionWithRetry(
        subscriptionId,
        accessToken,
        newExpiration,
        context,
        logContext,
      );
    } catch (error) {
      structuredLog(context, "error", `Unexpected error: ${error.message}`, {
        ...logContext,
        error: error.message,
        stack: error.stack,
      });
    }
  },
});

/**
 * Structured logging helper for consistent log format
 * Note: timestamp is added automatically by Azure runtime
 */
function structuredLog(context, level, message, data) {
  const logEntry = {
    level,
    message: `${LOG_PREFIX} ${message}`,
    ...data,
  };

  if (level === "error") {
    context.error(JSON.stringify(logEntry));
  } else if (level === "warn") {
    context.warn(JSON.stringify(logEntry));
  } else {
    context.log(JSON.stringify(logEntry));
  }
}

/**
 * Fetch with timeout using AbortController
 */
async function fetchWithTimeout(url, options, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Calculate exponential backoff delay with jitter
 */
function getBackoffDelay(attempt) {
  const exponentialDelay = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * 1000; // Add 0-1s jitter
  return Math.min(exponentialDelay + jitter, 30000); // Cap at 30s
}

async function getAccessTokenWithRetry(
  tenantId,
  clientId,
  clientSecret,
  context,
  logContext,
) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const startTime = Date.now();

    try {
      const response = await fetchWithTimeout(
        `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            scope: "https://graph.microsoft.com/.default",
            grant_type: "client_credentials",
          }),
        },
      );

      const duration = Date.now() - startTime;

      if (response.ok) {
        const { access_token } = await response.json();
        structuredLog(context, "info", "Token acquired successfully", {
          ...logContext,
          attempt: attempt + 1,
          durationMs: duration,
        });
        return access_token;
      }

      // Retry on 429 or 5xx
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = response.headers.get("Retry-After");
        const delay = retryAfter
          ? Number(retryAfter) * 1000
          : getBackoffDelay(attempt);

        structuredLog(context, "warn", "Token request failed, retrying", {
          ...logContext,
          attempt: attempt + 1,
          status: response.status,
          retryDelayMs: delay,
        });

        await sleep(delay);
        continue;
      }

      // Non-retryable error
      const error = await response.text();
      structuredLog(context, "error", "Token request failed (non-retryable)", {
        ...logContext,
        attempt: attempt + 1,
        status: response.status,
        error,
      });
      return null;
    } catch (err) {
      if (err.name === "AbortError") {
        structuredLog(context, "error", "Token request timed out", {
          ...logContext,
          attempt: attempt + 1,
          timeoutMs: FETCH_TIMEOUT_MS,
        });
      } else {
        structuredLog(context, "error", `Token request error: ${err.message}`, {
          ...logContext,
          attempt: attempt + 1,
          error: err.message,
        });
      }

      if (attempt < MAX_RETRIES - 1) {
        const delay = getBackoffDelay(attempt);
        await sleep(delay);
      }
    }
  }

  structuredLog(context, "error", "Token acquisition failed after all retries", logContext);
  return null;
}

async function renewSubscriptionWithRetry(
  subscriptionId,
  accessToken,
  newExpiration,
  context,
  logContext,
) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const startTime = Date.now();

    try {
      const response = await fetchWithTimeout(
        `https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ expirationDateTime: newExpiration }),
        },
      );

      const duration = Date.now() - startTime;
      const requestId = response.headers.get("request-id") || "N/A";

      if (response.ok) {
        const result = await response.json();
        structuredLog(context, "info", "Subscription renewed successfully", {
          ...logContext,
          attempt: attempt + 1,
          requestId,
          newExpiration: result.expirationDateTime,
          durationMs: duration,
        });
        return true;
      }

      // Retry on 429 or 5xx
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = response.headers.get("Retry-After");
        const delay = retryAfter
          ? Number(retryAfter) * 1000
          : getBackoffDelay(attempt);

        structuredLog(context, "warn", "Renewal failed, retrying", {
          ...logContext,
          attempt: attempt + 1,
          status: response.status,
          requestId,
          retryDelayMs: delay,
        });

        await sleep(delay);
        continue;
      }

      // Non-retryable error
      const error = await response.text();
      structuredLog(context, "error", "Renewal failed (non-retryable)", {
        ...logContext,
        attempt: attempt + 1,
        status: response.status,
        requestId,
        error,
      });
      return false;
    } catch (err) {
      if (err.name === "AbortError") {
        structuredLog(context, "error", "Renewal request timed out", {
          ...logContext,
          attempt: attempt + 1,
          timeoutMs: FETCH_TIMEOUT_MS,
        });
      } else {
        structuredLog(context, "error", `Renewal request error: ${err.message}`, {
          ...logContext,
          attempt: attempt + 1,
          error: err.message,
        });
      }

      if (attempt < MAX_RETRIES - 1) {
        const delay = getBackoffDelay(attempt);
        await sleep(delay);
      }
    }
  }

  structuredLog(context, "error", "Renewal failed after all retries", logContext);
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
