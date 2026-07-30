import type { SubmissionSummary } from "./SubmissionClient";

// Why this layer exists: GET /api/v1/submissions runs on a Y1 Consumption
// Function App with no always-on instance, so a cold call is measured in
// seconds, not milliseconds. Two consequences drive the design:
//
//  1. The request must start as EARLY as possible — at module load, in parallel
//     with the /.auth/me round trip and React hydration. App.tsx gates all
//     rendering on the auth check, so a fetch owned by DashboardsView cannot
//     begin until auth resolves; those two waits were stacking. prefetch()
//     breaks that serialization.
//  2. Whatever we already know must paint immediately and must never be blanked
//     by a revalidation, so switching tabs doesn't re-show a spinner over data
//     we already have.
//
// Passwords ARE cached here, unlike the earlier strip-before-caching approach.
// Withholding them meant the Password line popped in seconds after the rest of
// its row had rendered. The threat stripping was really guarding against — same
// tab, one user signs out, another signs in — is handled properly instead by
// stamping the owner into the envelope and discarding on mismatch (readSession).
// sessionStorage grants an attacker nothing they don't already have: a script
// executing on this origin could simply call the API with the session cookie.

const STORAGE_KEY = "tiger.submissions";

// Tab switches remount the view. Re-fetching every time would pay the cold start
// again for data that is seconds old, but statuses do move (accepted →
// processing → completed), so anything older than this earns a quiet
// background revalidate.
const FRESH_MS = 15_000;

export type SubmissionsState = {
  // null means "nothing known yet" — the only state that justifies a full-panel
  // spinner. An empty array is a real answer (no submissions).
  items: SubmissionSummary[] | null;
  refreshing: boolean;
  error: string;
};

type Envelope = { owner: string; items: SubmissionSummary[] };

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type ListFn = (options?: { silent?: boolean }) => Promise<SubmissionSummary[]>;

// sessionStorage access throws outright in some privacy modes, so probe once and
// fall back to no caching rather than letting it break the view.
function defaultStore(): KeyValueStore | null {
  try {
    const probe = `${STORAGE_KEY}.probe`;
    window.sessionStorage.setItem(probe, "1");
    window.sessionStorage.removeItem(probe);
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export class SubmissionsCache {
  private state: SubmissionsState = { items: null, refreshing: false, error: "" };
  private inFlight: Promise<void> | null = null;
  private lastLoadedAt = 0;
  private owner: string | null = null;
  // Whether the rows on screen came from storage rather than the network. Only
  // hydrated rows can belong to the wrong user, so only they get discarded when
  // bindOwner learns the real identity (see below).
  private fromCache = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly list: ListFn,
    private readonly storage: KeyValueStore | null = defaultStore(),
  ) {}

  // Arrow properties so they can be handed to useSyncExternalStore directly
  // without a per-render bind (which would resubscribe on every render).
  readonly snapshot = (): SubmissionsState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Speculative load, fired before we know who (or whether) the user is.
   * `silent` keeps a 401 from hijacking the page into a login redirect, leaving
   * App's auth gate as the single place that decides to show the sign-in view.
   */
  prefetch(): void {
    void this.load({ silent: true });
  }

  /** Background refresh on mount — skipped while the data is still fresh. */
  revalidate(): void {
    if (this.state.items && Date.now() - this.lastLoadedAt < FRESH_MS) return;
    void this.load({ silent: true });
  }

  /**
   * User-driven retry. NOT silent: if the session has expired, the click should
   * take them to re-login rather than fail quietly a second time.
   */
  refresh(): Promise<void> {
    return this.load({ silent: false });
  }

  /**
   * Two jobs: hydrate from an earlier visit, and record ownership so a later
   * sign-in as somebody else can never read the first user's dashboard passwords.
   *
   * Called TWICE per page load. First from main.tsx with the remembered principal,
   * before React mounts, so cached rows are on screen in the first frame. Then
   * again once /.auth/me confirms who is actually signed in — which is what makes
   * the optimistic first call safe to trust.
   */
  bindOwner(owner: string): void {
    const previous = this.owner;
    this.owner = owner;
    // A fetch may already have won the race; live data is server-authoritative and
    // outranks the cache, so persist it rather than hydrating over it.
    if (this.state.items && !this.fromCache) {
      this.persist();
      return;
    }
    // The remembered principal was somebody else: this browser switched users
    // without signing out. Their rows must come off the screen, not just out of
    // storage — readSession below would decline to re-hydrate, but the rows
    // already painted would otherwise stay.
    if (this.fromCache && previous && previous !== owner) {
      this.fromCache = false;
      this.set({ items: null });
    }
    const cached = this.readSession(owner);
    if (cached) {
      this.fromCache = true;
      this.set({ items: cached });
    }
  }

  /** Drops cached rows (and their passwords) — called when signing out. */
  clear(): void {
    this.owner = null;
    this.lastLoadedAt = 0;
    this.fromCache = false;
    this.storage?.removeItem(STORAGE_KEY);
    this.set({ items: null, error: "" });
  }

  private load(options: { silent: boolean }): Promise<void> {
    // Concurrent callers (prefetch at module load + revalidate on mount) share
    // one request instead of paying two cold starts.
    if (this.inFlight) return this.inFlight;
    this.set({ refreshing: true, error: "" });
    this.inFlight = this.list({ silent: options.silent })
      .then((items) => {
        this.lastLoadedAt = Date.now();
        this.fromCache = false;
        this.set({ items, refreshing: false, error: "" });
        this.persist();
      })
      .catch((error: unknown) => {
        // Any cached rows stay on screen; the error is reported alongside them
        // and only takes over the panel when there is nothing to show.
        this.set({
          refreshing: false,
          error: error instanceof Error ? error.message : "Could not load your submissions.",
        });
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private set(patch: Partial<SubmissionsState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private readSession(owner: string): SubmissionSummary[] | null {
    if (!this.storage) return null;
    const raw = this.storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      const envelope = JSON.parse(raw) as Envelope | null;
      // Mismatched owner means a different user is now signed in to this tab.
      // Drop it rather than hold another account's passwords in storage.
      if (envelope?.owner !== owner || !Array.isArray(envelope.items)) {
        this.storage.removeItem(STORAGE_KEY);
        return null;
      }
      return envelope.items;
    } catch {
      this.storage.removeItem(STORAGE_KEY);
      return null;
    }
  }

  private persist(): void {
    if (!this.storage || !this.owner || !this.state.items) return;
    const envelope: Envelope = { owner: this.owner, items: this.state.items };
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(envelope));
    } catch {
      /* Cache is best-effort — a full or blocked store must not break the view. */
    }
  }
}
