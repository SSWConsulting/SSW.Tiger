import { afterEach, describe, expect, it, vi } from "vitest";
import { SubmissionClient } from "./SubmissionClient";

const adapter = { prepare: async (init: RequestInit) => init };
const file = new File(["WEBVTT\n\n00:00.000 --> 00:01.000\nHello"], "meeting.vtt");

afterEach(() => vi.restoreAllMocks());

describe("SubmissionClient", () => {
  it("accepts only the stable 202 response shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ requestId: "r1", status: "accepted" }), { status: 202 })));
    await expect(new SubmissionClient(adapter).submit("Tiger", file)).resolves.toEqual({ requestId: "r1", status: "accepted" });
  });

  it("rejects malformed successful responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "accepted" }), { status: 202 })));
    await expect(new SubmissionClient(adapter).submit("Tiger", file)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("maps network failures to a stable error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(new SubmissionClient(adapter).submit("Tiger", file)).rejects.toMatchObject({ code: "network_error" });
  });
});
