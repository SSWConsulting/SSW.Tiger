const { app } = require("@azure/functions");

const RENEWAL_DAYS = 2.5; // Use 2.5 days instead of 3 to avoid clock drift

app.timer("RenewSubscription", {
  schedule: "0 0 0 * * *", // Every day at midnight (UTC by default)
  handler: async (myTimer, context) => {
    const subscriptionId = process.env.GRAPH_SUBSCRIPTION_ID;
    const subIdShort = subscriptionId?.substring(0, 8) || "N/A";

    if (!subscriptionId) {
      context.log(`[Renew] SKIP: GRAPH_SUBSCRIPTION_ID not configured`);
      return;
    }

    const tenantId = process.env.GRAPH_TENANT_ID;
    const clientId = process.env.GRAPH_CLIENT_ID;
    const clientSecret = process.env.GRAPH_CLIENT_SECRET;

    if (!tenantId || !clientId || !clientSecret) {
      context.error(
        `[Renew] ERROR: Missing Graph credentials (sub:${subIdShort})`,
      );
      return;
    }

    try {
      // Get app token with retry
      const accessToken = await getAccessTokenWithRetry(
        tenantId,
        clientId,
        clientSecret,
        context,
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
      );
    } catch (error) {
      context.error(`[Renew] ERROR: ${error.message} (sub:${subIdShort})`);
    }
  },
});

async function getAccessTokenWithRetry(
  tenantId,
  clientId,
  clientSecret,
  context,
  retries = 1,
) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(
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

    if (response.ok) {
      const { access_token } = await response.json();
      return access_token;
    }

    // Retry on 429 or 5xx
    if (
      (response.status === 429 || response.status >= 500) &&
      attempt < retries
    ) {
      const retryAfter = response.headers.get("Retry-After") || 5;
      context.log(
        `[Renew] Token failed (${response.status}), retry after ${retryAfter}s`,
      );
      await sleep(Number(retryAfter) * 1000);
      continue;
    }

    const error = await response.text();
    context.error(
      `[Renew] ERROR: Token failed - status:${response.status}, body:${error}`,
    );
    return null;
  }
  return null;
}

async function renewSubscriptionWithRetry(
  subscriptionId,
  accessToken,
  newExpiration,
  context,
  retries = 1,
) {
  const subIdShort = subscriptionId.substring(0, 8);

  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(
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

    const requestId = response.headers.get("request-id") || "N/A";

    if (response.ok) {
      const result = await response.json();
      context.log(
        `[Renew] SUCCESS: Expires ${result.expirationDateTime} (sub:${subIdShort}, req:${requestId})`,
      );
      return true;
    }

    // Retry on 429 or 5xx
    if (
      (response.status === 429 || response.status >= 500) &&
      attempt < retries
    ) {
      const retryAfter = response.headers.get("Retry-After") || 5;
      context.log(
        `[Renew] Renewal failed (${response.status}), retry after ${retryAfter}s`,
      );
      await sleep(Number(retryAfter) * 1000);
      continue;
    }

    const error = await response.text();
    context.error(
      `[Renew] ERROR: status:${response.status}, req:${requestId}, body:${error} (sub:${subIdShort})`,
    );
    return false;
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
