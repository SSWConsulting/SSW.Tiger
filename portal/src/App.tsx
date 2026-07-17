import { FormEvent, useState } from "react";
import { TranscriptDropzone } from "./components/TranscriptDropzone";
import type { SubmissionClient } from "./api/SubmissionClient";

const MAX_BYTES = 10 * 1024 * 1024;

type Props = { client: SubmissionClient };
type State = "idle" | "uploading" | "accepted" | "failed";

function validate(projectName: string, file: File | null) {
  if (!projectName.trim()) return "Enter a project name.";
  if (!file) return "Choose a transcript file.";
  if (!file.name.toLowerCase().endsWith(".vtt")) return "Choose a .vtt transcript file.";
  if (file.size === 0) return "The transcript file is empty.";
  if (file.size > MAX_BYTES) return "The transcript must be 10 MB or smaller.";
  return "";
}

export function App({ client }: Props) {
  const [projectName, setProjectName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<State>("idle");
  const [message, setMessage] = useState("");
  const [requestId, setRequestId] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const error = validate(projectName, file);
    if (error) { setState("failed"); setMessage(error); return; }
    setState("uploading");
    setMessage("");
    try {
      const result = await client.submit(projectName.trim(), file!);
      setRequestId(result.requestId);
      setState("accepted");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The transcript could not be submitted.");
      setState("failed");
    }
  }

  function reset() {
    setFile(null); setProjectName(""); setRequestId(""); setMessage(""); setState("idle");
  }

  return (
    <main>
      <header className="brand"><span className="brand-mark">T</span><span>T.I.G.E.R.</span></header>
      <section className="hero">
        <p className="eyebrow">Meeting intelligence</p>
        <h1>Turn a transcript into<br /><em>actionable insight.</em></h1>
        <p className="intro">Upload a Microsoft Teams WebVTT transcript. Tiger will analyse the conversation and generate a meeting dashboard.</p>
      </section>

      <section className="panel" aria-labelledby="upload-title">
        {state === "accepted" ? (
          <div className="success" role="status">
            <div className="success-mark" aria-hidden="true">✓</div>
            <p className="eyebrow">Submission accepted</p>
            <h2>Your transcript is in the queue.</h2>
            <p>Keep this request ID for reference:</p>
            <code>{requestId}</code>
            <button className="primary-button" type="button" onClick={reset}>Upload another transcript</button>
          </div>
        ) : (
          <form onSubmit={submit} noValidate>
            <div className="panel-heading"><div><p className="step">01 / Submit</p><h2 id="upload-title">Upload transcript</h2></div><span className="private-note">Private transcript source</span></div>
            <label htmlFor="projectName">Project name</label>
            <input id="projectName" name="projectName" maxLength={100} value={projectName} disabled={state === "uploading"} onChange={(event) => setProjectName(event.target.value)} placeholder="e.g. Tiger" />
            <label>Transcript file</label>
            <TranscriptDropzone file={file} disabled={state === "uploading"} onSelect={setFile} />
            {state === "failed" && <div className="error" role="alert">{message}</div>}
            <button className="primary-button" type="submit" disabled={state === "uploading"}>
              {state === "uploading" ? "Uploading…" : "Generate dashboard"}
            </button>
          </form>
        )}
      </section>
      <footer>Transcript content is sent directly to Tiger and is never stored in this browser.</footer>
    </main>
  );
}

export { validate };
