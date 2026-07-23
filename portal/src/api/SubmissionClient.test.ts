import { afterEach, describe, expect, it, vi } from "vitest";
import { SubmissionClient } from "./SubmissionClient";

const adapter = { prepare: async (init: RequestInit) => init };
const file = new File(["WEBVTT\n\n00:00.000 --> 00:01.000\nHello"], "meeting.vtt");

afterEach(() => vi.restoreAllMocks());

describe("SubmissionClient", () => {
  it("accepts only the stable 202 response shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ requestId: "r1", status: "accepted" }), { status: 202 })),
    );
    await expect(new SubmissionClient(adapter).submit("Tiger", file)).resolves.toEqual({
      requestId: "r1",
      status: "accepted",
    });
  });

  it("rejects malformed successful responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "accepted" }), { status: 202 })),
    );
    await expect(new SubmissionClient(adapter).submit("Tiger", file)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("maps network failures to a stable error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(new SubmissionClient(adapter).submit("Tiger", file)).rejects.toMatchObject({ code: "network_error" });
  });

  it("triggers re-login on an auth challenge instead of parsing HTML", async () => {
    // redirect:"manual" surfaces the SWA login 302 as an opaqueredirect.
    const opaque = { type: "opaqueredirect", status: 0, json: async () => ({}) } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(opaque));
    const onAuthRequired = vi.fn();
    await expect(new SubmissionClient(adapter, undefined, onAuthRequired).list()).rejects.toMatchObject({
      code: "unauthenticated",
    });
    expect(onAuthRequired).toHaveBeenCalledOnce();
  });

  it("surfaces a 403 message instead of forcing a re-login loop", async () => {
    // "Signed in, but not allowed" — re-logging in yields the same identity and
    // the same 403, so the server's explanation must reach the user instead.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: "not_a_participant", message: "You were not in this meeting." } }),
          {
            status: 403,
          },
        ),
      ),
    );
    const onAuthRequired = vi.fn();
    await expect(
      new SubmissionClient(adapter, undefined, onAuthRequired).submitLink("Tiger", "https://teams.microsoft.com/l/x"),
    ).rejects.toMatchObject({ code: "not_a_participant", message: "You were not in this meeting." });
    expect(onAuthRequired).not.toHaveBeenCalled();
  });
});
