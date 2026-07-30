import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { AuthClient, ClientPrincipal } from "./api/authClient";
import { SubmissionsCache } from "./api/submissionsCache";

const principal: ClientPrincipal = {
  identityProvider: "aad",
  userId: "u1",
  userDetails: "willow@ssw.com.au",
  userRoles: ["authenticated"],
};

function makeAuth(me: ClientPrincipal | null, cached: ClientPrincipal | null = null): AuthClient {
  return {
    me: vi.fn().mockResolvedValue(me),
    cachedMe: () => cached,
    forget: vi.fn(),
    loginUrl: () => "/.auth/login/aad",
    logoutUrl: () => "/.auth/logout",
  };
}

const client = { submit: vi.fn(), list: vi.fn().mockResolvedValue([]) } as never;
const newCache = () => new SubmissionsCache(async () => [], null);

describe("App shell", () => {
  it("shows the sign-in gate when there is no principal", async () => {
    render(<App client={client} auth={makeAuth(null)} submissions={newCache()} />);
    expect(await screen.findByRole("link", { name: /sign in with ssw/i })).toBeInTheDocument();
  });

  it("renders the authenticated shell with the upload view and nav", async () => {
    render(<App client={client} auth={makeAuth(principal)} submissions={newCache()} />);
    expect(await screen.findByRole("button", { name: /^my submissions$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /submit a meeting/i })).toBeInTheDocument();
    expect(screen.getByText("willow@ssw.com.au")).toBeInTheDocument();
  });

  it("binds the signed-in user to the cache so its rows are scoped to them", async () => {
    const cache = newCache();
    const bindOwner = vi.spyOn(cache, "bindOwner");
    render(<App client={client} auth={makeAuth(principal)} submissions={cache} />);
    await screen.findByRole("button", { name: /^my submissions$/i });
    expect(bindOwner).toHaveBeenCalledWith("u1");
  });

  it("paints the shell from the remembered principal without waiting on /.auth/me", () => {
    // Deliberately synchronous — no findBy/await. The point is that the first
    // frame is the real app, not the "Loading…" gate, so the /.auth/me round trip
    // is no longer in front of anything the user can see.
    const auth = makeAuth(principal, principal);
    render(<App client={client} auth={auth} submissions={newCache()} />);
    expect(screen.getByRole("button", { name: /^my submissions$/i })).toBeInTheDocument();
    expect(screen.queryByText(/^loading…$/i)).not.toBeInTheDocument();
  });

  it("falls back to the sign-in gate when the remembered session has expired", async () => {
    // Optimism has to be correctable: remembered principal, but SWA says no.
    render(<App client={client} auth={makeAuth(null, principal)} submissions={newCache()} />);
    expect(await screen.findByRole("link", { name: /sign in with ssw/i })).toBeInTheDocument();
  });

  it("does not bind an owner when nobody is signed in", async () => {
    const cache = newCache();
    const bindOwner = vi.spyOn(cache, "bindOwner");
    render(<App client={client} auth={makeAuth(null)} submissions={cache} />);
    await screen.findByRole("link", { name: /sign in with ssw/i });
    expect(bindOwner).not.toHaveBeenCalled();
  });
});
