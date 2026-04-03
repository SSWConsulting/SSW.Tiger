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
 */
async function invokeClaude({ projectName, meetingId, meetingDate, meetingPath, outputDir, rootDir }) {
  await fs.mkdir(outputDir, { recursive: true });

  const authConfig = getClaudeAuthMethod();

  const prompt = `Read CLAUDE.md and process the meeting transcript following the complete workflow.

Project: ${projectName}
Meeting ID: ${meetingId}
Meeting Date: ${meetingDate}
Meeting folder: projects/${projectName}/${meetingId}/
Transcript: projects/${projectName}/${meetingId}/transcript.vtt
Attendees (meeting invite list - use as suggestion for name resolution): projects/${projectName}/${meetingId}/attendees.json
Dashboard template: templates/dashboard.html

Follow all steps in CLAUDE.md EXCEPT deployment. Do NOT deploy or upload the dashboard.
Generate the dashboard HTML to: projects/${projectName}/${meetingId}/dashboard/index.html`;

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
    log("info", "Processing transcript with Claude CLI...");

    let stderr = "";
    let firstOutputReceived = false;
    let lastOutputTime = Date.now();
    let lastLoggedMessage = "";
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

      try {
        const parsed = parseStreamJsonLine(line);
        if (!parsed.ok) return;

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
          runtimeSeconds,
          firstOutputReceived,
          lastLoggedMessage: lastLoggedMessage || "(none)",
          memoryMB: Math.round(memUsage.rss / 1024 / 1024),
          stderrPreview: stderr.substring(0, 300) || "(empty)",
        };

        if (code === null && signal) {
          const signalHints = {
            SIGKILL:
              "Process was forcefully killed (likely out of memory - consider increasing container memory limit)",
            SIGTERM:
              "Process was terminated (likely container timeout or user cancellation)",
            SIGINT: "Process was interrupted",
          };
          const hint =
            signalHints[signal] || `Process received signal ${signal}`;
          log("error", `Claude CLI killed by ${signal}`, {
            hint,
            ...diagnostics,
          });
          reject(new Error(`Claude CLI killed by ${signal}: ${hint}`));
        } else {
          log("error", `Claude CLI failed (exit ${code})`, diagnostics);
          reject(
            new Error(
              `Claude CLI failed (exit ${code}): ${stderr.substring(0, 200)}`,
            ),
          );
        }
      }
    });

    claude.on("error", (err) => {
      clearInterval(inactivityTimer);
      reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
    });
  });
}

module.exports = { validateCredentials, invokeClaude };
