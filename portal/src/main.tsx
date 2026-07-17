import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { SameOriginRequestAdapter } from "./api/RequestAdapter";
import { SubmissionClient } from "./api/SubmissionClient";
import { SwaAuthClient, type ClientPrincipal } from "./api/authClient";
import "./styles.css";

// In local dev there is no SWA edge, so /.auth/me 404s; a dev principal keeps
// the portal usable without standing up Static Web Apps. Null in production.
const devPrincipal: ClientPrincipal | null = import.meta.env.DEV
  ? { identityProvider: "dev", userId: "dev-user", userDetails: "dev@ssw.com.au", userRoles: ["authenticated"] }
  : null;

const auth = new SwaAuthClient(devPrincipal);
const client = new SubmissionClient(new SameOriginRequestAdapter(), undefined, () =>
  window.location.assign(auth.loginUrl(window.location.pathname)),
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App client={client} auth={auth} />
  </StrictMode>,
);
