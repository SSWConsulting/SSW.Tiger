import { type FormEvent, useState } from "react";
import { TranscriptDropzone } from "../components/TranscriptDropzone";
import type { SubmissionClient } from "../api/SubmissionClient";

const MAX_BYTES = 10 * 1024 * 1024;

type Props = {
  client: SubmissionClient;
  onViewDashboards: () => void;
};
type State = "idle" | "uploading" | "accepted" | "failed";

function validate(projectName: string, file: File | null) {
  if (!projectName.trim()) return "Enter a project name.";
  if (!file) return "Choose a transcript file.";
  if (!file.name.toLowerCase().endsWith(".vtt")) return "Choose a .vtt transcript file.";
  if (file.size === 0) return "The transcript file is empty.";
  if (file.size > MAX_BYTES) return "The transcript must be 10 MB or smaller.";
  return "";
}

export function UploadView({ client, onViewDashboards }: Props) {
  const [projectName, setProjectName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<State>("idle");
  const [message, setMessage] = useState("");
  const [requestId, setRequestId] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const error = validate(projectName, file);
    if (error) {
      setState("failed");
      setMessage(error);
      return;
    }
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
    setFile(null);
    setProjectName("");
    setRequestId("");
    setMessage("");
    setState("idle");
  }

  return (
    <div className="grid items-center gap-[clamp(2rem,5vw,4.5rem)] md:grid-cols-[1fr_minmax(0,600px)]">
      <section className="max-w-[560px]">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">AI meeting analysis</p>
        <h1 className="mb-4 mt-3 text-[clamp(2.125rem,4.4vw,3.25rem)] font-bold leading-[1.04] tracking-[-0.03em] text-ssw-charcoal-800">
          Turn a transcript
          <br />
          into <em className="not-italic text-primary">actionable insight.</em>
        </h1>
        <p className="max-w-[520px] text-base leading-relaxed text-ssw-gray-600">
          Upload a Microsoft Teams WebVTT transcript. Parrot will analyse the conversation and generate a meeting
          dashboard.
        </p>
        <ul className="mt-7 flex max-w-[480px] flex-col gap-3.5">
          {[
            "Speaker-by-speaker breakdown and contribution scoring",
            "Decisions, action items, and risks surfaced automatically",
            "A shareable multi-tab dashboard in minutes",
          ].map((point) => (
            <li key={point} className="flex items-start gap-3 text-[15px] leading-snug text-ssw-charcoal">
              <span
                className="mt-px grid h-[22px] w-[22px] flex-none place-items-center rounded-full bg-ssw-red-500/10 text-xs font-bold text-primary"
                aria-hidden="true"
              >
                ✓
              </span>
              {point}
            </li>
          ))}
        </ul>
      </section>

      <section
        className="w-full rounded-ds border border-black/10 bg-white shadow-ds-raised"
        aria-labelledby="upload-title"
      >
        {state === "accepted" ? (
          <div className="px-[clamp(1.375rem,3.5vw,2.125rem)] py-16 text-center" role="status">
            <div
              className="mx-auto mb-5 grid h-[58px] w-[58px] place-items-center rounded-full bg-success/5 text-3xl text-success"
              aria-hidden="true"
            >
              ✓
            </div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">Submission accepted</p>
            <h2 className="mt-2 text-2xl font-bold tracking-[-0.02em] text-ssw-charcoal-800">
              Your transcript is in the queue.
            </h2>
            <p className="mt-3 text-black/60">
              Track its progress and open the dashboard from My dashboards. Reference ID:
            </p>
            <code className="mx-auto mt-4 block max-w-full overflow-hidden text-ellipsis rounded-ds-sm border border-black/10 bg-ssw-gray-50 p-3 font-mono text-sm">
              {requestId}
            </code>
            <div className="mt-6 flex flex-col gap-2.5">
              <button
                className="rounded-ds-sm border border-primary bg-primary px-5 py-3.5 font-semibold text-white transition hover:bg-ssw-red-600"
                type="button"
                onClick={onViewDashboards}
              >
                View my dashboards
              </button>
              <button
                className="rounded-ds-sm border border-black/10 bg-transparent px-4 py-2.5 font-medium text-ssw-charcoal transition hover:bg-black/5"
                type="button"
                onClick={reset}
              >
                Upload another transcript
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="p-[clamp(1.375rem,3.5vw,2.125rem)]">
            <div className="mb-5">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">01 / Submit</p>
              <h2 id="upload-title" className="mt-1 text-3xl font-bold tracking-[-0.02em] text-ssw-charcoal-800">
                Upload transcript
              </h2>
            </div>
            <label htmlFor="projectName" className="mb-2 mt-4 block text-[13px] font-semibold text-ssw-charcoal">
              Project name
            </label>
            <input
              id="projectName"
              name="projectName"
              maxLength={100}
              value={projectName}
              disabled={state === "uploading"}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="e.g. Acme Rebuild"
              className="w-full rounded-ds-sm border border-black/10 bg-white px-3.5 py-3 outline-none transition focus:border-primary focus:shadow-[0_0_0_3px_rgba(205,66,66,0.14)]"
            />
            <p className="mb-2 mt-4 block text-[13px] font-semibold text-ssw-charcoal">Transcript file</p>
            <TranscriptDropzone file={file} disabled={state === "uploading"} onSelect={setFile} />
            {state === "failed" && (
              <div
                className="mt-4 rounded-ds-sm border border-destructive/25 bg-destructive/5 px-3.5 py-3 text-sm text-destructive"
                role="alert"
              >
                {message}
              </div>
            )}
            <button
              className="mt-5 w-full rounded-ds-sm border border-primary bg-primary px-5 py-3.5 font-semibold text-white transition hover:bg-ssw-red-600 disabled:cursor-wait disabled:opacity-60"
              type="submit"
              disabled={state === "uploading"}
            >
              {state === "uploading" ? "Uploading…" : "Generate dashboard"}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}

export { validate };
