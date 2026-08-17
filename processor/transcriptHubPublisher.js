/**
 * Publishes the raw .vtt (otherwise discarded on container exit) to the hub
 * repo at transcripts/{slug}/{meetingId}.vtt for slugs opted in via the hub's
 * apps.json - design in SSWConsulting/SSW.Tiger#134. Opt-in via
 * TRANSCRIPT_HUB_REPO; auth = TRANSCRIPT_HUB_TOKEN or the TRANSCRIPT_HUB_APP_*
 * trio. Best-effort: callers treat every failure as non-fatal.
 */

const fs = require("fs").promises;
const crypto = require("crypto");
const { log } = require("../lib/logger");

const GITHUB_API = "https://api.github.com";

function getHubConfig() {
  return {
    repo: process.env.TRANSCRIPT_HUB_REPO,
    token: process.env.TRANSCRIPT_HUB_TOKEN,
    appId: process.env.TRANSCRIPT_HUB_APP_ID,
    // Key vaults / env files often store the PEM with literal \n escapes
    appPrivateKey: (process.env.TRANSCRIPT_HUB_APP_PRIVATE_KEY || "").replace(
      /\\n/g,
      "\n",
    ),
    appInstallationId: process.env.TRANSCRIPT_HUB_APP_INSTALLATION_ID,
  };
}

/**
 * Git blob SHA of the content ("blob {len}\0{bytes}", SHA-1). Matches the
 * `sha` the Contents API reports, so we can skip no-op re-publishes.
 */
function gitBlobSha(buffer) {
  return crypto
    .createHash("sha1")
    .update(`blob ${buffer.length}\0`)
    .update(buffer)
    .digest("hex");
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

/** Short-lived RS256 JWT that authenticates as the GitHub App itself. */
function mintAppJwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat backdated 60s to absorb clock drift; App JWTs max out at 10 minutes
  const payload = base64UrlEncode(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
  );
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(privateKey, "base64url");
  return `${header}.${payload}.${signature}`;
}

async function githubRequest({ method, path, token, body, tokenType = "Bearer" }) {
  const response = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `${tokenType} ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ssw-tiger-transcript-publisher",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let json = null;
  try {
    json = await response.json();
  } catch {
    // Some responses (e.g. 204) have no body
  }

  return { status: response.status, json };
}

/** Exchange App credentials for a short-lived installation access token. */
async function getInstallationToken({ appId, appPrivateKey, appInstallationId }) {
  const jwt = mintAppJwt(appId, appPrivateKey);
  const { status, json } = await githubRequest({
    method: "POST",
    path: `/app/installations/${appInstallationId}/access_tokens`,
    token: jwt,
  });

  if (status !== 201 || !json?.token) {
    throw new Error(
      `Failed to mint hub installation token: ${status} - ${JSON.stringify(json)}`,
    );
  }

  return json.token;
}

async function resolveToken(config) {
  if (config.token) return config.token;

  if (config.appId && config.appPrivateKey && config.appInstallationId) {
    return await getInstallationToken(config);
  }

  throw new Error(
    "TRANSCRIPT_HUB_REPO is set but no credentials found. Set TRANSCRIPT_HUB_TOKEN " +
      "or TRANSCRIPT_HUB_APP_ID + TRANSCRIPT_HUB_APP_PRIVATE_KEY + TRANSCRIPT_HUB_APP_INSTALLATION_ID.",
  );
}

/** Slugs opted in via the hub repo's apps.json. */
async function fetchAllowlistSlugs(repo, token) {
  const { status, json } = await githubRequest({
    method: "GET",
    path: `/repos/${repo}/contents/apps.json`,
    token,
  });

  if (status !== 200 || !json?.content) {
    throw new Error(`Failed to fetch hub allowlist (apps.json): ${status}`);
  }

  const apps = JSON.parse(
    Buffer.from(json.content, "base64").toString("utf-8"),
  ).apps;

  if (!Array.isArray(apps)) {
    throw new Error("Hub apps.json is malformed: expected an 'apps' array");
  }

  return apps.map((app) => (typeof app === "string" ? app : app.slug));
}

/**
 * Publish one transcript to the hub.
 * @returns {{published: boolean, reason?: string, path?: string}}
 */
async function publishTranscript({ transcriptPath, projectSlug, meetingId }) {
  const config = getHubConfig();
  if (!config.repo) {
    return { published: false, reason: "disabled" }; // opt-in: no-op unless configured
  }

  const token = await resolveToken(config);

  const allowlist = await fetchAllowlistSlugs(config.repo, token);
  if (!allowlist.includes(projectSlug)) {
    log("info", "Project not in transcript hub allowlist, skipping publish", {
      projectSlug,
      repo: config.repo,
    });
    return { published: false, reason: "not-allowlisted" };
  }

  const content = await fs.readFile(transcriptPath);
  const hubPath = `transcripts/${projectSlug}/${meetingId}.vtt`;

  // Idempotency: replays (e.g. manual re-triggers) skip when bytes match,
  // and update in place (needs the existing sha) when they differ.
  const existing = await githubRequest({
    method: "GET",
    path: `/repos/${config.repo}/contents/${hubPath}`,
    token,
  });

  if (existing.status === 200 && existing.json?.sha === gitBlobSha(content)) {
    return { published: false, reason: "unchanged", path: hubPath };
  }
  if (existing.status !== 200 && existing.status !== 404) {
    throw new Error(`Failed to check existing hub transcript: ${existing.status}`);
  }

  const { status, json } = await githubRequest({
    method: "PUT",
    path: `/repos/${config.repo}/contents/${hubPath}`,
    token,
    body: {
      message: `Add ${projectSlug} transcript ${meetingId}`,
      content: content.toString("base64"),
      ...(existing.status === 200 ? { sha: existing.json.sha } : {}),
    },
  });

  if (status !== 200 && status !== 201) {
    throw new Error(
      `Failed to publish transcript to hub: ${status} - ${JSON.stringify(json)}`,
    );
  }

  return { published: true, path: hubPath };
}

module.exports = {
  publishTranscript,
  fetchAllowlistSlugs,
  getInstallationToken,
  mintAppJwt,
  gitBlobSha,
  getHubConfig,
};
