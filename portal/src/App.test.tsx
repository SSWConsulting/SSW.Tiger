import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";

function makeClient(submit = vi.fn()) {
  return { submit } as never;
}

describe("Upload UI", () => {
  it("validates required input without calling the client", async () => {
    const submit = vi.fn();
    render(<App client={makeClient(submit)} />);
    fireEvent.click(screen.getByRole("button", { name: /generate dashboard/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a project name");
    expect(submit).not.toHaveBeenCalled();
  });

  it("submits through SubmissionClient and shows requestId", async () => {
    const submit = vi.fn().mockResolvedValue({ requestId: "request-123", status: "accepted" });
    render(<App client={makeClient(submit)} />);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Tiger" } });
    const file = new File(["WEBVTT\n\nhello"], "meeting.vtt", { type: "text/vtt" });
    fireEvent.change(screen.getByLabelText("Choose transcript file"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: /generate dashboard/i }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("Tiger", file));
    expect(await screen.findByText("request-123")).toBeInTheDocument();
  });

  it("shows an actionable API error", async () => {
    const submit = vi.fn().mockRejectedValue(new Error("The transcript must start with WEBVTT."));
    render(<App client={makeClient(submit)} />);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Tiger" } });
    fireEvent.change(screen.getByLabelText("Choose transcript file"), { target: { files: [new File(["bad"], "meeting.vtt")] } });
    fireEvent.click(screen.getByRole("button", { name: /generate dashboard/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("WEBVTT");
  });
});
