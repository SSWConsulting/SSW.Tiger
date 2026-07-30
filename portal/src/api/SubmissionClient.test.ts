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

// The list endpoint runs on a Consumption Function whose worker the platform
// recycles every ~8 minutes, so index.html starts the request before this bundle
// has even been downloaded. These cover the handover.
describe("SubmissionClient.list — adopting the request index.html started", () => {
  const listBody = { submissions: [{ requestId: "r1", displayName: "Sprint review" }] };
  const ok = () => new Response(JSON.stringify(listBody), { status: 200 });
  const withPrimed = (primed: Promise<Response | null> | null) =>
    new SubmissionClient(adapter, "/api/v1/submissions", undefined, undefined, primed);

  it("uses the response the page already started instead of issuing a second one", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(withPrimed(Promise.resolve(ok())).list()).resolves.toHaveLength(1);
    // A second request here would be a second chance at landing on a cold worker.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches normally on the next call, because a body can only be read once", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchSpy);
    const client = withPrimed(Promise.resolve(ok()));

    await client.list();
    await client.list();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("/api/v1/submissions");
  });

  it("falls back to a normal fetch when the early request failed outright", async () => {
    // The inline script resolves to null rather than rejecting (an unhandled
    // rejection otherwise), so an offline page load must not leave the list
    // permanently unable to fetch.
    const fetchSpy = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchSpy);

    await expect(withPrimed(Promise.resolve(null)).list()).resolves.toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
