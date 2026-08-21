const { DefaultAzureCredential, ManagedIdentityCredential } = require("@azure/identity");

// Polyfill globalThis.crypto for @azure/identity where Web Crypto isn't global.
if (!globalThis.crypto) globalThis.crypto = require("node:crypto");

/**
 * The data-plane credential for this app's shared user-assigned managed identity
 * (Cosmos + Blob). One place so every client authenticates the same way.
 *
 * Deliberately NOT DefaultAzureCredential when deployed. That chain ends with the
 * developer-tool credentials (Azure CLI / PowerShell / azd), which on a Linux
 * Function container try to spawn executables that aren't installed. While
 * managed identity succeeds those never run, so the median request is unchanged —
 * but when IMDS is briefly slow or throttled the chain walks on instead of
 * failing, turning a clean error into a slow one on the tail. Naming the
 * credential removes that path, and removes the ambiguity of which identity a
 * user-assigned MI resolves to.
 *
 * AZURE_CLIENT_ID is injected by infra/modules/portalApiApp.bicep. Without it
 * (local dev) fall back to the full chain so `az login` still works.
 *
 * Cached at module scope so the in-memory token cache is reused across
 * invocations on a warm instance rather than re-authenticating to IMDS.
 */
let cached = null;
function getDataPlaneCredential() {
  if (cached) return cached;
  const clientId = process.env.AZURE_CLIENT_ID;
  cached = clientId ? new ManagedIdentityCredential({ clientId }) : new DefaultAzureCredential();
  return cached;
}

module.exports = { getDataPlaneCredential };
