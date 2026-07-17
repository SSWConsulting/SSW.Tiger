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
  ) {}

  // An expired SWA session returns 401, which staticwebapp.config.json rewrites
  // to a 302 → login page. With redirect:"manual" that surfaces as an
  // opaqueredirect (or a bare 401/403) rather than a followed HTML page that
  // would break JSON parsing — turn it into a re-login.
  private isAuthChallenge(response: Response): boolean {
    return response.type === "opaqueredirect" || response.status === 401 || response.status === 403;
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

  async list(): Promise<SubmissionSummary[]> {
    const init = await this.adapter.prepare({ method: "GET" });
    let response: Response;
    try {
      response = await fetch(this.endpoint, { ...init, redirect: "manual" });
    } catch {
      throw new SubmissionError("Could not load your dashboards. Please try again.", "network_error");
    }
    if (this.isAuthChallenge(response)) {
      this.onAuthRequired?.();
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
}
