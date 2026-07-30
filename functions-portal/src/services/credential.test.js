const test = require("node:test");
const assert = require("node:assert/strict");

// The credential is cached at module scope, so each case needs a fresh load.
function loadFresh() {
  delete require.cache[require.resolve("./credential")];
  return require("./credential");
}

test("names the user-assigned managed identity when AZURE_CLIENT_ID is injected", () => {
  const previous = process.env.AZURE_CLIENT_ID;
  process.env.AZURE_CLIENT_ID = "11111111-2222-3333-4444-555555555555";
  try {
    const credential = loadFresh().getDataPlaneCredential();
    // Not DefaultAzureCredential: its chain ends in developer-tool credentials
    // that try to spawn executables absent from a Linux Function container.
    assert.equal(credential.constructor.name, "ManagedIdentityCredential");
  } finally {
    if (previous === undefined) delete process.env.AZURE_CLIENT_ID;
    else process.env.AZURE_CLIENT_ID = previous;
  }
});

test("falls back to the full chain locally so az login still works", () => {
  const previous = process.env.AZURE_CLIENT_ID;
  delete process.env.AZURE_CLIENT_ID;
  try {
    assert.equal(loadFresh().getDataPlaneCredential().constructor.name, "DefaultAzureCredential");
  } finally {
    if (previous !== undefined) process.env.AZURE_CLIENT_ID = previous;
  }
});

test("reuses one credential so the token cache survives across invocations", () => {
  const { getDataPlaneCredential } = loadFresh();
  assert.equal(getDataPlaneCredential(), getDataPlaneCredential());
});
