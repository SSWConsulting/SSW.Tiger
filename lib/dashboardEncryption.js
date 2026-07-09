const crypto = require("crypto");

const DEFAULT_ITERATIONS = 250000;

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function generateDashboardPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(12);
  let value = "";
  for (const byte of bytes) {
    value += alphabet[byte % alphabet.length];
  }
  return value.match(/.{1,4}/g).join("-");
}

function encryptDashboardHtml(html, password, options = {}) {
  const iterations = options.iterations || DEFAULT_ITERATIONS;
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(html), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA256",
    iterations,
    salt: base64Url(salt),
    iv: base64Url(iv),
    ciphertext: base64Url(Buffer.concat([ciphertext, tag])),
  };
}

function decryptDashboardPayload(encryptedPayload, password) {
  const salt = fromBase64Url(encryptedPayload.salt);
  const iv = fromBase64Url(encryptedPayload.iv);
  const combined = fromBase64Url(encryptedPayload.ciphertext);
  const key = crypto.pbkdf2Sync(
    password,
    salt,
    encryptedPayload.iterations || DEFAULT_ITERATIONS,
    32,
    "sha256",
  );
  const tag = combined.subarray(combined.length - 16);
  const ciphertext = combined.subarray(0, combined.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

function extractEncryptedPayloadFromUnlockPage(html) {
  const match = String(html).match(/const encryptedDashboard = (\{.*?\});\s*const form =/s);
  if (!match) return null;
  return JSON.parse(match[1]);
}

function renderUnlockPage({ projectName, meetingId, encryptedPayload }) {
  const payloadJson = JSON.stringify(encryptedPayload);
  const escapedProject = escapeHtml(projectName);
  const escapedMeeting = escapeHtml(meetingId);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapedProject} - Protected Dashboard</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #f4f4f5;
      color: #333;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(420px, calc(100vw - 32px));
      background: #fff;
      border: 1px solid #e4e4e7;
      border-radius: 8px;
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.08);
      padding: 28px;
    }
    .mark { display: flex; gap: 3px; margin-bottom: 18px; }
    .mark span { width: 12px; height: 12px; display: block; }
    h1 { margin: 0; font-size: 24px; line-height: 1.2; }
    p { color: #666; line-height: 1.5; }
    label { display: block; margin: 20px 0 8px; font-weight: 600; }
    input {
      box-sizing: border-box;
      width: 100%;
      border: 1px solid #d4d4d8;
      border-radius: 6px;
      font: inherit;
      padding: 12px;
    }
    button {
      width: 100%;
      border: 0;
      border-radius: 6px;
      margin-top: 14px;
      padding: 12px 16px;
      background: #cc4141;
      color: #fff;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    button:disabled { opacity: 0.65; cursor: wait; }
    .error { min-height: 20px; margin-top: 12px; color: #a33434; font-size: 14px; }
    .meta { margin-top: 8px; font-size: 13px; color: #888; }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">
      <span style="background:#cc4141"></span>
      <span style="background:#333"></span>
      <span style="background:#a1a1aa"></span>
      <span style="background:#e97d7d"></span>
    </div>
    <h1>Protected dashboard</h1>
    <p>This meeting dashboard is password protected. Enter the password from the Teams notification to unlock it.</p>
    <form id="unlock-form">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
      <button id="unlock-button" type="submit">Unlock dashboard</button>
      <div id="error" class="error" role="alert"></div>
    </form>
    <div class="meta">${escapedProject} / ${escapedMeeting}</div>
  </main>
  <script>
    const encryptedDashboard = ${payloadJson};
    const form = document.getElementById("unlock-form");
    const passwordInput = document.getElementById("password");
    const button = document.getElementById("unlock-button");
    const error = document.getElementById("error");

    function fromBase64Url(value) {
      const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
      const binary = atob(padded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }

    async function deriveKey(password, salt, iterations) {
      const encodedPassword = new TextEncoder().encode(password);
      const keyMaterial = await crypto.subtle.importKey("raw", encodedPassword, "PBKDF2", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"]
      );
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      button.disabled = true;
      button.textContent = "Unlocking...";
      try {
        const salt = fromBase64Url(encryptedDashboard.salt);
        const iv = fromBase64Url(encryptedDashboard.iv);
        const ciphertext = fromBase64Url(encryptedDashboard.ciphertext);
        const key = await deriveKey(passwordInput.value, salt, encryptedDashboard.iterations);
        const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
        const html = new TextDecoder().decode(decrypted);
        document.open();
        document.write(html);
        document.close();
      } catch {
        error.textContent = "Incorrect password. Check the Teams message and try again.";
      } finally {
        button.disabled = false;
        button.textContent = "Unlock dashboard";
      }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fromBase64Url(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64");
}

module.exports = {
  generateDashboardPassword,
  encryptDashboardHtml,
  decryptDashboardPayload,
  extractEncryptedPayloadFromUnlockPage,
  renderUnlockPage,
};
