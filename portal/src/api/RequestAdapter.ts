export interface RequestAdapter {
  prepare(init: RequestInit): Promise<RequestInit>;
}

// Uses same-origin cookies/headers. Easy Auth, SWA or a reverse proxy can be
// introduced later by replacing only this adapter.
export class SameOriginRequestAdapter implements RequestAdapter {
  async prepare(init: RequestInit): Promise<RequestInit> {
    return { ...init, credentials: "same-origin" };
  }
}
