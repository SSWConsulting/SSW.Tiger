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
    // Publish runs in-line before analysis; cap how long a hung call can stall it
    signal: AbortSignal.timeout(30_000),
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

/** The hub's apps.json opt-in map, per #134: { "<slug>": { displayName, publish } }. */
async function fetchHubProjects(repo, token) {
  const { status, json } = await githubRequest({
    method: "GET",
    path: `/repos/${repo}/contents/apps.json`,
    token,
  });

  if (status !== 200 || !json?.content) {
    throw new Error(`Failed to fetch hub allowlist (apps.json): ${status}`);
  }

  const parsed = JSON.parse(
    Buffer.from(json.content, "base64").toString("utf-8"),
  );
  const projects = parsed.projects;

  if (!projects || typeof projects !== "object" || Array.isArray(projects)) {
    throw new Error(
      "Hub apps.json is malformed: expected a 'projects' object, " +
        `found top-level keys [${Object.keys(parsed).join(", ")}]`,
    );
  }

  return projects;
}

// Failure-shaped outcome: index.js logs these at error level, unlike benign skips
function failure(reason, detail) {
  return { published: false, failed: true, reason, detail };
}

/**
 * Publish one transcript to the hub. `failed: true` marks failure-shaped
 * outcomes (config/credential problems) vs benign skips like "not-allowlisted".
 * @returns {{published: boolean, failed?: boolean, reason?: string, detail?: string, path?: string}}
 */
async function publishTranscript({ transcriptPath, projectSlug, meetingId }) {
  const config = getHubConfig();
  if (!config.repo) {
    return { published: false, reason: "disabled" }; // opt-in: no-op unless configured
  }

  // Local guard for the URL path; callers pass sanitizeId() output, which always matches
  if (!/^[a-z0-9-]+$/.test(projectSlug)) {
    throw new Error(`Refusing to publish: invalid project slug "${projectSlug}"`);
  }

  const hasCredentials =
    config.token ||
    (config.appId && config.appPrivateKey && config.appInstallationId);
  if (!hasCredentials) {
    return failure(
      "no-credentials",
      "TRANSCRIPT_HUB_REPO is set but neither TRANSCRIPT_HUB_TOKEN nor the TRANSCRIPT_HUB_APP_* trio is",
    );
  }

  const token = await resolveToken(config);

  // The .vtt is verbatim speech: refuse to publish anywhere public (a #134
  // approval condition). Fails closed if the hub is ever flipped public.
  const repoMeta = await githubRequest({
    method: "GET",
    path: `/repos/${config.repo}`,
    token,
  });
  if (repoMeta.status !== 200) {
    return failure(
      "hub-unreachable",
      `GET /repos/${config.repo} returned ${repoMeta.status} - check the repo name and the App installation`,
    );
  }
  if (repoMeta.json?.private !== true) {
    return failure(
      "hub-not-private",
      `${config.repo} is not private; transcripts must never land in a public repo`,
    );
  }

  let projects;
  try {
    projects = await fetchHubProjects(config.repo, token);
  } catch (err) {
    return failure("allowlist-invalid", err.message);
  }

  if (projects[projectSlug]?.publish !== true) {
    log("info", "Project not opted in to the transcript hub, skipping publish", {
      projectSlug,
      repo: config.repo,
    });
    return { published: false, reason: "not-allowlisted" };
  }

  const content = await fs.readFile(transcriptPath);
  const hubPath = `transcripts/${projectSlug}/${meetingId}.vtt`;

  // Concurrent jobs PUTting to the same branch can 409 on the ref update even
  // for different paths, so on conflict re-read the sha and retry once.
  for (let attempt = 0; ; attempt++) {
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

    if (status === 200 || status === 201) {
      return { published: true, path: hubPath };
    }
    if (status === 409 && attempt === 0) {
      log("warn", "Hub publish hit a ref-update conflict, retrying once", { hubPath });
      continue;
    }
    throw new Error(
      `Failed to publish transcript to hub: ${status} - ${JSON.stringify(json)}`,
    );
  }
}

module.exports = {
  publishTranscript,
  fetchHubProjects,
  getInstallationToken,
  mintAppJwt,
  gitBlobSha,
  getHubConfig,
};
