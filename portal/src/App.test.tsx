import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { AuthClient, ClientPrincipal } from "./api/authClient";

const principal: ClientPrincipal = {
  identityProvider: "aad",
  userId: "u1",
  userDetails: "willow@ssw.com.au",
  userRoles: ["authenticated"],
};

function makeAuth(me: ClientPrincipal | null): AuthClient {
  return {
    me: vi.fn().mockResolvedValue(me),
    loginUrl: () => "/.auth/login/aad",
    logoutUrl: () => "/.auth/logout",
  };
}

const client = { submit: vi.fn(), list: vi.fn().mockResolvedValue([]) } as never;

describe("App shell", () => {
  it("shows the sign-in gate when there is no principal", async () => {
    render(<App client={client} auth={makeAuth(null)} />);
    expect(await screen.findByRole("link", { name: /sign in with ssw/i })).toBeInTheDocument();
  });

  it("renders the authenticated shell with the upload view and nav", async () => {
    render(<App client={client} auth={makeAuth(principal)} />);
    expect(await screen.findByRole("button", { name: /^my submissions$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /submit a meeting/i })).toBeInTheDocument();
    expect(screen.getByText("willow@ssw.com.au")).toBeInTheDocument();
  });
});
