const test = require("node:test");
const assert = require("node:assert/strict");
const { createSubmissionStorage } = require("./submissionStorage");

// The connection-string branch must not touch DefaultAzureCredential — that is the
// whole point of the seam: a developer with only control-plane Contributor has no
// data-plane blob access, so constructing a credential-backed client would fail at
// upload time (403) even though a usable key/SAS was supplied.
test("uses the connection string and never builds a managed-identity client", () => {
  let credentialUsed = false;
  const credential = new Proxy(
    {},
    {
      get() {
        credentialUsed = true;
        return undefined;
      },
    },
  );

  const storage = createSubmissionStorage({
    connectionString:
      "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
      "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
      "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;",
    credential,
  });

  assert.equal(typeof storage.upload, "function");
  assert.equal(typeof storage.deleteIfExists, "function");
  assert.equal(credentialUsed, false);
});

test("still requires an account name when no connection string is supplied", () => {
  const account = process.env.TRANSCRIPT_STORAGE_ACCOUNT;
  const connection = process.env.TRANSCRIPT_STORAGE_CONNECTION;
  process.env.TRANSCRIPT_STORAGE_ACCOUNT = "";
  process.env.TRANSCRIPT_STORAGE_CONNECTION = "";
  try {
    assert.throws(() => createSubmissionStorage(), /TRANSCRIPT_STORAGE_ACCOUNT is not configured/);
  } finally {
    if (account === undefined) delete process.env.TRANSCRIPT_STORAGE_ACCOUNT;
    else process.env.TRANSCRIPT_STORAGE_ACCOUNT = account;
    if (connection === undefined) delete process.env.TRANSCRIPT_STORAGE_CONNECTION;
    else process.env.TRANSCRIPT_STORAGE_CONNECTION = connection;
  }
});
