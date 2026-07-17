import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { SameOriginRequestAdapter } from "./api/RequestAdapter";
import { SubmissionClient } from "./api/SubmissionClient";
import "./styles.css";

const client = new SubmissionClient(new SameOriginRequestAdapter());
createRoot(document.getElementById("root")!).render(<StrictMode><App client={client} /></StrictMode>);
