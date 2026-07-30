const fs = require("fs").promises;
const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");
const { log, truncate } = require("../lib/logger");

// Configuration
const CONFIG = {
  claudeCommand: process.env.CLAUDE_CLI || "claude",
  model: process.env.CLAUDE_MODEL || "claude-opus-4-5-20251101",
  claudeApiKey: process.env.ANTHROPIC_API_KEY,
  claudeOAuthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  // The CLI defaults to 32000 output tokens per assistant turn, which a full
  // dashboard write can exceed in one Write call (see GitHub issue #149).
  maxOutputTokens: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || "64000",
};

function validateCredentials() {
  if (
    process.env.NODE_ENV === "production" &&
    !CONFIG.claudeOAuthToken &&
    !CONFIG.claudeApiKey
  ) {
    throw new Error(
      "No Claude credentials found in production.\n" +
        "Set one of the following environment variables:\n" +
        "  CLAUDE_CODE_OAUTH_TOKEN=<your-token>\n" +
        "  ANTHROPIC_API_KEY=<your-api-key>",
    );
  }

  if (!CONFIG.claudeOAuthToken && !CONFIG.claudeApiKey) {
    log("warn", "No Claude credentials - using CLI logged-in session");
  }

  if (!process.env.DASHBOARD_STORAGE_ACCOUNT) {
    throw new Error(
      "Dashboard storage account is required for deployment.\n" +
        "Set the DASHBOARD_STORAGE_ACCOUNT environment variable to the Azure Storage account name.",
    );
  }
}

function getClaudeAuthMethod() {
  if (CONFIG.claudeOAuthToken) {
    return {
      useOAuth: true,
      env: { CLAUDE_CODE_OAUTH_TOKEN: CONFIG.claudeOAuthToken },
    };
  } else if (CONFIG.claudeApiKey) {
    return {
      useOAuth: false,
      env: { ANTHROPIC_API_KEY: CONFIG.claudeApiKey },
    };
  } else {
    return { useOAuth: false, env: {} };
  }
}

// Recognizable, actionable failure causes. The Claude CLI reports these on
// stdout (as stream-json events) rather than stderr and still exits 1, so
// without this the close handler can only report "exit 1, stderr empty".
const FAILURE_PATTERNS = [
  {
    reason: "output_token_limit",
    pattern: /output token maximum|CLAUDE_CODE_MAX_OUTPUT_TOKENS/i,
    hint:
      "A single assistant turn exceeded the output token limit - most likely " +
      "the whole dashboard HTML was written in one call. Raise " +
      "CLAUDE_CODE_MAX_OUTPUT_TOKENS, or have the dashboard built by copying " +
      "the template and replacing placeholders incrementally.",
  },
];

// A genuinely transient API retry (429, overloaded, connection blip) resolves
// in seconds. A retry that arrives MINUTES after the previous event means the
// attempt itself ran to completion and was then rejected - e.g. one oversized
// write hitting the output token limit. Retrying that just burns another full
// generation, so fail fast instead of stalling until the container is killed.
// (~5 min per cycle is roughly how long generating 32000 output tokens takes,
// which is what the stall in GitHub issue #149 looked like.)
const STALL_RETRY_COUNT = 2;
const STALL_ELAPSED_MS = 8 * 60 * 1000;
const STALL_RETRY_COUNT_HARD = 3;

function isStalled({ consecutiveRetries, stalledMs }) {
  if (consecutiveRetries >= STALL_RETRY_COUNT_HARD) return true;
  return consecutiveRetries >= STALL_RETRY_COUNT && stalledMs >= STALL_ELAPSED_MS;
}

function detectFailureReason(line) {
  const match = FAILURE_PATTERNS.find((entry) => entry.pattern.test(line));
  return match ? { reason: match.reason, hint: match.hint } : null;
}

/**
 * Work out how far the pipeline got, so a failure names the stage it died in.
 * Derived from which analysis artefacts exist rather than from log scraping.
 */
async function detectStage(meetingPath) {
  if (!meetingPath) return "unknown";

  const analysisDir = path.join(meetingPath, "analysis");

  let files;
  try {
    files = await fs.readdir(analysisDir);
  } catch (error) {
    return "analysis";
  }

  const jsonFiles = files.filter((name) => name.endsWith(".json"));
  if (jsonFiles.length === 0) return "analysis";

  if (!jsonFiles.includes("consolidated.json")) {
    return `analysis (${jsonFiles.length} of 5 agents done)`;
  }

  const dashboardExists = await fs
    .access(path.join(meetingPath, "dashboard", "index.html"))
    .then(() => true)
    .catch(() => false);

  return dashboardExists ? "dashboard-generation (partial output written)" : "dashboard-generation";
}

/**
 * True when the analysis phase is already complete on disk, so a retry can
 * skip straight to dashboard generation instead of re-running all 5 agents.
 */
async function hasConsolidatedAnalysis(meetingPath) {
  return fs
    .access(path.join(meetingPath, "analysis", "consolidated.json"))
    .then(() => true)
    .catch(() => false);
}

function parseStreamJsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return { ok: false };

  try {
    const event = JSON.parse(trimmed);
    return { ok: true, event };
  } catch (error) {
    return { ok: false };
  }
}

function isApiRetryEvent(event) {
  return event?.type === "system" && event.subtype === "api_retry";
}

/**
 * Everything the CLI told us about a retry, minus the noise. Previously only
 * the `subtype` was logged, which discarded the underlying cause and made the
 * stall in GitHub issue #149 impossible to diagnose from logs.
 */
function extractRetryDetail(event) {
  const detail = {};
  const interesting = [
    "attempt",
    "attempts",
    "retry_count",
    "delay_ms",
    "delayMs",
    "status",
    "status_code",
    "error",
    "error_type",
    "message",
    "reason",
  ];

  for (const key of interesting) {
    const value = event[key];
    if (value === undefined || value === null) continue;
    detail[key] =
      typeof value === "object" ? truncate(JSON.stringify(value), 300) : value;
  }

  // Anything unexpected still gets surfaced rather than silently dropped
  const known = new Set([...interesting, "type", "subtype", "session_id", "uuid"]);
  const extraKeys = Object.keys(event).filter((key) => !known.has(key));
  if (extraKeys.length > 0) {
    detail.otherFields = truncate(JSON.stringify(pick(event, extraKeys)), 300);
  }

  return detail;
}

function pick(source, keys) {
  return keys.reduce((acc, key) => {
    acc[key] = source[key];
    return acc;
  }, {});
}

function shouldSkipEvent(event) {
  if (!event) return true;

  if (event.type === "tool_use" || event.type === "tool_result") return true;

  const content = event.message?.content;
  if (Array.isArray(content)) {
    const hasToolContent = content.some(
      (block) =>
        block.type === "tool_use" ||
        block.type === "tool_result" ||
        block.tool_use_id,
    );
    if (hasToolContent) return true;
  }

  return false;
}

function extractEventPreview(event) {
  if (!event) return "";

  if (event.type === "system" && event.subtype) {
    if (event.subtype === "init") {
      const sessionId = event.session_id?.substring(0, 8) || "unknown";
      return `Session initialized (${sessionId})`;
    }
    return event.subtype;
  }

  const messageObj = event.message || event;
  const content = messageObj.content;

  if (typeof content === "string") {
    return truncate(content.split("\n")[0].trim());
  }

  if (Array.isArray(content) && content.length > 0) {
    const firstBlock = content[0];
    if (firstBlock?.type === "text" && firstBlock.text) {
      return truncate(firstBlock.text.split("\n")[0].trim());
    }
  }

  if (typeof messageObj.text === "string" && messageObj.text.trim()) {
    return truncate(messageObj.text.split("\n")[0].trim());
  }

  if (typeof messageObj.message === "string" && messageObj.message.trim()) {
    return truncate(messageObj.message.split("\n")[0].trim());
  }

  return "";
}

/**
 * Invoke Claude Code CLI to process a transcript.
 *
 * @param {Object} params
 * @param {string} params.projectName
 * @param {string} params.meetingId
 * @param {string} params.meetingDate
 * @param {string} params.meetingPath - absolute path to meeting folder
 * @param {string} params.outputDir - absolute path to output directory
 * @param {string} params.rootDir - absolute path to project root (for templates, CLAUDE.md)
 * @param {boolean} [params.resumeDashboardOnly] - skip analysis, rebuild the
 *   dashboard from the existing consolidated.json (used by the retry path)
 */
async function invokeClaude({ projectName, projectSlug, meetingId, meetingDate, meetingPath, outputDir, rootDir, resumeDashboardOnly = false }) {
  await fs.mkdir(outputDir, { recursive: true });

  const authConfig = getClaudeAuthMethod();

  const context = `Project: ${projectName}
Meeting ID: ${meetingId}
Meeting Date: ${meetingDate}
Meeting folder: projects/${projectSlug}/${meetingId}/
Transcript: projects/${projectSlug}/${meetingId}/transcript.vtt
Attendees (meeting invite list - use as suggestion for name resolution): projects/${projectSlug}/${meetingId}/attendees.json
Dashboard template: templates/dashboard.html`;

  // Repeated in both prompts: deployment belongs to deployer.js (so that the
  // password protection and Cosmos record are not bypassed), and the path is
  // what checkOutputExists looks for.
  const outputInstructions = `Do NOT deploy or upload the dashboard.
Generate the dashboard HTML to: projects/${projectSlug}/${meetingId}/dashboard/index.html`;

  const sections = resumeDashboardOnly
    ? [
        "Read CLAUDE.md, then generate ONLY the dashboard for this meeting.",
        `${context}
Consolidated analysis (ALREADY COMPLETE - use this): projects/${projectSlug}/${meetingId}/analysis/consolidated.json`,
        "Start at step 4 (Generate Dashboard) of the CLAUDE.md workflow. Do NOT re-run any analysis agent and do NOT re-run consolidation.",
        outputInstructions,
      ]
    : [
        "Read CLAUDE.md and process the meeting transcript following the complete workflow.",
        context,
        `Follow all steps in CLAUDE.md EXCEPT deployment. ${outputInstructions}`,
      ];

  const prompt = sections.join("\n\n");

  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--verbose",
      "--model",
      CONFIG.model,
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--allowedTools",
      "read_file,create_file,replace_string_in_file,list_dir,grep_search,run_in_terminal",
      "--add-dir",
      rootDir,
      "--add-dir",
      outputDir,
      "--add-dir",
      meetingPath,
      "--add-dir",
      path.join(rootDir, "templates"),
    ];

    let command = CONFIG.claudeCommand;
    let spawnArgs = args;
    let spawnOptions = {
      cwd: rootDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CLAUDE_WORKSPACE_TRUST: "true",
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: CONFIG.maxOutputTokens,
        ...authConfig.env,
      },
    };

    if (process.platform === "win32") {
      spawnOptions.shell = "powershell.exe";
      const escapedArgs = spawnArgs.map((arg) =>
        arg.includes(" ") ? `"${arg}"` : arg,
      );
      command = `${CONFIG.claudeCommand} ${escapedArgs.join(" ")}`;
      spawnArgs = [];
    }

    const claude = spawn(command, spawnArgs, spawnOptions);

    claude.stdin.write(prompt);
    claude.stdin.end();
    // The effective limits are logged on every run so a successful run also
    // proves what they were - previously the only evidence that
    // CLAUDE_CODE_MAX_OUTPUT_TOKENS had reached the CLI was a failure message
    // quoting the ceiling it hit.
    log("info", "Processing transcript with Claude CLI...", {
      meetingId,
      model: CONFIG.model,
      maxOutputTokens: CONFIG.maxOutputTokens,
      resumeDashboardOnly,
    });

    let stderr = "";
    let firstOutputReceived = false;
    let lastOutputTime = Date.now();
    let lastLoggedMessage = "";
    let failure = null;
    let consecutiveRetries = 0;
    let stallStartedAt = null;
    let stallTerminated = false;
    const startTime = Date.now();

    const INACTIVITY_TIMEOUT = 1200000;
    const inactivityTimer = setInterval(() => {
      const timeSinceLastOutput = Date.now() - lastOutputTime;
      if (timeSinceLastOutput > INACTIVITY_TIMEOUT) {
        clearInterval(inactivityTimer);
        claude.kill();
        reject(new Error("Claude CLI timeout: no output for 20 minutes"));
      }
    }, 30000);

    const stdoutReader = readline.createInterface({
      input: claude.stdout,
      crlfDelay: Infinity,
    });

    stdoutReader.on("line", (line) => {
      lastOutputTime = Date.now();
      firstOutputReceived = true;

      if (!line || !line.trim()) return;

      // Check the raw line before parsing - API errors are reported through
      // stdout and must be caught regardless of which event shape carries them.
      if (!failure) {
        failure = detectFailureReason(line);
      }

      try {
        const parsed = parseStreamJsonLine(line);
        if (!parsed.ok) return;

        // Stall tracking runs before the skip filter, because tool events are
        // filtered out of the logs but still count as real progress.
        if (isApiRetryEvent(parsed.event)) {
          consecutiveRetries += 1;
          if (stallStartedAt === null) stallStartedAt = Date.now();
          const stalledMs = Date.now() - stallStartedAt;

          log("warn", "Claude CLI is retrying an API request", {
            meetingId,
            consecutiveRetries,
            stalledSeconds: Math.round(stalledMs / 1000),
            ...extractRetryDetail(parsed.event),
          });

          if (!stallTerminated && isStalled({ consecutiveRetries, stalledMs })) {
            stallTerminated = true;
            failure = {
              reason: "api_retry_stall",
              hint:
                `Gave up after ${consecutiveRetries} consecutive API retries with no ` +
                "progress in between. Retries this slow mean each attempt ran to " +
                "completion before being rejected (most likely an oversized single " +
                "write hitting the output token limit), so further retries would " +
                "only burn another full generation.",
            };
            log("error", "Claude CLI stalled on API retries, terminating early", {
              meetingId,
              consecutiveRetries,
              stalledSeconds: Math.round(stalledMs / 1000),
            });
            clearInterval(inactivityTimer);
            claude.kill();
          }
          return;
        }

        consecutiveRetries = 0;
        stallStartedAt = null;

        if (shouldSkipEvent(parsed.event)) return;

        const preview = extractEventPreview(parsed.event);
        if (preview) {
          lastLoggedMessage = preview;
          log("info", preview);
        }
      } catch (parseError) {
        // Ignore parse errors for non-JSON lines
      }
    });

    claude.stderr.on("data", (data) => {
      lastOutputTime = Date.now();
      firstOutputReceived = true;
      stderr += data.toString();
    });

    claude.on("close", async (code, signal) => {
      clearInterval(inactivityTimer);

      if (code === 0) {
        resolve({ stderr });
      } else {
        const runtimeSeconds = Math.round((Date.now() - startTime) / 1000);
        const memUsage = process.memoryUsage();
        const diagnostics = {
          projectName,
          meetingId,
          stage: await detectStage(meetingPath),
          failureReason: failure?.reason || "unknown",
          ...(failure?.hint && { hint: failure.hint }),
          resumeDashboardOnly,
          runtimeSeconds,
          firstOutputReceived,
          lastLoggedMessage: lastLoggedMessage || "(none)",
          memoryMB: Math.round(memUsage.rss / 1024 / 1024),
          stderrPreview: stderr.substring(0, 300) || "(empty)",
        };

        let message;
        if (code === null && signal) {
          // A signal is normally external (container timeout, cancellation) -
          // unless we killed the process ourselves, in which case `failure`
          // already holds the real reason and the signal is incidental.
          const signalHints = {
            SIGKILL:
              "Process was forcefully killed (likely out of memory - consider increasing container memory limit)",
            SIGTERM:
              "Process was terminated (likely container timeout or user cancellation)",
            SIGINT: "Process was interrupted",
          };
          const hint =
            failure?.hint ||
            signalHints[signal] ||
            `Process received signal ${signal}`;
          message = `Claude CLI killed by ${signal}: ${hint}`;
          log("error", `Claude CLI killed by ${signal}`, { ...diagnostics, hint });
        } else {
          const detail = failure
            ? `${failure.reason} at stage ${diagnostics.stage}`
            : stderr.substring(0, 200) || lastLoggedMessage || "(no detail)";
          message = `Claude CLI failed (exit ${code}): ${detail}`;
          log("error", `Claude CLI failed (exit ${code})`, diagnostics);
        }

        const error = new Error(message);
        // Consumed by the retry decision in processor/index.js
        error.failureReason = failure?.reason || "unknown";
        error.stage = diagnostics.stage;
        reject(error);
      }
    });

    claude.on("error", (err) => {
      clearInterval(inactivityTimer);
      reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
    });
  });
}

module.exports = {
  validateCredentials,
  invokeClaude,
  hasConsolidatedAnalysis,
  // Exported for testing
  detectFailureReason,
  detectStage,
  isApiRetryEvent,
  extractRetryDetail,
  isStalled,
};
