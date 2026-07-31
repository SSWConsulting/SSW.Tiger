import type { RequestAdapter } from "./RequestAdapter";

export type SubmissionResult = { requestId: string; status: "accepted" };

export type SubmissionStatus = "accepted" | "processing" | "completed" | "failed";

// One row in the "my dashboards" list. Shape is the contract for
// GET /api/v1/submissions (implemented server-side in a later step).
export type SubmissionSummary = {
  requestId: string;
  displayName: string;
  projectSlug: string;
  status: SubmissionStatus;
  dashboardUrl: string | null;
  submittedAt: string;
  // Timestamp of the last status write. On a terminal row it is when the run
  // finished; while the run is still going it just moves, so the list only
  // derives a duration from it once the status is completed or failed.
  updatedAt?: string | null;
  // Present on failed rows — a user-facing sentence from the Job explaining what
  // went wrong ("No transcript is available for this meeting yet…").
  failureReason?: string | null;
  // Present for completed, password-protected dashboards — shown in the list so the
  // owner can find their password (portal submissions get no Teams notification).
  passwordProtected?: boolean;
  dashboardPassword?: string | null;
};

export class SubmissionError extends Error {
  constructor(
    message: string,
    readonly code = "submission_failed",
  ) {
    super(message);
  }
}

export class SubmissionClient {
  constructor(
    private readonly adapter: RequestAdapter,
    private readonly endpoint = "/api/v1/submissions",
    // Called when the SWA session has expired (so the app can send the user to
    // re-login instead of silently showing an empty/failed state).
    private readonly onAuthRequired?: () => void,
    private readonly meetingsEndpoint = "/api/v1/meetings",
    // A GET of `endpoint` already in flight, started by the inline <head> script
    // in index.html before this bundle finished downloading. Resolves to null if
    // that early fetch failed outright.
    private primedList: Promise<Response | null> | null = null,
  ) {}

  // An expired SWA session returns 401, which staticwebapp.config.json rewrites
  // to a 302 → login page. With redirect:"manual" that surfaces as an
  // opaqueredirect (or a bare 401) rather than a followed HTML page that would
  // break JSON parsing — turn it into a re-login.
  //
  // 403 is deliberately NOT an auth challenge: it means "signed in, but not
  // allowed" (e.g. the planned participant-level check on meeting links).
  // Re-logging in returns the same identity and the same 403 — a login loop —
  // and it would also discard the server's real explanation. Let 403 fall
  // through to the !response.ok path so payload.error.message reaches the user.
  private isAuthChallenge(response: Response): boolean {
    return response.type === "opaqueredirect" || response.status === 401;
  }

  async submit(projectName: string, file: File): Promise<SubmissionResult> {
    const form = new FormData();
    form.append("projectName", projectName);
    form.append("file", file);
    const init = await this.adapter.prepare({ method: "POST", body: form });
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetch(this.endpoint, {
        ...init,
        redirect: "manual",
        signal: init.signal ?? controller.signal,
      });
      if (this.isAuthChallenge(response)) {
        this.onAuthRequired?.();
        throw new SubmissionError("Your session has expired. Please sign in again.", "unauthenticated");
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new SubmissionError(
          payload?.error?.message || "The transcript could not be submitted. Please try again.",
          payload?.error?.code,
        );
      }
      if (payload?.status !== "accepted" || typeof payload?.requestId !== "string" || !payload.requestId.trim()) {
        throw new SubmissionError("The server returned an invalid submission response.", "invalid_response");
      }
      return { requestId: payload.requestId, status: "accepted" };
    } catch (error) {
      if (error instanceof SubmissionError) throw error;
      if (controller.signal.aborted) {
        throw new SubmissionError("The upload timed out. Please try again.", "submission_timeout");
      }
      throw new SubmissionError("The transcript could not be submitted. Please try again.", "network_error");
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async submitLink(projectName: string, meetingLink: string, attendeeEmail = ""): Promise<SubmissionResult> {
    const init = await this.adapter.prepare({
      method: "POST",
      body: JSON.stringify({ projectName, meetingLink, attendeeEmail }),
      headers: { "Content-Type": "application/json" },
    });
    let response: Response;
    try {
      response = await fetch(this.meetingsEndpoint, { ...init, redirect: "manual" });
    } catch {
      throw new SubmissionError("The meeting link could not be submitted. Please try again.", "network_error");
    }
    if (this.isAuthChallenge(response)) {
      this.onAuthRequired?.();
      throw new SubmissionError("Your session has expired. Please sign in again.", "unauthenticated");
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new SubmissionError(
        payload?.error?.message || "The meeting link could not be submitted. Please try again.",
        payload?.error?.code,
      );
    }
    if (payload?.status !== "accepted" || typeof payload?.requestId !== "string" || !payload.requestId.trim()) {
      throw new SubmissionError("The server returned an invalid submission response.", "invalid_response");
    }
    return { requestId: payload.requestId, status: "accepted" };
  }

  // `silent` suppresses only the onAuthRequired side effect, not the error. It
  // exists for the speculative prefetch that fires before /.auth/me has
  // resolved: a 401 there must not hijack the page into a login redirect, or a
  // signed-out visitor would be bounced instead of seeing the sign-in view.
  async list(options: { silent?: boolean } = {}): Promise<SubmissionSummary[]> {
    let response: Response;
    try {
      response = await this.listResponse();
    } catch {
      throw new SubmissionError("Could not load your dashboards. Please try again.", "network_error");
    }
    if (this.isAuthChallenge(response)) {
      if (!options.silent) this.onAuthRequired?.();
      throw new SubmissionError("Your session has expired. Please sign in again.", "unauthenticated");
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new SubmissionError(
        payload?.error?.message || "Could not load your dashboards. Please try again.",
        payload?.error?.code,
      );
    }
    return Array.isArray(payload?.submissions) ? payload.submissions : [];
  }

  /**
   * The first list() adopts the response the page started before this bundle
   * loaded; every later call fetches normally. Strictly one-shot — a Response
   * body can only be read once, so a revalidate must not re-await it.
   */
  private async listResponse(): Promise<Response> {
    const primed = this.primedList;
    this.primedList = null;
    if (primed) {
      const response = await primed;
      // null means the early fetch failed (offline at page load). Fall through so
      // the normal path produces a real error the user can retry from.
      if (response) return response;
    }
    const init = await this.adapter.prepare({ method: "GET" });
    return fetch(this.endpoint, { ...init, redirect: "manual" });
  }
}
