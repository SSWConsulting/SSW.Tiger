const test = require("node:test");
const assert = require("node:assert/strict");
const { createSubmissionActorResolver, SERVICE_ACTOR } = require("./submissionActor");

function requestWithPrincipal(principal) {
  const header = principal == null ? null : Buffer.from(JSON.stringify(principal), "utf8").toString("base64");
  return { headers: { get: (name) => (name === "x-ms-client-principal" ? header : null) } };
}

function requestWithRawHeader(value) {
  return { headers: { get: (name) => (name === "x-ms-client-principal" ? value : null) } };
}

const resolver = createSubmissionActorResolver();

test("falls back to the service actor when no principal header is present", async () => {
  assert.deepEqual(await resolver.resolve(requestWithPrincipal(null)), SERVICE_ACTOR);
  assert.deepEqual(await resolver.resolve({}), SERVICE_ACTOR);
});

test("resolves a SWA GitHub principal into a portable user identity", async () => {
  const actor = await resolver.resolve(
    requestWithPrincipal({
      identityProvider: "github",
      userId: "swa-opaque-123",
      userDetails: "willow@ssw.com.au",
      userRoles: ["anonymous", "authenticated"],
    }),
  );
  assert.equal(actor.type, "user");
  assert.equal(actor.subject, "swa-opaque-123");
  assert.equal(actor.provider, "github");
  assert.equal(actor.email, "willow@ssw.com.au");
  assert.equal(actor.displayName, "willow@ssw.com.au");
  // Built-in coarse roles are dropped; only custom roles are kept.
  assert.deepEqual(actor.roles, []);
});

test("keeps custom roles and drops the built-in ones", async () => {
  const actor = await resolver.resolve(
    requestWithPrincipal({
      identityProvider: "aad",
      userId: "u1",
      userDetails: "Willow Lyu",
      userRoles: ["anonymous", "authenticated", "admin"],
    }),
  );
  assert.deepEqual(actor.roles, ["admin"]);
});

test("ignores claims on the API path (no claims array is present there)", async () => {
  // Even if a claims array were supplied, the /api principal never carries one,
  // so email resolves from userDetails only — here a display name, so null.
  const actor = await resolver.resolve(
    requestWithPrincipal({
      identityProvider: "aad",
      userId: "u2",
      userDetails: "Willow Lyu",
      userRoles: ["authenticated"],
      claims: [{ typ: "preferred_username", val: "willow@ssw.com.au" }],
    }),
  );
  assert.equal(actor.email, null);
  assert.equal(actor.displayName, "Willow Lyu");
});

test("returns null email when userDetails is not an email", async () => {
  const actor = await resolver.resolve(
    requestWithPrincipal({
      identityProvider: "aad",
      userId: "u3",
      userDetails: "Willow Lyu",
      userRoles: ["authenticated"],
    }),
  );
  assert.equal(actor.email, null);
});

test("defensively falls back when the header is malformed or missing userId", async () => {
  assert.deepEqual(await resolver.resolve(requestWithRawHeader("not-base64-@@@")), SERVICE_ACTOR);
  assert.deepEqual(
    await resolver.resolve(requestWithRawHeader(Buffer.from("{not json").toString("base64"))),
    SERVICE_ACTOR,
  );
  assert.deepEqual(
    await resolver.resolve(requestWithPrincipal({ identityProvider: "aad", userRoles: [] })),
    SERVICE_ACTOR,
  );
});
