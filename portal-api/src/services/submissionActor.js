/**
 * Resolves the authenticated actor from the SWA / Easy Auth `x-ms-client-principal`
 * header. The platform base64-encodes a JSON principal and (critically) strips any
 * client-supplied copy of this header, so a value present here is trustworthy —
 * PROVIDED the Function is only reachable through SWA. Keep authLevel:"function"
 * so the Function key blocks direct, header-forging calls.
 *
 * We capture a PORTABLE identity (subject + provider + email), not just the
 * provider-specific opaque userId, so future project-admin grants can key off a
 * stable email/UPN. Never accept actor identity from multipart form fields.
 */

// Fallback identity for the current function-key path (no logged-in user, e.g.
// direct key call in prod or local dev). Shape stays compatible with the default
// actor in submissionService.
const SERVICE_ACTOR = Object.freeze({
  type: "service",
  subject: "function-key",
  provider: "function-key",
  email: null,
  displayName: "",
  roles: ["submission:create"],
});

function decodePrincipal(request) {
  const header = request?.headers?.get?.("x-ms-client-principal");
  if (!header) return null;
  let principal;
  try {
    principal = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (!principal || typeof principal !== "object") return null;
  if (typeof principal.userId !== "string" || !principal.userId.trim()) return null;
  return principal;
}

// The x-ms-client-principal header on the /api path has NO claims array (claims
// are only exposed on /.auth/me), so email can only come from userDetails. For
// the AAD provider userDetails IS the UPN/email; otherwise email is null.
function extractEmail(principal) {
  return typeof principal.userDetails === "string" && principal.userDetails.includes("@")
    ? principal.userDetails.toLowerCase()
    : null;
}

function createSubmissionActorResolver() {
  return {
    async resolve(request) {
      const principal = decodePrincipal(request);
      if (!principal) return { ...SERVICE_ACTOR };

      // Drop the built-in "anonymous"/"authenticated" pseudo-roles from the
      // stored set — authorization is by application data (owner/admin lookup),
      // not by these coarse SWA route roles.
      const roles = Array.isArray(principal.userRoles)
        ? principal.userRoles.filter((r) => typeof r === "string" && r !== "anonymous" && r !== "authenticated")
        : [];

      return {
        type: "user",
        subject: principal.userId,
        provider: typeof principal.identityProvider === "string" ? principal.identityProvider : "unknown",
        email: extractEmail(principal),
        displayName: typeof principal.userDetails === "string" ? principal.userDetails : "",
        roles,
      };
    },
  };
}

module.exports = { createSubmissionActorResolver, SERVICE_ACTOR };
