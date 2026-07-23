import { useEffect, useState } from "react";
import { AppHeader, type View } from "./components/AppHeader";
import { UploadView } from "./views/UploadView";
import { DashboardsView } from "./views/DashboardsView";
import { SignInView } from "./views/SignInView";
import type { SubmissionClient } from "./api/SubmissionClient";
import type { AuthClient, ClientPrincipal } from "./api/authClient";

type Props = { client: SubmissionClient; auth: AuthClient };
type AuthState = "checking" | "in" | "out";

// The active tab lives in the URL hash so a refresh (SWA serves index.html for
// every path) and browser back/forward preserve which tab you're on.
function viewFromHash(): View {
  return window.location.hash.replace(/^#/, "") === "submissions" ? "dashboards" : "upload";
}

export function App({ client, auth }: Props) {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [principal, setPrincipal] = useState<ClientPrincipal | null>(null);
  const [view, setView] = useState<View>(viewFromHash);

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
    const onHash = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Navigating updates the hash; the listener above is the single source of truth.
  const navigate = (next: View) => {
    window.location.hash = next === "dashboards" ? "#submissions" : "#submit";
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
