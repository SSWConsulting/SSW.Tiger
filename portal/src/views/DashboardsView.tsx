import { type ReactNode, useEffect, useSyncExternalStore } from "react";
import type { SubmissionStatus, SubmissionSummary } from "../api/SubmissionClient";
import type { SubmissionsCache } from "../api/submissionsCache";

type Props = {
  submissions: SubmissionsCache;
  onUpload: () => void;
};

// AU date format (DD/MM/YYYY) to match the generated dashboards.
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

// A job runs for minutes, so a list that only refreshes on mount leaves the
// submitter watching a stale "Queued" for the whole run. Poll only while
// something is actually moving, and stop the moment nothing is.
const POLL_MS = 20_000;

function isPending(status: SubmissionStatus): boolean {
  return status === "accepted" || status === "processing";
}

const STATUS_STYLES: Record<SubmissionStatus, { label: string; className: string }> = {
  accepted: { label: "Queued", className: "bg-ssw-gray-100 text-ssw-gray-700" },
  processing: { label: "Processing", className: "bg-amber-50 text-warning" },
  completed: { label: "Ready", className: "bg-success/10 text-success" },
  failed: { label: "Failed", className: "bg-ssw-red-50 text-primary" },
};

function StatusBadge({ status }: { status: SubmissionStatus }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.accepted;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${style.className}`}>
      {style.label}
    </span>
  );
}

function SubmissionRow({ item }: { item: SubmissionSummary }) {
  return (
    <li className="flex items-center justify-between gap-4 rounded-ds border border-black/10 bg-white p-4 shadow-ds-raised">
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <h3 className="truncate font-semibold text-ssw-charcoal">{item.displayName}</h3>
          <StatusBadge status={item.status} />
        </div>
        <p className="mt-1 text-[13px] text-ssw-gray-500">Submitted {formatDate(item.submittedAt)}</p>
        {item.status === "failed" && item.failureReason ? (
          <p className="mt-1 text-[13px] text-ssw-charcoal">{item.failureReason}</p>
        ) : null}
        {item.status === "completed" && item.passwordProtected && item.dashboardPassword ? (
          <p className="mt-1 text-[13px] text-ssw-charcoal">
            <span className="font-medium">Password:</span>{" "}
            <code className="rounded bg-ssw-gray-100 px-1.5 py-0.5 font-mono text-[12px]">
              {item.dashboardPassword}
            </code>
          </p>
        ) : null}
      </div>
      {item.status === "completed" && item.dashboardUrl ? (
        <a
          href={item.dashboardUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-none rounded-ds-sm border border-primary bg-primary px-4 py-2 font-semibold text-white transition hover:bg-ssw-red-600"
        >
          Open dashboard
        </a>
      ) : (
        <span className="flex-none text-[13px] text-ssw-gray-400">
          {item.status === "failed" ? "Unavailable" : "In progress"}
        </span>
      )}
    </li>
  );
}

export function DashboardsView({ submissions, onUpload }: Props) {
  // State lives in the cache, not here, so it survives the unmount/remount that
  // every tab switch causes — and so the module-load prefetch has somewhere to
  // land before this view ever mounts.
  const { items, refreshing, error } = useSyncExternalStore(submissions.subscribe, submissions.snapshot);

  // A no-op while the prefetch is still in flight or its result is fresh; picks
  // up status changes when returning to the tab later.
  useEffect(() => submissions.revalidate(), [submissions]);

  // Keep the list live while a job is still running. `pending` is a boolean, not
  // the array, so the interval is not torn down and rebuilt on every poll that
  // returns the same statuses — only when the answer to "is anything still
  // running?" actually changes.
  const pending = items?.some((item) => isPending(item.status)) ?? false;
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => submissions.poll(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [pending, submissions]);

  // Nothing known yet is the ONLY case that earns a full-panel spinner. Once we
  // have rows — from the network or from this tab's cache — a revalidation must
  // never blank them.
  if (items === null) {
    return error ? (
      <Shell>
        <div className="rounded-ds border border-destructive/25 bg-destructive/5 p-6 text-center" role="alert">
          <p className="text-ssw-charcoal">{error}</p>
          <button
            className="mt-3 rounded-ds-sm border border-black/10 bg-white px-4 py-2 font-medium text-ssw-charcoal transition hover:bg-black/5"
            type="button"
            onClick={() => void submissions.refresh()}
          >
            Try again
          </button>
        </div>
      </Shell>
    ) : (
      <Shell>
        <div className="rounded-ds border border-black/10 bg-white p-10 text-center text-ssw-gray-500 shadow-ds-raised">
          Loading your submissions…
        </div>
      </Shell>
    );
  }

  return (
    <Shell refreshing={refreshing} onRefresh={() => void submissions.refresh()}>
      {/* A failed revalidate is reported beside the rows it could not replace,
          rather than replacing them with an error panel. */}
      {error && (
        <div
          className="mb-3 rounded-ds-sm border border-amber-400/40 bg-amber-50 px-3.5 py-2.5 text-[13px] text-ssw-charcoal"
          role="status"
        >
          Showing your last known submissions — {error}{" "}
          <button
            className="font-semibold underline underline-offset-2"
            type="button"
            onClick={() => void submissions.refresh()}
          >
            Retry
          </button>
        </div>
      )}

      {items.length === 0 ? (
        <div className="rounded-ds border border-black/10 bg-white p-12 text-center shadow-ds-raised">
          <h2 className="text-lg font-semibold text-ssw-charcoal">No submissions yet</h2>
          <p className="mx-auto mt-2 max-w-[380px] text-sm text-ssw-gray-500">
            Submit a Teams meeting link or transcript and it will appear here once Tiger has generated the dashboard.
          </p>
          <button
            className="mt-5 rounded-ds-sm border border-primary bg-primary px-5 py-3 font-semibold text-white transition hover:bg-ssw-red-600"
            type="button"
            onClick={onUpload}
          >
            Submit your first meeting
          </button>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <SubmissionRow key={item.requestId} item={item} />
          ))}
        </ul>
      )}
    </Shell>
  );
}

function Shell({
  children,
  refreshing = false,
  onRefresh,
}: {
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-[860px]">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">Your history</p>
        <div className="mt-1 flex items-baseline gap-3">
          <h1 className="text-3xl font-bold tracking-[-0.02em] text-ssw-charcoal-800">My submissions</h1>
          {/* Deliberately inline and quiet: a background revalidate is not a
              reason to cover content the user is already reading. */}
          {refreshing && (
            <span className="text-[13px] text-ssw-gray-400" role="status">
              Refreshing…
            </span>
          )}
          {/* The poll covers rows that are still running; this covers everything
              else — most often a submission made in another tab. */}
          {onRefresh && !refreshing && (
            <button
              className="text-[13px] font-medium text-ssw-gray-500 underline underline-offset-2 transition hover:text-ssw-charcoal"
              type="button"
              onClick={onRefresh}
            >
              Refresh
            </button>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}
