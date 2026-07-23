import { type FormEvent, useState } from "react";
import type { SubmissionClient } from "../api/SubmissionClient";
import { TranscriptDropzone } from "../components/TranscriptDropzone";

const MAX_BYTES = 10 * 1024 * 1024;

// Decorative field markers — aria-hidden so the accessible name stays the field label.
function RequiredMark() {
  return (
    <span aria-hidden="true" className="text-primary">
      {" "}
      *
    </span>
  );
}
function OptionalMark() {
  return (
    <span aria-hidden="true" className="font-normal text-ssw-gray-500">
      {" "}
      (optional)
    </span>
  );
}

type Props = {
  client: SubmissionClient;
  onViewDashboards: () => void;
};
type Mode = "file" | "link";
type State = "idle" | "uploading" | "accepted" | "failed";

function validate(mode: Mode, projectName: string, file: File | null, meetingLink: string) {
  if (mode === "file") {
    if (!projectName.trim()) return "Enter a project name.";
    if (!file) return "Choose a transcript file.";
    if (!file.name.toLowerCase().endsWith(".vtt")) return "Choose a .vtt transcript file.";
    if (file.size === 0) return "The transcript file is empty.";
    if (file.size > MAX_BYTES) return "The transcript must be 10 MB or smaller.";
  } else {
    // Project name is optional for meeting links — the meeting subject fills it in.
    // Format is only checked loosely here; the server does the real resolution.
    const link = meetingLink.trim();
    if (!link) return "Paste a meeting link or Meeting ID.";
    const isMeetingId = /^\d{9,20}$/.test(link.replace(/\s+/g, ""));
    const isTeamsUrl = /^https?:\/\/teams\.(microsoft|live)\.com\//i.test(link);
    if (!isMeetingId && !isTeamsUrl) return "Enter a Teams meeting link or the numeric Meeting ID.";
  }
  return "";
}

export function UploadView({ client, onViewDashboards }: Props) {
  const [mode, setMode] = useState<Mode>("file");
  const [projectName, setProjectName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [meetingLink, setMeetingLink] = useState("");
  const [attendeeEmail, setAttendeeEmail] = useState("");
  const [state, setState] = useState<State>("idle");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const error = validate(mode, projectName, file, meetingLink);
    if (error) {
      setState("failed");
      setMessage(error);
      return;
    }
    setState("uploading");
    setMessage("");
    try {
      await (mode === "file"
        ? client.submit(projectName.trim(), file!)
        : client.submitLink(projectName.trim(), meetingLink.trim(), attendeeEmail.trim()));
      setState("accepted");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The transcript could not be submitted.");
      setState("failed");
    }
  }

  function reset() {
    setFile(null);
    setMeetingLink("");
    setAttendeeEmail("");
    setProjectName("");
    setMessage("");
    setState("idle");
  }

  function switchMode(next: Mode) {
    setMode(next);
    setMessage("");
    if (state === "failed") setState("idle");
  }

  const busy = state === "uploading";

  return (
    <div className="grid items-center gap-[clamp(2rem,5vw,4.5rem)] md:grid-cols-[1fr_minmax(0,600px)]">
      <section className="max-w-[560px]">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">AI meeting analysis</p>
        <h1 className="mb-4 mt-3 text-[clamp(2.125rem,4.4vw,3.25rem)] font-bold leading-[1.04] tracking-[-0.03em] text-ssw-charcoal-800">
          Turn a meeting
          <br />
          into <em className="not-italic text-primary">actionable insight.</em>
        </h1>
        <p className="max-w-[520px] text-base leading-relaxed text-ssw-gray-600">
          Upload a Microsoft Teams transcript or paste a meeting link. Tiger will analyse the conversation and generate
          a meeting dashboard.
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
              Your meeting is in the queue.
            </h2>
            <p className="mt-3 text-black/60">Track its progress and open the dashboard from My submissions.</p>
            <div className="mt-6 flex flex-col gap-2.5">
              <button
                className="rounded-ds-sm border border-primary bg-primary px-5 py-3.5 font-semibold text-white transition hover:bg-ssw-red-600"
                type="button"
                onClick={onViewDashboards}
              >
                View my submissions
              </button>
              <button
                className="rounded-ds-sm border border-black/10 bg-transparent px-4 py-2.5 font-medium text-ssw-charcoal transition hover:bg-black/5"
                type="button"
                onClick={reset}
              >
                Submit another meeting
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="p-[clamp(1.375rem,3.5vw,2.125rem)]">
            <div className="mb-5">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">Submit</p>
              <h2 id="upload-title" className="mt-1 text-3xl font-bold tracking-[-0.02em] text-ssw-charcoal-800">
                Submit a meeting
              </h2>
            </div>

            <div
              className="mb-4 grid grid-cols-2 gap-1 rounded-ds-sm bg-ssw-gray-100 p-1"
              role="tablist"
              aria-label="Submission type"
            >
              {(
                [
                  { id: "file", label: "Upload transcript" },
                  { id: "link", label: "Paste meeting link" },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={mode === tab.id}
                  disabled={busy}
                  onClick={() => switchMode(tab.id)}
                  className={`rounded-[3px] px-3 py-2 text-sm font-semibold transition ${
                    mode === tab.id
                      ? "bg-white text-ssw-charcoal shadow-ds-raised"
                      : "text-ssw-gray-500 hover:text-ssw-charcoal"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <label htmlFor="projectName" className="mb-2 mt-4 block text-[13px] font-semibold text-ssw-charcoal">
              Project name{mode === "file" ? <RequiredMark /> : <OptionalMark />}
            </label>
            <input
              id="projectName"
              name="projectName"
              maxLength={100}
              value={projectName}
              disabled={busy}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="e.g. Northwind"
              className="w-full rounded-ds-sm border border-black/10 bg-white px-3.5 py-3 outline-none transition focus:border-primary focus:shadow-[0_0_0_3px_rgba(205,66,66,0.14)]"
            />
            {mode === "link" && (
              <p className="mt-2 text-[13px] text-ssw-gray-500">We'll use the meeting name if you leave this blank.</p>
            )}

            {mode === "file" ? (
              <>
                <p className="mb-2 mt-4 block text-[13px] font-semibold text-ssw-charcoal">
                  Transcript file
                  <RequiredMark />
                </p>
                <TranscriptDropzone file={file} disabled={busy} onSelect={setFile} />
              </>
            ) : (
              <>
                <label htmlFor="meetingLink" className="mb-2 mt-4 block text-[13px] font-semibold text-ssw-charcoal">
                  Meeting Join link or Meeting ID
                  <RequiredMark />
                </label>
                <input
                  id="meetingLink"
                  name="meetingLink"
                  value={meetingLink}
                  disabled={busy}
                  onChange={(event) => setMeetingLink(event.target.value)}
                  placeholder="teams.microsoft.com/meet/… or Meeting ID"
                  className="w-full rounded-ds-sm border border-black/10 bg-white px-3.5 py-3 outline-none transition focus:border-primary focus:shadow-[0_0_0_3px_rgba(205,66,66,0.14)]"
                />
                <p className="mt-2 text-[13px] text-ssw-gray-500">
                  Enter a Teams join link or Meeting ID from the invite. The transcript must already be available.{" "}
                </p>
                <label htmlFor="attendeeEmail" className="mb-2 mt-4 block text-[13px] font-semibold text-ssw-charcoal">
                  Attendee email
                  <OptionalMark />
                </label>
                <input
                  id="attendeeEmail"
                  name="attendeeEmail"
                  type="email"
                  value={attendeeEmail}
                  disabled={busy}
                  onChange={(event) => setAttendeeEmail(event.target.value)}
                  placeholder="colleague@ssw.com.au"
                  className="w-full rounded-ds-sm border border-black/10 bg-white px-3.5 py-3 outline-none transition focus:border-primary focus:shadow-[0_0_0_3px_rgba(205,66,66,0.14)]"
                />
                <p className="mt-2 text-[13px] text-ssw-gray-500">
                  Enter someone listed on the calendar invite. Leave blank if you’re already invited. People added
                  during the meeting may not be found.
                </p>
              </>
            )}

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
              disabled={busy}
            >
              {busy ? "Submitting…" : "Generate dashboard"}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}

export { validate };
