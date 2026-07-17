/**
 * Authentication is intentionally outside the submission contract. Replace
 * this resolver when the Portal adopts Easy Auth, SWA or Auth0; never accept
 * actor identity from multipart fields.
 */
function createSubmissionActorResolver() {
  return {
    async resolve() {
      return { type: "service", subject: "function-key", roles: ["submission:create"] };
    },
  };
}

module.exports = { createSubmissionActorResolver };
