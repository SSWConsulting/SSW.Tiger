const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const { describe, it } = require("node:test");
const vm = require("node:vm");

const {
  generateDashboardPassword,
  encryptDashboardHtml,
  decryptDashboardPayload,
  extractEncryptedPayloadFromUnlockPage,
  renderUnlockPage,
} = require("./dashboardEncryption");

function getUnlockPageScript(unlockPage) {
  const match = unlockPage.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, "unlock page should contain a script");
  return match[1];
}

async function runUnlockPageScript(unlockPage, hash, onDeriveKey, replaceStateError = null) {
  const listeners = {};
  const elements = {
    "unlock-form": {
      addEventListener(type, listener) {
        listeners[type] = listener;
      },
    },
    password: { value: "", focus() {} },
    "unlock-button": { disabled: false, textContent: "Unlock dashboard" },
    error: { textContent: "" },
  };
  const state = {
    writtenHtml: "",
    replacementUrl: null,
    navigationUrl: null,
    deriveKeyStarted: false,
    deriveKeyCalls: 0,
  };
  const crypto = {
    subtle: {
      ...webcrypto.subtle,
      importKey: async (...args) => {
        state.deriveKeyStarted = true;
        state.deriveKeyCalls += 1;
        await onDeriveKey?.(state);
        return webcrypto.subtle.importKey(...args);
      },
      deriveKey: (...args) => webcrypto.subtle.deriveKey(...args),
      decrypt: (...args) => webcrypto.subtle.decrypt(...args),
    },
  };
  const context = {
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    crypto,
    decodeURIComponent,
    document: {
      getElementById: (id) => elements[id],
      open() {},
      write(value) {
        state.writtenHtml = value;
      },
      close() {},
    },
    history: {
      state: { source: "teams" },
      replaceState(_state, _title, url) {
        if (replaceStateError) throw replaceStateError;
        state.replacementUrl = url;
      },
    },
    location: {
      hash,
      pathname: "/crm/2026-07-09-100000/",
      search: "?view=summary",
      replace(url) {
        state.navigationUrl = url;
      },
    },
    TextDecoder,
    TextEncoder,
  };

  vm.runInNewContext(getUnlockPageScript(unlockPage), context);
  return { elements, listeners, state };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for unlock page script");
}

describe("dashboard encryption", () => {
  it("round-trips dashboard HTML with the generated password", () => {
    const password = generateDashboardPassword();
    const html = "<!DOCTYPE html><html><body><h1>Secret dashboard</h1></body></html>";
    const payload = encryptDashboardHtml(html, password, { iterations: 1000 });

    assert.equal(decryptDashboardPayload(payload, password), html);
    assert.throws(() => decryptDashboardPayload(payload, "wrong-password"));
  });

  it("renders an unlock page with an extractable encrypted payload", () => {
    const password = "ABCD-EFGH-IJKL";
    const html = "<main>Dashboard</main>";
    const payload = encryptDashboardHtml(html, password, { iterations: 1000 });
    const unlockPage = renderUnlockPage({
      projectName: "crm",
      meetingId: "2026-07-09-100000",
      meetingTitle: "Sprint review",
      encryptedPayload: payload,
    });

    const extracted = extractEncryptedPayloadFromUnlockPage(unlockPage);
    assert.equal(decryptDashboardPayload(extracted, password), html);
    assert.equal(unlockPage.includes(html), false);
    assert.equal(unlockPage.includes("Sprint review"), false);
    assert.equal(unlockPage.includes("crm / 2026-07-09-100000"), false);
    assert.equal(unlockPage.includes("2026-07-09-100000"), false);
  });

  it("does not render meeting metadata on the public unlock page", () => {
    const payload = encryptDashboardHtml("<main>Dashboard</main>", "ABCD-EFGH-IJKL", {
      iterations: 1000,
    });
    const unlockPage = renderUnlockPage({
      projectName: "crm",
      meetingId: "2026-07-09-100000",
      meetingTitle: "CRM - Client X Sprint Review",
      encryptedPayload: payload,
    });

    assert.equal(unlockPage.includes('class="meta"'), false);
    assert.equal(unlockPage.includes("Client X"), false);
    assert.equal(unlockPage.includes("2026-07-09-100000"), false);
  });

  it("automatically unlocks a valid k fragment after clearing it", async () => {
    const password = "ABCD-EFGH-IJKL";
    const dashboardHtml = "<main>Secret dashboard</main>";
    const encryptedPayload = encryptDashboardHtml(dashboardHtml, password, {
      iterations: 1000,
    });
    const unlockPage = renderUnlockPage({ projectName: "crm", encryptedPayload });

    const { state } = await runUnlockPageScript(
      unlockPage,
      `#k=${encodeURIComponent(password)}`,
      (currentState) => {
        assert.equal(currentState.replacementUrl, "/crm/2026-07-09-100000/?view=summary");
      },
    );
    await waitFor(() => state.writtenHtml !== "");

    assert.equal(state.deriveKeyStarted, true);
    assert.equal(state.writtenHtml, dashboardHtml);
  });

  it("clears malformed fragments and keeps the manual form usable", async () => {
    const password = "ABCD-EFGH-IJKL";
    const dashboardHtml = "<main>Secret dashboard</main>";
    const encryptedPayload = encryptDashboardHtml(dashboardHtml, password, {
      iterations: 1000,
    });
    const unlockPage = renderUnlockPage({ projectName: "crm", encryptedPayload });

    const { elements, listeners, state } = await runUnlockPageScript(unlockPage, "#k=%E0%A4%A");

    assert.equal(state.replacementUrl, "/crm/2026-07-09-100000/?view=summary");
    assert.equal(state.deriveKeyStarted, false);
    assert.equal(elements.error.textContent, "");

    elements.password.value = password;
    await listeners.submit({ preventDefault() {} });

    assert.equal(state.writtenHtml, dashboardHtml);
  });

  it("shows the existing error for an incorrect k fragment and keeps the form", async () => {
    const encryptedPayload = encryptDashboardHtml("<main>Dashboard</main>", "ABCD-EFGH-IJKL", {
      iterations: 1000,
    });
    const unlockPage = renderUnlockPage({ projectName: "crm", encryptedPayload });

    const { elements, state } = await runUnlockPageScript(unlockPage, "#k=WRONG-PASSWORD");
    await waitFor(() => elements.error.textContent !== "");

    assert.equal(state.replacementUrl, "/crm/2026-07-09-100000/?view=summary");
    assert.equal(state.writtenHtml, "");
    assert.equal(
      elements.error.textContent,
      "Incorrect password. Check the Teams message and try again.",
    );
  });

  it("prevents a manual submission while fragment auto-unlock is in progress", async () => {
    const password = "ABCD-EFGH-IJKL";
    const encryptedPayload = encryptDashboardHtml("<main>Dashboard</main>", password, {
      iterations: 1000,
    });
    const unlockPage = renderUnlockPage({ projectName: "crm", encryptedPayload });
    let releaseDerivation;
    const derivationBlocked = new Promise((resolve) => {
      releaseDerivation = resolve;
    });

    const { elements, listeners, state } = await runUnlockPageScript(
      unlockPage,
      `#k=${password}`,
      () => derivationBlocked,
    );
    await waitFor(() => state.deriveKeyStarted);

    elements.password.value = password;
    await listeners.submit({ preventDefault() {} });
    assert.equal(state.deriveKeyCalls, 1);
    assert.equal(elements["unlock-button"].disabled, true);

    releaseDerivation();
    await waitFor(() => state.writtenHtml !== "");
  });

  it("falls back to a clean replacement navigation when history cleanup fails", async () => {
    const encryptedPayload = encryptDashboardHtml("<main>Dashboard</main>", "ABCD-EFGH-IJKL", {
      iterations: 1000,
    });
    const unlockPage = renderUnlockPage({ projectName: "crm", encryptedPayload });

    const { state } = await runUnlockPageScript(
      unlockPage,
      "#k=ABCD-EFGH-IJKL",
      null,
      new Error("history unavailable"),
    );

    assert.equal(state.navigationUrl, "/crm/2026-07-09-100000/?view=summary");
    assert.equal(state.deriveKeyStarted, false);
  });

  it("leaves the manual form idle when no fragment is present", async () => {
    const encryptedPayload = encryptDashboardHtml("<main>Dashboard</main>", "ABCD-EFGH-IJKL", {
      iterations: 1000,
    });
    const unlockPage = renderUnlockPage({ projectName: "crm", encryptedPayload });

    const { elements, state } = await runUnlockPageScript(unlockPage, "");

    assert.equal(state.replacementUrl, null);
    assert.equal(state.deriveKeyStarted, false);
    assert.equal(state.writtenHtml, "");
    assert.equal(elements.error.textContent, "");
  });

  it("uses one unlock path and never reads a password from the query string", () => {
    const encryptedPayload = encryptDashboardHtml("<main>Dashboard</main>", "ABCD-EFGH-IJKL", {
      iterations: 1000,
    });
    const unlockPage = renderUnlockPage({ projectName: "crm", encryptedPayload });
    const script = getUnlockPageScript(unlockPage);

    assert.match(script, /async function tryUnlock\(password\)/);
    assert.match(script, /await tryUnlock\(passwordInput\.value\)/);
    assert.match(script, /void tryUnlock\(fragmentPassword\)/);
    assert.doesNotMatch(script, /URLSearchParams|location\.searchParams|[?&]password=/);
  });
});
