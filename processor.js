#!/usr/bin/env node

/**
 * Meeting Transcript Processor - Claude Code CLI Wrapper
 * Invokes Claude Code CLI to process meeting transcripts
 *
 * Usage:
 *   node processor.js <transcript-file-path> <project-name>
 *
 * Example:
 *   node processor.js ./dropzone/2026-01-22-sprint.vtt yakshaver
 *
 * Exit Codes: 0 = success, 1 = error
 */

const fs = require("fs").promises;
const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");

// Configuration
const CONFIG = {
  claudeCommand: process.env.CLAUDE_CLI || "claude",
  outputDir: process.env.OUTPUT_DIR || path.join(__dirname, "output"),
  // Auth configuration - supports both API key and OAuth token
  claudeApiKey: process.env.ANTHROPIC_API_KEY,
  claudeOAuthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  model: process.env.CLAUDE_MODEL || "claude-opus-4-5-20251101",
};

class MeetingProcessor {
  constructor() {
    this.projectName = null;
    this.projectPath = null;
    this.transcriptPath = null;
    this.meetingId = null;
    this.meetingDate = null;
    this.meetingPath = null;
  }

  log(level, message, data = null) {
    const logEntry = {
      level: level.toLowerCase(),
      message,
      ...(data && { ...data }),
    };
    // All logs to stderr (real-time streaming, separable from machine output)
    // stdout reserved for machine output only (DEPLOYED_URL)
    console.error(JSON.stringify(logEntry));
  }

  truncate(text, maxLength = 120) {
    if (!text) return "";
    return text.length > maxLength
      ? `${text.substring(0, maxLength)}...`
      : text;
  }

  parseStreamJsonLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return { ok: false };

    try {
      const event = JSON.parse(trimmed);
      return { ok: true, event };
    } catch (error) {
      return { ok: false };
    }
  }

  shouldSkipEvent(event) {
    if (!event) return true;

    // Skip tool_use and tool_result events
    if (event.type === "tool_use" || event.type === "tool_result") return true;

    // Skip user/assistant events that contain tool_use_id or tool_result content
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

  extractEventPreview(event) {
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
      return this.truncate(content.split("\n")[0].trim());
    }

    if (Array.isArray(content) && content.length > 0) {
      const firstBlock = content[0];
      if (firstBlock?.type === "text" && firstBlock.text) {
        return this.truncate(firstBlock.text.split("\n")[0].trim());
      }
    }

    if (typeof messageObj.text === "string" && messageObj.text.trim()) {
      return this.truncate(messageObj.text.split("\n")[0].trim());
    }

    if (typeof messageObj.message === "string" && messageObj.message.trim()) {
      return this.truncate(messageObj.message.split("\n")[0].trim());
    }

    // Can't extract meaningful text - skip this event
    return "";
  }

  validateCredentials() {
    // Validate Claude credentials
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
      this.log("warn", "No Claude credentials - using CLI logged-in session");
    }

    // Validate dashboard storage account (required for deployment)
    if (!process.env.DASHBOARD_STORAGE_ACCOUNT) {
      throw new Error(
        "Dashboard storage account is required for deployment.\n" +
          "Set the DASHBOARD_STORAGE_ACCOUNT environment variable to the Azure Storage account name.",
      );
    }
  }

  getClaudeAuthMethod() {
    // Prioritize OAuth token (subscription - lower per-request cost for high volume)
    if (CONFIG.claudeOAuthToken) {
      return {
        useOAuth: true,
        env: {
          CLAUDE_CODE_OAUTH_TOKEN: CONFIG.claudeOAuthToken,
        },
      };
    } else if (CONFIG.claudeApiKey) {
      return {
        useOAuth: false,
        env: {
          ANTHROPIC_API_KEY: CONFIG.claudeApiKey,
        },
      };
    } else {
      return {
        useOAuth: false,
        env: {}, // Don't inject any auth vars, let Claude CLI handle it
      };
    }
  }

  validateTranscriptFilename(transcriptPath) {
    const filename = path.basename(transcriptPath, ".vtt");

    // Validate filename matches date-time pattern (YYYY-MM-DD-HHmmss)
    const dateTimePattern = /^(\d{4}-\d{2}-\d{2})-(\d{6})$/;
    const match = filename.match(dateTimePattern);

    if (!match) {
      throw new Error(
        `Invalid transcript filename: ${path.basename(transcriptPath)}\n` +
          "Transcript files must be named: YYYY-MM-DD-HHmmss.vtt\n" +
          "Example: 2026-01-22-094557.vtt",
      );
    }

    // Validate file extension
    if (path.extname(transcriptPath) !== ".vtt") {
      throw new Error(
        `Invalid transcript file extension: ${path.basename(transcriptPath)}\n` +
          "Only .vtt files are supported",
      );
    }

    return {
      meetingId: filename, // e.g., "2026-01-22-094557" (used for folder and deploy URL)
      meetingDate: match[1], // e.g., "2026-01-22"
      meetingTime: match[2], // e.g., "094557"
    };
  }

  async initialize(transcriptPath, projectName) {
    // Validate transcript file exists
    try {
      await fs.access(transcriptPath);
    } catch (error) {
      throw new Error(`Transcript file not found: ${transcriptPath}`);
    }

    // Validate and extract meeting info from filename
    const { meetingId, meetingDate, meetingTime } =
      this.validateTranscriptFilename(transcriptPath);

    this.transcriptPath = path.resolve(transcriptPath);
    this.projectName = projectName;
    this.meetingId = meetingId; // Format: YYYY-MM-DD-HHmmss (used for folder and deploy URL)
    this.meetingDate = meetingDate;
    this.meetingTime = meetingTime;
    this.projectPath = path.join(__dirname, "projects", projectName);
    this.meetingPath = path.join(this.projectPath, meetingId);

    this.log("debug", "Initialized", { meetingId, meetingDate, meetingTime });
  }

  async setupProjectStructure() {
    // Create self-contained meeting directory structure
    const dirs = [
      this.projectPath,
      this.meetingPath,
      path.join(this.meetingPath, "analysis"),
      path.join(this.meetingPath, "dashboard"),
    ];

    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }

    // Copy transcript to meeting folder
    const meetingTranscriptPath = path.join(this.meetingPath, "transcript.vtt");

    try {
      await fs.copyFile(this.transcriptPath, meetingTranscriptPath);
    } catch (error) {
      this.log("warn", "Failed to copy transcript", { error: error.message });
    }

    // Write attendees.json from meeting invite list (if available via env var)
    try {
      const inviteesJson = process.env.INVITEES_JSON;
      const vttInfoJson = process.env.VTT_INFO_JSON;
      if (inviteesJson) {
        const invitees = JSON.parse(inviteesJson);
        const vttInfo = vttInfoJson ? JSON.parse(vttInfoJson) : {};
        const attendeesData = {
          invitees,
          vttInfo,
          note: "Invitees are derived from the meeting invite list (UPNs). Use as a suggestion for name resolution — speaker <v> tags in the VTT are authoritative and take priority.",
        };
        const attendeesPath = path.join(this.meetingPath, "attendees.json");
        await fs.writeFile(
          attendeesPath,
          JSON.stringify(attendeesData, null, 2),
          "utf-8",
        );
        this.log("info", "Wrote attendees.json", {
          inviteeCount: invitees.length,
          hasSpeakerLabels: vttInfo.hasSpeakerLabels,
        });
      }
    } catch (error) {
      this.log("warn", "Failed to write attendees.json", {
        error: error.message,
      });
    }

    // Clean up previous analysis for this specific meeting (if exists)
    const analysisDir = path.join(this.meetingPath, "analysis");
    try {
      const files = await fs.readdir(analysisDir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          await fs.unlink(path.join(analysisDir, file));
        }
      }
    } catch (error) {
      // Directory might not exist or be empty - that's fine
    }
  }

  async invokeClaude() {
    // Ensure output directory exists
    await fs.mkdir(CONFIG.outputDir, { recursive: true });

    // Get authentication configuration
    const authConfig = this.getClaudeAuthMethod();

    const prompt = `Read CLAUDE.md and process the meeting transcript following the complete workflow.

Project: ${this.projectName}
Meeting ID: ${this.meetingId}
Meeting Date: ${this.meetingDate}
Meeting folder: projects/${this.projectName}/${this.meetingId}/
Transcript: projects/${this.projectName}/${this.meetingId}/transcript.vtt
Attendees (meeting invite list - use as suggestion for name resolution): projects/${this.projectName}/${this.meetingId}/attendees.json
Dashboard template: templates/dashboard.html

Follow all steps in CLAUDE.md EXCEPT deployment. Do NOT deploy or upload the dashboard.
Generate the dashboard HTML to: projects/${this.projectName}/${this.meetingId}/dashboard/index.html`;

    return new Promise((resolve, reject) => {
      // Spawn Claude Code CLI in print mode (non-interactive)
      // -p/--print: non-interactive output (reads from stdin)
      // --dangerously-skip-permissions: skip all permission prompts (required in Docker)
      // --allowedTools: specify tools the agent can use autonomously
      // --add-dir: ensure access to workspace, output, and project directories
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
        __dirname,
        "--add-dir",
        CONFIG.outputDir,
        "--add-dir",
        this.meetingPath,
        "--add-dir",
        path.join(__dirname, "templates"),
      ];

      // Determine command and args based on platform
      let command = CONFIG.claudeCommand;
      let spawnArgs = args;
      let spawnOptions = {
        cwd: __dirname,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          // Ensure trust for workspace
          CLAUDE_WORKSPACE_TRUST: "true",
          // Inject appropriate auth environment variables
          ...authConfig.env,
        },
      };

      // On Windows, join command and args to avoid DEP0190 deprecation warning
      // (spawn() with shell option + args array is deprecated)
      if (process.platform === "win32") {
        spawnOptions.shell = "powershell.exe";
        // Escape args for PowerShell and join into single command string
        const escapedArgs = spawnArgs.map((arg) =>
          arg.includes(" ") ? `"${arg}"` : arg,
        );
        command = `${CONFIG.claudeCommand} ${escapedArgs.join(" ")}`;
        spawnArgs = []; // Clear args array when using shell with command string
      }

      const claude = spawn(command, spawnArgs, spawnOptions);

      // Write prompt to stdin and close
      claude.stdin.write(prompt);
      claude.stdin.end();
      this.log("info", "Processing transcript with Claude CLI...");

      let stderr = "";
      let firstOutputReceived = false;
      let lastOutputTime = Date.now();
      let lastLoggedMessage = "";
      const startTime = Date.now();

      // Inactivity timeout: fail if no output received for 20 minutes
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
        lastOutputTime = Date.now(); // Reset inactivity timer
        firstOutputReceived = true;

        if (!line || !line.trim()) return;

        try {
          const parsed = this.parseStreamJsonLine(line);
          if (!parsed.ok) return;

          if (this.shouldSkipEvent(parsed.event)) return;

          const preview = this.extractEventPreview(parsed.event);
          if (preview) {
            lastLoggedMessage = preview;
            this.log("info", preview);
          }
        } catch (parseError) {
          // Ignore parse errors for non-JSON lines
        }
      });

      claude.stderr.on("data", (data) => {
        lastOutputTime = Date.now(); // Reset inactivity timer
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
            // Process was killed by a signal (not a normal exit)
            // Common causes: OOM kill (SIGKILL), container timeout (SIGTERM), user cancellation (SIGTERM)
            const signalHints = {
              SIGKILL:
                "Process was forcefully killed (likely out of memory - consider increasing container memory limit)",
              SIGTERM:
                "Process was terminated (likely container timeout or user cancellation)",
              SIGINT: "Process was interrupted",
            };
            const hint =
              signalHints[signal] || `Process received signal ${signal}`;
            this.log("error", `Claude CLI killed by ${signal}`, {
              hint,
              ...diagnostics,
            });
            reject(new Error(`Claude CLI killed by ${signal}: ${hint}`));
          } else {
            this.log("error", `Claude CLI failed (exit ${code})`, diagnostics);
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

  async checkOutputExists() {
    // Primary (canonical): Check self-contained meeting dashboard folder
    const primaryPath = path.join(this.meetingPath, "dashboard", "index.html");
    const fallbackPath = path.join(
      CONFIG.outputDir,
      `${this.projectName}-${this.meetingId}.html`,
    );

    try {
      await fs.access(primaryPath);
      return primaryPath;
    } catch (error) {
      try {
        await fs.access(fallbackPath);
        this.log("warn", "Dashboard not in canonical location, using fallback");
        return fallbackPath;
      } catch (fallbackError) {
        throw new Error(`Dashboard not found: ${primaryPath}`);
      }
    }
  }

  async copyToOutputDirectory(sourcePath) {
    if (!CONFIG.outputDir) return null;

    try {
      await fs.mkdir(CONFIG.outputDir, { recursive: true });
      const outputFilename = `${this.projectName}-${this.meetingId}.html`;
      const outputPath = path.join(CONFIG.outputDir, outputFilename);
      await fs.copyFile(sourcePath, outputPath);
      return outputPath;
    } catch (error) {
      return null;
    }
  }

  async deployDashboard(dashboardPath) {
    const storageAccount = process.env.DASHBOARD_STORAGE_ACCOUNT;
    if (!storageAccount) {
      throw new Error("DASHBOARD_STORAGE_ACCOUNT not set");
    }

    // Use single quotes to prevent shell from interpreting $web as a variable
    const blobDestination = `'$web/${this.projectName}/${this.meetingId}'`;
    const dashboardDir = path.dirname(dashboardPath);

    this.log("info", "Deploying dashboard to blob storage", {
      storageAccount,
      destination: blobDestination,
    });

    const { execSync } = require("child_process");
    const azureClientId = process.env.AZURE_CLIENT_ID;

    // Login with managed identity
    if (azureClientId) {
      this.log("info", "Logging in with managed identity", { clientId: azureClientId });
      try {
        execSync(`az login --identity --client-id ${azureClientId}`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        this.log("error", "az login --identity failed", { stderr: err.stderr });
        throw new Error(`az login --identity failed: ${err.stderr}`);
      }
    } else {
      this.log("warn", "AZURE_CLIENT_ID not set, assuming az is already logged in");
    }

    // Upload dashboard files
    try {
      execSync(
        `az storage blob upload-batch --source "${dashboardDir}" --destination ${blobDestination} --account-name ${storageAccount} --auth-mode login --overwrite`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch (err) {
      this.log("error", "Blob upload failed", { stderr: err.stderr });
      throw err;
    }

    // Build the dashboard URL: use DASHBOARD_BASE_URL if set, otherwise query storage account
    let host = process.env.DASHBOARD_BASE_URL;
    if (!host) {
      host = execSync(
        `az storage account show --name ${storageAccount} --query "primaryEndpoints.web" -o tsv`,
        { encoding: "utf-8" },
      ).trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
    }

    const deployedUrl = `https://${host}/${this.projectName}/${this.meetingId}`;
    this.log("info", "Dashboard deployed", { url: deployedUrl });
    return deployedUrl;
  }

  async process(transcriptPath, projectName) {
    try {
      // Validate credentials first (fail fast)
      this.validateCredentials();

      // Initialize
      await this.initialize(transcriptPath, projectName);

      // Setup project structure
      await this.setupProjectStructure();

      // Invoke Claude Code CLI (non-interactive, auto-accept)
      // Claude generates analysis + dashboard HTML only (no deployment)
      await this.invokeClaude();

      // Check if output exists at canonical location (meeting folder)
      const canonicalPath = await this.checkOutputExists();

      // Deploy dashboard to Azure Blob Storage
      const deployedUrl = await this.deployDashboard(canonicalPath);

      // Optional: Copy to output directory for convenience
      const outputCopyPath = await this.copyToOutputDirectory(canonicalPath);

      return {
        success: true,
        meetingId: this.meetingId,
        meetingDate: this.meetingDate,
        dashboardPath: canonicalPath,
        outputCopyPath,
        deployedUrl,
      };
    } catch (error) {
      this.log("error", error.message);
      throw error;
    }
  }
}

// Main execution
async function main() {
  const processor = new MeetingProcessor();

  // Parse command line arguments
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error(
      "Usage: node processor.js <transcript-file-path> <project-name>",
    );
    console.error(
      "Example: node processor.js ./transcripts/2026-01-22-sprint.vtt yakshaver",
    );
    console.error(
      "\nNote: For Azure/Graph API mode, use entrypoint.sh which handles transcript download",
    );
    process.exit(1);
  }

  const [transcriptPath, projectName] = args;

  try {
    const result = await processor.process(transcriptPath, projectName);
    // Log to stderr (consistent with log() method)
    console.error(
      JSON.stringify({
        level: "info",
        message: "Processing completed",
        meetingId: result.meetingId,
      }),
    );
    if (result.deployedUrl) {
      // Only DEPLOYED_URL goes to stdout (machine output)
      console.log(`DEPLOYED_URL=${result.deployedUrl}`);
    }
    process.exit(0);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Processing failed",
        error: error.message,
      }),
    );
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = MeetingProcessor;
