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
  /**
   * The last principal /.auth/me returned, readable SYNCHRONOUSLY so the first
   * paint isn't gated on that round trip. Optimistic: me() still runs and
   * corrects it, including dropping to the sign-in view if the session is gone.
   */
  cachedMe(): ClientPrincipal | null;
  /** Forgets the remembered principal — called on sign-out. */
  forget(): void;
  loginUrl(returnTo?: string): string;
  logoutUrl(returnTo?: string): string;
}

// localStorage, not sessionStorage: the wait this removes was most visible on a
// FRESH tab, which is exactly where sessionStorage is empty. Nothing secret lives
// here — it is the same name/email the header already renders — unlike the
// submission rows, which carry dashboard passwords and stay tab-scoped.
const PRINCIPAL_KEY = "tiger.principal";

export class SwaAuthClient implements AuthClient {
  // In local dev there is no SWA edge serving /.auth/me; a dev principal keeps
  // the app usable without standing up SWA. Null in production.
  constructor(private readonly devPrincipal: ClientPrincipal | null = null) {}

  async me(): Promise<ClientPrincipal | null> {
    return this.remember(await this.fetchMe());
  }

  private async fetchMe(): Promise<ClientPrincipal | null> {
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

  cachedMe(): ClientPrincipal | null {
    const raw = this.read();
    if (!raw) return null;
    try {
      const principal = JSON.parse(raw) as ClientPrincipal | null;
      // A principal without a userId cannot scope the submissions cache, which is
      // the whole reason we read this early — treat it as nothing known.
      return typeof principal?.userId === "string" && principal.userId ? principal : null;
    } catch {
      this.forget();
      return null;
    }
  }

  forget(): void {
    try {
      window.localStorage.removeItem(PRINCIPAL_KEY);
    } catch {
      /* Storage is best-effort: blocked or full must not break auth. */
    }
  }

  private read(): string | null {
    try {
      return window.localStorage.getItem(PRINCIPAL_KEY);
    } catch {
      return null;
    }
  }

  // Anything other than a live principal clears the cache, so an expired session
  // cannot keep painting the shell for a user who is no longer signed in.
  private remember(principal: ClientPrincipal | null): ClientPrincipal | null {
    if (!principal) {
      this.forget();
      return principal;
    }
    try {
      window.localStorage.setItem(PRINCIPAL_KEY, JSON.stringify(principal));
    } catch {
      /* Best-effort — the app works without the optimistic first paint. */
    }
    return principal;
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
  return claim?.val.includes("@") ? claim.val.toLowerCase() : null;
}

export function principalInitials(principal: ClientPrincipal): string {
  const name = principalName(principal).trim();
  // Keep only tokens that begin with a letter, so Teams-style suffixes like
  // "[SSW]" don't leak into the initials ("Willow Lyu [SSW]" → "WL", not "W[").
  const parts = name.split(/\s+/).filter((p) => /^\p{L}/u.test(p));
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (parts[0]?.slice(0, 2) || "?").toUpperCase();
}
