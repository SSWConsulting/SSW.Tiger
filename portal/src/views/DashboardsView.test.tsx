import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SubmissionSummary } from "../api/SubmissionClient";
import { type KeyValueStore, SubmissionsCache } from "../api/submissionsCache";
import { DashboardsView } from "./DashboardsView";

const KEY = "tiger.submissions";

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

function seededStore(items: SubmissionSummary[], owner = "u1"): KeyValueStore {
  const data: Record<string, string> = { [KEY]: JSON.stringify({ owner, items }) };
  return {
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

// A request that never settles, so we can assert on what renders WHILE the
// (cold-startable) Function call is still outstanding.
const pending = () => new Promise<SubmissionSummary[]>(() => {});

describe("DashboardsView", () => {
  it("renders cached rows and their password without waiting for the network", () => {
    const cache = new SubmissionsCache(pending, seededStore([row()]));
    cache.bindOwner("u1");
    render(<DashboardsView submissions={cache} onUpload={vi.fn()} />);

    // The whole reported symptom: this used to appear seconds after the row.
    expect(screen.getByText("hunter2")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sprint review" })).toBeInTheDocument();
    expect(screen.queryByText(/loading your submissions/i)).not.toBeInTheDocument();
  });

  it("shows a quiet refreshing hint instead of covering the cached rows", () => {
    const cache = new SubmissionsCache(pending, seededStore([row()]));
    cache.bindOwner("u1");
    render(<DashboardsView submissions={cache} onUpload={vi.fn()} />);

    expect(screen.getByText(/refreshing/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sprint review" })).toBeInTheDocument();
  });

  it("shows the full spinner only when nothing is known yet", () => {
    const cache = new SubmissionsCache(pending, null);
    cache.bindOwner("u1");
    render(<DashboardsView submissions={cache} onUpload={vi.fn()} />);

    expect(screen.getByText(/loading your submissions/i)).toBeInTheDocument();
  });

  it("offers a retry when the first load fails with nothing cached", async () => {
    const list = vi.fn().mockRejectedValue(new Error("Could not load your dashboards. Please try again."));
    const cache = new SubmissionsCache(list, null);
    render(<DashboardsView submissions={cache} onUpload={vi.fn()} />);

    expect(await screen.findByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("keeps cached rows visible when a revalidate fails", async () => {
    const list = vi.fn().mockRejectedValue(new Error("Could not load your dashboards. Please try again."));
    const cache = new SubmissionsCache(list, seededStore([row()]));
    cache.bindOwner("u1");
    render(<DashboardsView submissions={cache} onUpload={vi.fn()} />);

    expect(await screen.findByText(/showing your last known submissions/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sprint review" })).toBeInTheDocument();
  });

  it("shows the empty state for a user with no submissions", async () => {
    const cache = new SubmissionsCache(vi.fn().mockResolvedValue([]), null);
    render(<DashboardsView submissions={cache} onUpload={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: /no submissions yet/i })).toBeInTheDocument();
  });

  it("hides the password line for dashboards that are not protected", () => {
    const cache = new SubmissionsCache(
      pending,
      seededStore([row({ passwordProtected: false, dashboardPassword: null })]),
    );
    cache.bindOwner("u1");
    render(<DashboardsView submissions={cache} onUpload={vi.fn()} />);

    expect(screen.queryByText(/^password:$/i)).not.toBeInTheDocument();
  });
});
