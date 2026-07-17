import type { RequestAdapter } from "./RequestAdapter";

export type SubmissionResult = { requestId: string; status: "accepted" };

export class SubmissionError extends Error {
  constructor(message: string, readonly code = "submission_failed") {
    super(message);
  }
}

export class SubmissionClient {
  constructor(
    private readonly adapter: RequestAdapter,
    private readonly endpoint = "/api/v1/submissions",
  ) {}

  async submit(projectName: string, file: File): Promise<SubmissionResult> {
    const form = new FormData();
    form.append("projectName", projectName);
    form.append("file", file);
    const init = await this.adapter.prepare({ method: "POST", body: form });
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetch(this.endpoint, { ...init, signal: init.signal ?? controller.signal });
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
}
