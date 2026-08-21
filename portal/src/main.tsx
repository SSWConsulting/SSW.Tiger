import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { type ClientPrincipal, SwaAuthClient } from "./api/authClient";
import { SameOriginRequestAdapter } from "./api/RequestAdapter";
import { SubmissionClient } from "./api/SubmissionClient";
import { SubmissionsCache } from "./api/submissionsCache";
import "./styles.css";

// In local dev there is no SWA edge, so /.auth/me 404s; a dev principal keeps
// the portal usable without standing up Static Web Apps. Null in production.
const devPrincipal: ClientPrincipal | null = import.meta.env.DEV
  ? { identityProvider: "dev", userId: "dev-user", userDetails: "dev@ssw.com.au", userRoles: ["authenticated"] }
  : null;

// Set by the inline <script> in index.html, which starts the submissions request
// before this bundle is even requested. Absent when that script did not run
// (vitest, or a future host that serves a different shell).
declare global {
  interface Window {
    __tigerSubmissions?: Promise<Response | null>;
  }
}

const auth = new SwaAuthClient(devPrincipal);
const client = new SubmissionClient(
  new SameOriginRequestAdapter(),
  undefined,
  () => window.location.assign(auth.loginUrl(window.location.pathname)),
  undefined,
  window.__tigerSubmissions ?? null,
);

const submissions = new SubmissionsCache((options) => client.list(options));

// Adopt the request index.html already started (or issue it now if that script
// didn't run) — before rendering, and in parallel with the /.auth/me call App
// makes. It hits a Consumption Function whose worker the platform recycles every
// ~8 minutes, so overlapping this wait with auth and hydration rather than
// queueing behind them is the single biggest win available client-side.
//
// Unconditional on purpose, even when the user lands on /submit: the response is
// only a small JSON list, and warming the Function is exactly what makes a later
// switch to My submissions feel instant. SWA already gates /* on the
// `authenticated` role, so by the time this module runs the caller is signed in.
submissions.prefetch();

// Hydrate this tab's rows from the REMEMBERED identity, before React mounts, so
// they paint in the first frame instead of after /.auth/me returns. App calls
// bindOwner again with the confirmed principal, which is what makes trusting the
// remembered one here safe — a mismatch discards these rows.
const remembered = auth.cachedMe();
if (remembered) submissions.bindOwner(remembered.userId);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App client={client} auth={auth} submissions={submissions} />
  </StrictMode>,
);
