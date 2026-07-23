import { useCallback, useEffect, useState } from "react";
import type { SubmissionClient, SubmissionStatus, SubmissionSummary } from "../api/SubmissionClient";

type Props = {
  client: SubmissionClient;
  onUpload: () => void;
};

type LoadState = "loading" | "loaded" | "failed";

// AU date format (DD/MM/YYYY) to match the generated dashboards.
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
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

// Per-tab cache so a refresh renders the last-known list instantly and only
// revalidates in the background (the list endpoint is on a cold-startable Function).
// Passwords are stripped before caching so the plaintext never lingers in storage —
// they re-appear from the live fetch a moment later.
const CACHE_KEY = "tiger.submissions";
function readCache(): SubmissionSummary[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as SubmissionSummary[]) : null;
  } catch {
    return null;
  }
}

export function DashboardsView({ client, onUpload }: Props) {
  const [items, setItems] = useState<SubmissionSummary[]>(() => readCache() ?? []);
  const [state, setState] = useState<LoadState>(() => (readCache() ? "loaded" : "loading"));
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const next = await client.list();
      setItems(next);
      setState("loaded");
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify(next.map((s) => ({ ...s, dashboardPassword: null }))));
      } catch {
        /* cache is best-effort */
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your submissions.");
      // Keep any cached rows visible; only show the error page when there's nothing.
      setState((prev) => (prev === "loaded" ? "loaded" : "failed"));
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto w-full max-w-[860px]">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">Your history</p>
          <h1 className="mt-1 text-3xl font-bold tracking-[-0.02em] text-ssw-charcoal-800">My submissions</h1>
        </div>
        <button
          className="rounded-ds-sm border border-primary bg-primary px-4 py-2.5 font-semibold text-white transition hover:bg-ssw-red-600"
          type="button"
          onClick={onUpload}
        >
          Submit a meeting
        </button>
      </div>

      {state === "loading" && (
        <div className="rounded-ds border border-black/10 bg-white p-10 text-center text-ssw-gray-500 shadow-ds-raised">
          Loading your submissions…
        </div>
      )}

      {state === "failed" && (
        <div className="rounded-ds border border-destructive/25 bg-destructive/5 p-6 text-center" role="alert">
          <p className="text-ssw-charcoal">{error}</p>
          <button
            className="mt-3 rounded-ds-sm border border-black/10 bg-white px-4 py-2 font-medium text-ssw-charcoal transition hover:bg-black/5"
            type="button"
            onClick={() => void load()}
          >
            Try again
          </button>
        </div>
      )}

      {state === "loaded" && items.length === 0 && (
        <div className="rounded-ds border border-black/10 bg-white p-12 text-center shadow-ds-raised">
          <h2 className="text-lg font-semibold text-ssw-charcoal">No submissions yet</h2>
          <p className="mx-auto mt-2 max-w-[380px] text-sm text-ssw-gray-500">
            Submit a Teams meeting link or transcript and it will appear here once Parrot has generated the dashboard.
          </p>
          <button
            className="mt-5 rounded-ds-sm border border-primary bg-primary px-5 py-3 font-semibold text-white transition hover:bg-ssw-red-600"
            type="button"
            onClick={onUpload}
          >
            Submit your first meeting
          </button>
        </div>
      )}

      {state === "loaded" && items.length > 0 && (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li
              key={item.requestId}
              className="flex items-center justify-between gap-4 rounded-ds border border-black/10 bg-white p-4 shadow-ds-raised"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                  <h3 className="truncate font-semibold text-ssw-charcoal">{item.displayName}</h3>
                  <StatusBadge status={item.status} />
                </div>
                <p className="mt-1 text-[13px] text-ssw-gray-500">Submitted {formatDate(item.submittedAt)}</p>
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
          ))}
        </ul>
      )}
    </div>
  );
}
