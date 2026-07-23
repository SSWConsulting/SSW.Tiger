import { useEffect, useState } from "react";
import { AppHeader, type View } from "./components/AppHeader";
import { UploadView } from "./views/UploadView";
import { DashboardsView } from "./views/DashboardsView";
import { SignInView } from "./views/SignInView";
import type { SubmissionClient } from "./api/SubmissionClient";
import type { AuthClient, ClientPrincipal } from "./api/authClient";

type Props = { client: SubmissionClient; auth: AuthClient };
type AuthState = "checking" | "in" | "out";

export function App({ client, auth }: Props) {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [principal, setPrincipal] = useState<ClientPrincipal | null>(null);
  const [view, setView] = useState<View>("upload");

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

  if (authState === "checking") {
    return <main className="grid min-h-screen place-items-center text-ssw-gray-500">Loading…</main>;
  }

  if (authState === "out" || !principal) {
    return <SignInView loginUrl={auth.loginUrl(window.location.pathname)} />;
  }

  return (
    <>
      <AppHeader view={view} onNavigate={setView} principal={principal} logoutUrl={auth.logoutUrl()} />
      <main
        className={`mx-auto flex w-[min(1120px,calc(100%-40px))] flex-col py-8 ${
          view === "upload" ? "justify-center" : "justify-start"
        }`}
        style={{ minHeight: "calc(100vh - 57px)" }}
      >
        {view === "upload" ? (
          <UploadView client={client} onViewDashboards={() => setView("dashboards")} />
        ) : (
          <DashboardsView client={client} onUpload={() => setView("upload")} />
        )}
      </main>
    </>
  );
}
