import { useEffect, useState } from "react";
import { AppHeader, type View } from "./components/AppHeader";
import { UploadView } from "./views/UploadView";
import { DashboardsView } from "./views/DashboardsView";
import { SignInView } from "./views/SignInView";
import type { SubmissionClient } from "./api/SubmissionClient";
import type { AuthClient, ClientPrincipal } from "./api/authClient";

type Props = { client: SubmissionClient; auth: AuthClient };
type AuthState = "checking" | "in" | "out";

// The active tab lives in the URL PATH (/submit, /submissions) — no "#". A refresh
// or deep link still works because SWA's navigationFallback rewrites every unknown
// path to index.html; browser back/forward is handled via popstate below.
function viewFromPath(): View {
  return window.location.pathname === "/submissions" ? "dashboards" : "upload";
}

export function App({ client, auth }: Props) {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [principal, setPrincipal] = useState<ClientPrincipal | null>(null);
  const [view, setView] = useState<View>(viewFromPath);

  useEffect(() => {
    let active = true;
    auth.me().then((me) => {
      if (!active) return;
      setPrincipal(me);
      setAuthState(me ? "in" : "out");
    });
    return () => {
      active = false;
    };
  }, [auth]);

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
      <AppHeader view={view} onNavigate={navigate} principal={principal} logoutUrl={auth.logoutUrl()} />
      <main
        className={`mx-auto flex w-[min(1120px,calc(100%-40px))] flex-col py-8 ${
          view === "upload" ? "justify-center" : "justify-start"
        }`}
        style={{ minHeight: "calc(100vh - 57px)" }}
      >
        {view === "upload" ? (
          <UploadView client={client} onViewDashboards={() => navigate("dashboards")} />
        ) : (
          <DashboardsView client={client} onUpload={() => navigate("upload")} />
        )}
      </main>
    </>
  );
}
