#!/usr/bin/env node

/**
 * Mirror the raw meeting transcript (.vtt) to an external GitHub repository.
 *
 * Tiger downloads the transcript to ephemeral container storage, analyses it,
 * and persists only the generated dashboard (Blob) + analysis (Cosmos). The raw
 * .vtt is otherwise discarded when the container exits. This optional step
 * archives the raw .vtt to a GitHub content repo (e.g. a team's sprint-meetings
 * archive) so the source-of-truth transcript survives the run.
 *
 * Opt-in: does nothing unless MIRROR_REPO is set.
 *
 * Usage:
 *   node mirrorTranscript.js <transcriptPath>
 *
 * Required (when enabled):
 *   MIRROR_REPO          - "owner/repo" to commit into (e.g. tinacms/sprint-meetings)
 *   MIRROR_GITHUB_TOKEN  - token with `contents:write` on MIRROR_REPO
 *
 * Optional:
 *   MIRROR_PROJECT_FILTER - case-insensitive regex; only mirror when it matches the
 *                           meeting subject / project name / slug. Default ".*" (all).
 *   MIRROR_BRANCH         - target branch. Default "main".
 *   MIRROR_PATH_PREFIX    - path prefix inside the repo. Default "recordings/".
 *   MIRROR_PROJECT_SLUG / MIRROR_PROJECT_NAME / MIRROR_MEETING_SUBJECT
 *                         - per-meeting context (passed by entrypoint.sh) used for
 *                           the project filter and commit message.
 *
 * Exit codes: 0 = mirrored or intentionally skipped; 1 = hard error.
 * Callers should treat a non-zero exit as non-fatal (best-effort archival).
 */

const fs = require("fs").promises;
const path = require("path");
const { log } = require("../lib/logger");

const GITHUB_API = "https://api.github.com";

const CONFIG = {
  repo: process.env.MIRROR_REPO,
  token: process.env.MIRROR_GITHUB_TOKEN,
  branch: process.env.MIRROR_BRANCH || "main",
  pathPrefix: process.env.MIRROR_PATH_PREFIX || "recordings/",
  projectFilter: process.env.MIRROR_PROJECT_FILTER || ".*",
  projectSlug: process.env.MIRROR_PROJECT_SLUG || "",
  projectName: process.env.MIRROR_PROJECT_NAME || "",
  meetingSubject: process.env.MIRROR_MEETING_SUBJECT || "",
};

/**
 * Decide whether a meeting should be mirrored. The filter is a case-insensitive
 * regex tested against the subject, project display name, and project slug.
 * Empty / wildcard filter mirrors everything.
 */
function shouldMirror(filterPattern, { meetingSubject, projectName, projectSlug } = {}) {
  if (!filterPattern || filterPattern === ".*" || filterPattern === "*") return true;
  const haystack = [meetingSubject, projectName, projectSlug].filter(Boolean).join(" ");
  try {
    return new RegExp(filterPattern, "i").test(haystack);
  } catch {
    // Invalid regex → fall back to a case-insensitive substring match
    return haystack.toLowerCase().includes(String(filterPattern).toLowerCase());
  }
}

/**
 * Build the repo-relative path to commit to, preserving the transcript's own
 * filename (YYYY-MM-DD-HHmmss.vtt) under the configured prefix.
 */
function buildCommitPath(pathPrefix, filename) {
  const prefix =
    pathPrefix === "" || pathPrefix.endsWith("/") ? pathPrefix : `${pathPrefix}/`;
  return `${prefix}${filename}`;
}

function isValidRepo(repo) {
  return typeof repo === "string" && /^[^/\s]+\/[^/\s]+$/.test(repo);
}

/** Percent-encode each path segment while preserving the slashes between them. */
function encodePath(p) {
  return p.split("/").map(encodeURIComponent).join("/");
}

function buildCommitMessage({ projectName, projectSlug, filename }) {
  const label = projectName || projectSlug || "meeting";
  return `Add transcript: ${label} (${filename})`;
}

async function githubRequest(method, url, token, body) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "SSW.Tiger-transcript-mirror",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const opts = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  return fetch(url, opts);
}

/** Return the blob SHA of an existing file (required to update it), or null. */
async function getExistingSha(repo, commitPath, branch, token) {
  const url = `${GITHUB_API}/repos/${repo}/contents/${encodePath(commitPath)}?ref=${encodeURIComponent(branch)}`;
  const res = await githubRequest("GET", url, token);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GitHub GET contents failed: ${res.status} - ${await res.text()}`);
  }
  const data = await res.json();
  return data.sha || null;
}

async function commitTranscript({ repo, commitPath, branch, token, contentBase64, message, sha }) {
  const url = `${GITHUB_API}/repos/${repo}/contents/${encodePath(commitPath)}`;
  const body = { message, content: contentBase64, branch };
  if (sha) body.sha = sha;
  const res = await githubRequest("PUT", url, token, body);
  if (!res.ok) {
    throw new Error(`GitHub PUT contents failed: ${res.status} - ${await res.text()}`);
  }
  return res.json();
}

async function main() {
  const transcriptPath = process.argv[2];

  // Opt-in: silently no-op unless a mirror target is configured.
  if (!CONFIG.repo) {
    log("debug", "Transcript mirror disabled (MIRROR_REPO unset)");
    process.exit(0);
  }

  if (!isValidRepo(CONFIG.repo)) {
    log("error", "Invalid MIRROR_REPO (expected 'owner/repo')", { repo: CONFIG.repo });
    process.exit(1);
  }
  if (!CONFIG.token) {
    log("error", "MIRROR_GITHUB_TOKEN is required when MIRROR_REPO is set");
    process.exit(1);
  }
  if (!transcriptPath) {
    log("error", "No transcript path provided (argv[2])");
    process.exit(1);
  }

  // Project filter: e.g. only mirror one team's meetings into their repo.
  if (
    !shouldMirror(CONFIG.projectFilter, {
      meetingSubject: CONFIG.meetingSubject,
      projectName: CONFIG.projectName,
      projectSlug: CONFIG.projectSlug,
    })
  ) {
    log("info", "Transcript mirror skipped (project filter no match)", {
      filter: CONFIG.projectFilter,
      project: CONFIG.projectName || CONFIG.projectSlug,
    });
    process.exit(0);
  }

  let buf;
  try {
    buf = await fs.readFile(transcriptPath);
  } catch (err) {
    log("error", "Failed to read transcript for mirroring", {
      transcriptPath,
      error: err.message,
    });
    process.exit(1);
  }

  const filename = path.basename(transcriptPath);
  const commitPath = buildCommitPath(CONFIG.pathPrefix, filename);
  const message = buildCommitMessage({
    projectName: CONFIG.projectName,
    projectSlug: CONFIG.projectSlug,
    filename,
  });

  try {
    // GET existing SHA first so a re-run (e.g. the dashboard restart button)
    // updates the file in place instead of failing on "already exists".
    const sha = await getExistingSha(CONFIG.repo, commitPath, CONFIG.branch, CONFIG.token);
    const result = await commitTranscript({
      repo: CONFIG.repo,
      commitPath,
      branch: CONFIG.branch,
      token: CONFIG.token,
      contentBase64: buf.toString("base64"),
      message,
      sha,
    });
    log("info", "Mirrored transcript to GitHub", {
      repo: CONFIG.repo,
      path: commitPath,
      branch: CONFIG.branch,
      updated: Boolean(sha),
      commit: result.commit && result.commit.sha,
    });
    process.exit(0);
  } catch (err) {
    log("error", "Transcript mirror failed", {
      repo: CONFIG.repo,
      path: commitPath,
      error: err.message,
    });
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  shouldMirror,
  buildCommitPath,
  isValidRepo,
  encodePath,
  buildCommitMessage,
};
