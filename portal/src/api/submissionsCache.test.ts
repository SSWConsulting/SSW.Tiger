import { describe, expect, it, vi } from "vitest";
import type { SubmissionSummary } from "./SubmissionClient";
import { type KeyValueStore, SubmissionsCache } from "./submissionsCache";

const row = (over: Partial<SubmissionSummary> = {}): SubmissionSummary => ({
  requestId: "r1",
  displayName: "Sprint review",
  projectSlug: "tiger",
  status: "completed",
  dashboardUrl: "https://dashboards.sswtiger.com/tiger/r1",
  submittedAt: "2026-07-24T02:00:00.000Z",
  passwordProtected: true,
  dashboardPassword: "hunter2",
  ...over,
});

function fakeStore(seed: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

const KEY = "tiger.submissions";

describe("SubmissionsCache", () => {
  it("prefetches silently so a 401 cannot hijack the page into a login redirect", async () => {
    const list = vi.fn().mockResolvedValue([row()]);
    const cache = new SubmissionsCache(list, null);
    cache.prefetch();
    await vi.waitFor(() => expect(cache.snapshot().items).toHaveLength(1));
    expect(list).toHaveBeenCalledWith({ silent: true });
  });

  it("lets a user-driven retry surface the auth challenge", async () => {
    const list = vi.fn().mockResolvedValue([]);
    const cache = new SubmissionsCache(list, null);
    await cache.refresh();
    expect(list).toHaveBeenCalledWith({ silent: false });
  });

  it("collapses a concurrent prefetch and revalidate into one request", async () => {
    const list = vi.fn().mockResolvedValue([row()]);
    const cache = new SubmissionsCache(list, null);
    cache.prefetch();
    cache.revalidate();
    await vi.waitFor(() => expect(cache.snapshot().items).toHaveLength(1));
    // Each extra call would be another cold start on the Consumption Function.
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("skips revalidating while the data is still fresh", async () => {
    const list = vi.fn().mockResolvedValue([row()]);
    const cache = new SubmissionsCache(list, null);
    await cache.refresh();
    cache.revalidate();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("hydrates cached rows — passwords included — for the same owner", () => {
    const store = fakeStore({ [KEY]: JSON.stringify({ owner: "u1", items: [row()] }) });
    const cache = new SubmissionsCache(vi.fn().mockResolvedValue([]), store);
    cache.bindOwner("u1");
    // The whole point: the Password renders with its row, not seconds later.
    expect(cache.snapshot().items?.[0].dashboardPassword).toBe("hunter2");
  });

  it("discards cached rows when a different user signs in to the same tab", () => {
    const store = fakeStore({ [KEY]: JSON.stringify({ owner: "u1", items: [row()] }) });
    const cache = new SubmissionsCache(vi.fn().mockResolvedValue([]), store);
    cache.bindOwner("u2");
    expect(cache.snapshot().items).toBeNull();
    // And it must not linger in storage for a third sign-in to find.
    expect(store.data[KEY]).toBeUndefined();
  });

  it("takes the previous user's hydrated rows off the screen when auth confirms someone else", () => {
    // main.tsx binds the REMEMBERED principal so rows paint in the first frame,
    // then App re-binds whoever /.auth/me actually vouches for. If the browser
    // switched users without signing out, those rows (and their passwords) must
    // not survive the correction.
    const store = fakeStore({ [KEY]: JSON.stringify({ owner: "u1", items: [row()] }) });
    const cache = new SubmissionsCache(vi.fn().mockResolvedValue([]), store);
    cache.bindOwner("u1");
    expect(cache.snapshot().items).toHaveLength(1);
    cache.bindOwner("u2");
    expect(cache.snapshot().items).toBeNull();
    expect(store.data[KEY]).toBeUndefined();
  });

  it("keeps hydrated rows when auth confirms the same user", () => {
    const store = fakeStore({ [KEY]: JSON.stringify({ owner: "u1", items: [row()] }) });
    const cache = new SubmissionsCache(vi.fn().mockResolvedValue([]), store);
    cache.bindOwner("u1");
    cache.bindOwner("u1");
    expect(cache.snapshot().items).toHaveLength(1);
  });

  it("drops unparseable cache entries instead of throwing", () => {
    const store = fakeStore({ [KEY]: "{not json" });
    const cache = new SubmissionsCache(vi.fn().mockResolvedValue([]), store);
    cache.bindOwner("u1");
    expect(cache.snapshot().items).toBeNull();
    expect(store.data[KEY]).toBeUndefined();
  });

  it("does not let a stale cache overwrite rows the prefetch already returned", async () => {
    const store = fakeStore({ [KEY]: JSON.stringify({ owner: "u1", items: [row({ status: "processing" })] }) });
    const cache = new SubmissionsCache(vi.fn().mockResolvedValue([row({ status: "completed" })]), store);
    await cache.refresh();
    cache.bindOwner("u1");
    expect(cache.snapshot().items?.[0].status).toBe("completed");
  });

  it("persists rows once the owner is known, even if the fetch landed first", async () => {
    const store = fakeStore();
    const cache = new SubmissionsCache(vi.fn().mockResolvedValue([row()]), store);
    await cache.refresh();
    expect(store.data[KEY]).toBeUndefined(); // no owner yet — nothing to scope it to
    cache.bindOwner("u1");
    expect(JSON.parse(store.data[KEY])).toMatchObject({ owner: "u1" });
  });

  it("keeps cached rows on screen when a revalidate fails", async () => {
    const store = fakeStore({ [KEY]: JSON.stringify({ owner: "u1", items: [row()] }) });
    const list = vi.fn().mockRejectedValue(new Error("Could not load your dashboards. Please try again."));
    const cache = new SubmissionsCache(list, store);
    cache.bindOwner("u1");
    await cache.refresh();
    expect(cache.snapshot().items).toHaveLength(1);
    expect(cache.snapshot().error).toMatch(/could not load/i);
  });

  it("wipes rows and storage on sign-out", async () => {
    const store = fakeStore();
    const cache = new SubmissionsCache(vi.fn().mockResolvedValue([row()]), store);
    cache.bindOwner("u1");
    await cache.refresh();
    expect(store.data[KEY]).toBeDefined();
    cache.clear();
    expect(cache.snapshot().items).toBeNull();
    expect(store.data[KEY]).toBeUndefined();
  });

  it("notifies subscribers and stops after unsubscribe", async () => {
    const cache = new SubmissionsCache(vi.fn().mockResolvedValue([row()]), null);
    const listener = vi.fn();
    const unsubscribe = cache.subscribe(listener);
    await cache.refresh();
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    const before = listener.mock.calls.length;
    await cache.refresh();
    expect(listener.mock.calls.length).toBe(before);
  });
});
