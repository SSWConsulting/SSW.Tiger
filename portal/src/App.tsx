import { useEffect, useState } from "react";
import type { AuthClient, ClientPrincipal } from "./api/authClient";
import type { SubmissionClient } from "./api/SubmissionClient";
import type { SubmissionsCache } from "./api/submissionsCache";
import { AppHeader, type View } from "./components/AppHeader";
import { DashboardsView } from "./views/DashboardsView";
import { SignInView } from "./views/SignInView";
import { UploadView } from "./views/UploadView";

type Props = { client: SubmissionClient; auth: AuthClient; submissions: SubmissionsCache };
type AuthState = "checking" | "in" | "out";

// The active tab lives in the URL PATH (/submit, /submissions) — no "#". A refresh
// or deep link still works because SWA's navigationFallback rewrites every unknown
// path to index.html; browser back/forward is handled via popstate below.
function viewFromPath(): View {
  return window.location.pathname === "/submissions" ? "dashboards" : "upload";
}

export function App({ client, auth, submissions }: Props) {
  // Start from the last known principal so a returning visitor gets the real shell
  // in the first frame rather than a "Loading…" screen for the length of the
  // /.auth/me round trip. The effect below still runs and corrects this — dropping
  // to the sign-in view if the session has actually expired.
  const [principal, setPrincipal] = useState<ClientPrincipal | null>(() => auth.cachedMe());
  const [authState, setAuthState] = useState<AuthState>(principal ? "in" : "checking");
  const [view, setView] = useState<View>(viewFromPath);

  useEffect(() => {
    let active = true;
    auth.me().then((me) => {
      if (!active) return;
      // Confirm the cache's owner. main.tsx already bound the REMEMBERED identity
      // to unlock this tab's rows early; re-binding with the identity SWA actually
      // vouches for is what makes that optimism safe — a mismatch (same browser,
      // different user, no sign-out) discards the rows it hydrated.
      if (me) submissions.bindOwner(me.userId);
      setPrincipal(me);
      setAuthState(me ? "in" : "out");
    });
    return () => {
      active = false;
    };
  }, [auth, submissions]);

  useEffect(() => {
    const onPop = () => setView(viewFromPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Navigating pushes a real path so back/forward works; the popstate listener
  // above is the single source of truth on history navigation.
  const navigate = (next: View) => {
    const path = next === "dashboards" ? "/submissions" : "/submit";
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
    setView(next);
  };

  if (authState === "checking") {
    return <main className="grid min-h-screen place-items-center text-ssw-gray-500">Loading…</main>;
  }

  if (authState === "out" || !principal) {
    return <SignInView loginUrl={auth.loginUrl(window.location.pathname)} />;
  }

  return (
    <>
      <AppHeader
        view={view}
        onNavigate={navigate}
        principal={principal}
        logoutUrl={auth.logoutUrl()}
        onSignOut={() => {
          submissions.clear();
          auth.forget();
        }}
      />
      <main
        className={`mx-auto flex w-[min(1120px,calc(100%-40px))] flex-col py-8 ${
          view === "upload" ? "justify-center" : "justify-start"
        }`}
        style={{ minHeight: "calc(100vh - 57px)" }}
      >
        {view === "upload" ? (
          <UploadView client={client} onViewDashboards={() => navigate("dashboards")} />
        ) : (
          <DashboardsView submissions={submissions} onUpload={() => navigate("upload")} />
        )}
      </main>
    </>
  );
}
