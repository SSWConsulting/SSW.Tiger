// SWA auth is consumed only through this client, mirroring the RequestAdapter /
// submissionActor seam on the API side. Swapping providers (or replacing SWA
// entirely) changes only this file.
//
// Identity here comes from `/.auth/me`, which DOES include the `claims` array.
// (Note: the `x-ms-client-principal` header on the /api path does NOT carry
// claims — the backend actor relies on userId/userDetails instead.)

export type ClientPrincipal = {
  identityProvider: string;
  userId: string;
  userDetails: string;
  userRoles: string[];
  claims?: { typ: string; val: string }[];
};

export interface AuthClient {
  me(): Promise<ClientPrincipal | null>;
  loginUrl(returnTo?: string): string;
  logoutUrl(returnTo?: string): string;
}

export class SwaAuthClient implements AuthClient {
  // In local dev there is no SWA edge serving /.auth/me; a dev principal keeps
  // the app usable without standing up SWA. Null in production.
  constructor(private readonly devPrincipal: ClientPrincipal | null = null) {}

  async me(): Promise<ClientPrincipal | null> {
    try {
      const response = await fetch("/.auth/me", {
        headers: { accept: "application/json" },
        credentials: "same-origin",
      });
      if (!response.ok) return this.devPrincipal;
      const body = await response.json().catch(() => null);
      return body?.clientPrincipal ?? this.devPrincipal;
    } catch {
      return this.devPrincipal;
    }
  }

  loginUrl(returnTo = "/"): string {
    return `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(returnTo)}`;
  }

  logoutUrl(returnTo = "/"): string {
    return `/.auth/logout?post_logout_redirect_uri=${encodeURIComponent(returnTo)}`;
  }
}

const EMAIL_CLAIM_TYPES = ["email", "emails", "preferred_username", "upn"];

export function principalName(principal: ClientPrincipal): string {
  const nameClaim = principal.claims?.find((c) => c.typ === "name" || c.typ.endsWith("/name"));
  return nameClaim?.val || principal.userDetails || "Signed in";
}

export function principalEmail(principal: ClientPrincipal): string | null {
  if (principal.userDetails?.includes("@")) return principal.userDetails.toLowerCase();
  const claim = principal.claims?.find((c) => EMAIL_CLAIM_TYPES.includes(c.typ) || c.typ.endsWith("/emailaddress"));
  return claim && claim.val.includes("@") ? claim.val.toLowerCase() : null;
}

export function principalInitials(principal: ClientPrincipal): string {
  const name = principalName(principal).trim();
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (parts[0]?.slice(0, 2) || "?").toUpperCase();
}
