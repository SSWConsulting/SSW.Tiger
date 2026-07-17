import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UploadView } from "./UploadView";

function makeClient(overrides: Record<string, unknown> = {}) {
  return { submit: vi.fn(), submitLink: vi.fn(), ...overrides } as never;
}

const validLink = `https://teams.microsoft.com/l/meetup-join/19:x/0?context=${encodeURIComponent('{"Oid":"o1"}')}`;

describe("UploadView", () => {
  it("validates required input without calling the client", async () => {
    const submit = vi.fn();
    render(<UploadView client={makeClient({ submit })} onViewDashboards={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /generate dashboard/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a project name");
    expect(submit).not.toHaveBeenCalled();
  });

  it("submits a transcript file and shows the reference id", async () => {
    const submit = vi.fn().mockResolvedValue({ requestId: "request-123", status: "accepted" });
    render(<UploadView client={makeClient({ submit })} onViewDashboards={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Tiger" } });
    const file = new File(["WEBVTT\n\nhello"], "meeting.vtt", { type: "text/vtt" });
    fireEvent.change(screen.getByLabelText("Choose transcript file"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: /generate dashboard/i }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("Tiger", file));
    expect(await screen.findByText("request-123")).toBeInTheDocument();
  });

  it("submits a meeting link when in link mode", async () => {
    const submitLink = vi.fn().mockResolvedValue({ requestId: "request-999", status: "accepted" });
    render(<UploadView client={makeClient({ submitLink })} onViewDashboards={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: /paste meeting link/i }));
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Tiger" } });
    fireEvent.change(screen.getByLabelText("Teams meeting link"), { target: { value: validLink } });
    fireEvent.click(screen.getByRole("button", { name: /generate dashboard/i }));
    await waitFor(() => expect(submitLink).toHaveBeenCalledWith("Tiger", validLink));
    expect(await screen.findByText("request-999")).toBeInTheDocument();
  });

  it("rejects a meeting link missing the context param", async () => {
    const submitLink = vi.fn();
    render(<UploadView client={makeClient({ submitLink })} onViewDashboards={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: /paste meeting link/i }));
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Tiger" } });
    fireEvent.change(screen.getByLabelText("Teams meeting link"), {
      target: { value: "https://teams.microsoft.com/l/meetup-join/19:x/0" },
    });
    fireEvent.click(screen.getByRole("button", { name: /generate dashboard/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("missing meeting info");
    expect(submitLink).not.toHaveBeenCalled();
  });

  it("routes to My dashboards from the success state", async () => {
    const onViewDashboards = vi.fn();
    const submit = vi.fn().mockResolvedValue({ requestId: "request-123", status: "accepted" });
    render(<UploadView client={makeClient({ submit })} onViewDashboards={onViewDashboards} />);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Tiger" } });
    fireEvent.change(screen.getByLabelText("Choose transcript file"), {
      target: { files: [new File(["WEBVTT\n\nx"], "m.vtt", { type: "text/vtt" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: /generate dashboard/i }));
    fireEvent.click(await screen.findByRole("button", { name: /view my dashboards/i }));
    expect(onViewDashboards).toHaveBeenCalled();
  });

  it("shows an actionable API error", async () => {
    const submit = vi.fn().mockRejectedValue(new Error("The transcript must start with WEBVTT."));
    render(<UploadView client={makeClient({ submit })} onViewDashboards={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Tiger" } });
    fireEvent.change(screen.getByLabelText("Choose transcript file"), {
      target: { files: [new File(["bad"], "meeting.vtt")] },
    });
    fireEvent.click(screen.getByRole("button", { name: /generate dashboard/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("WEBVTT");
  });
});
