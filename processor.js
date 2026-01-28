#!/usr/bin/env node

/**
 * Meeting Transcript Processor - Claude Code CLI Wrapper
 * Invokes Claude Code CLI to process meeting transcripts
 *
 * Usage:
 *   Local:  node processor.js <transcript-file-path> <project-name>
 *   Azure:  Set env vars: GRAPH_MEETING_ID, GRAPH_TRANSCRIPT_ID, GRAPH_USER_ID, PROJECT_NAME, MEETING_DATE, FILENAME
 *
 * Exit Codes: 0 = success, 1 = error
 */

const fs = require("fs").promises;
const path = require("path");
const { spawn } = require("child_process");

// Configuration
const CONFIG = {
  claudeCommand: process.env.CLAUDE_CLI || "claude",
  outputDir: process.env.OUTPUT_DIR || path.join(__dirname, "output"),
  // Auth configuration - supports both API key and OAuth token
  claudeApiKey: process.env.ANTHROPIC_API_KEY,
  claudeOAuthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  // Graph API configuration (for downloading transcripts in Azure mode)
  graphClientId: process.env.GRAPH_CLIENT_ID,
  graphClientSecret: process.env.GRAPH_CLIENT_SECRET,
  graphTenantId: process.env.GRAPH_TENANT_ID,
  // Teams notification configuration (optional)
  teamsChatId: process.env.TEAMS_CHAT_ID,
  teamsTeamId: process.env.TEAMS_TEAM_ID,
  teamsChannelId: process.env.TEAMS_CHANNEL_ID,
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
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level: level.toUpperCase(),
      message,
      ...(data && { data }),
    };

    const serialized = JSON.stringify(logEntry);

    if (level === "error") {
      console.error(serialized);
    } else {
      console.log(serialized);
    }
  }

  logError(error, context = null) {
    this.log("error", error.message || String(error), {
      name: error.name,
      stack: error.stack,
      ...(context && { context }),
    });
  }

  validateCredentials() {
    this.log("info", "Validating credentials");

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
      this.log(
        "warn",
        "No explicit Claude credentials provided. Relying on Claude CLI logged-in session.",
      );
      this.log(
        "warn",
        "For production, set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY explicitly.",
      );
    } else if (CONFIG.claudeOAuthToken) {
      this.log("info", "Claude OAuth token credentials detected");
    } else if (CONFIG.claudeApiKey) {
      this.log("info", "Claude API key credentials detected");
    }

    // Validate Surge credentials (required for deployment)
    if (!process.env.SURGE_EMAIL || !process.env.SURGE_TOKEN) {
      throw new Error(
        "Surge.sh credentials are required for deployment.\n" +
          "Please set the following environment variables:\n" +
          "  SURGE_EMAIL=<your-email>\n" +
          "  SURGE_TOKEN=<your-token>\n" +
          "Get your token by running: surge token",
      );
    }

    this.log("info", "Surge.sh credentials validated");
  }

  getClaudeAuthMethod() {
    // Prioritize OAuth token (subscription - lower per-request cost for high volume)
    if (CONFIG.claudeOAuthToken) {
      this.log("info", "Using Claude OAuth token authentication");
      return {
        useOAuth: true,
        env: {
          CLAUDE_CODE_OAUTH_TOKEN: CONFIG.claudeOAuthToken,
        },
      };
    } else if (CONFIG.claudeApiKey) {
      this.log("info", "Using Claude API key authentication");
      return {
        useOAuth: false,
        env: {
          ANTHROPIC_API_KEY: CONFIG.claudeApiKey,
        },
      };
    } else {
      // Fallback: Let Claude CLI use its stored session credentials
      this.log(
        "info",
        "Using Claude CLI session authentication (logged-in user)",
      );
      return {
        useOAuth: false,
        env: {}, // Don't inject any auth vars, let Claude CLI handle it
      };
    }
  }

  validateTranscriptFilename(transcriptPath) {
    const filename = path.basename(transcriptPath, ".vtt");

    // Validate filename starts with date pattern (YYYY-MM-DD)
    const datePattern = /^(\d{4}-\d{2}-\d{2})/;
    const match = filename.match(datePattern);

    if (!match) {
      throw new Error(
        `Invalid transcript filename: ${path.basename(transcriptPath)}\n` +
          "Transcript files must be named with date prefix: YYYY-MM-DD.vtt or YYYY-MM-DD-<identifier>.vtt\n" +
          "Examples: 2026-01-22.vtt, 2026-01-22-sprint-review.vtt",
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
      meetingId: filename, // e.g., "2026-01-22" or "2026-01-22-sprint-review"
      meetingDate: match[1], // e.g., "2026-01-22"
    };
  }

  async initialize(transcriptPath, projectName) {
    this.log("info", "Initializing processor", { transcriptPath, projectName });

    // Validate transcript file exists
    try {
      await fs.access(transcriptPath);
    } catch (error) {
      throw new Error(`Transcript file not found: ${transcriptPath}`);
    }

    // Validate and extract meeting info from filename
    const { meetingId, meetingDate } =
      this.validateTranscriptFilename(transcriptPath);

    this.transcriptPath = path.resolve(transcriptPath);
    this.projectName = projectName;
    this.meetingId = meetingId;
    this.meetingDate = meetingDate;
    this.projectPath = path.join(__dirname, "projects", projectName);
    this.meetingPath = path.join(this.projectPath, meetingId);

    this.log("info", "Initialization complete", {
      meetingId: this.meetingId,
      meetingDate: this.meetingDate,
      meetingPath: this.meetingPath,
    });
  }

  async setupProjectStructure() {
    this.log("info", "Setting up self-contained meeting structure", {
      meetingId: this.meetingId,
      meetingPath: this.meetingPath,
    });

    // Create self-contained meeting directory structure
    const dirs = [
      this.projectPath,
      this.meetingPath,
      path.join(this.meetingPath, "analysis"),
      path.join(this.meetingPath, "dashboard"),
    ];

    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
      this.log("debug", `Created directory: ${dir}`);
    }

    // Copy transcript to meeting folder
    const meetingTranscriptPath = path.join(this.meetingPath, "transcript.vtt");

    try {
      await fs.copyFile(this.transcriptPath, meetingTranscriptPath);
      this.log("info", "Transcript copied to meeting folder", {
        from: this.transcriptPath,
        to: meetingTranscriptPath,
      });
    } catch (error) {
      this.log("warn", "Failed to copy transcript to meeting folder", {
        error: error.message,
      });
    }

    // Clean up previous analysis for this specific meeting (if exists)
    // This prevents AI confusion from stale data
    const analysisDir = path.join(this.meetingPath, "analysis");
    try {
      const files = await fs.readdir(analysisDir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          const filePath = path.join(analysisDir, file);
          await fs.unlink(filePath);
          this.log("debug", `Cleaned previous analysis file: ${file}`);
        }
      }
      this.log("info", "Previous analysis cleaned");
    } catch (error) {
      // Directory might not exist or be empty - that's fine
      this.log("debug", "No previous analysis to clean");
    }

    this.log("info", "Self-contained meeting structure ready");
  }

  async invokeClaude() {
    this.log("info", "Invoking Claude Code CLI", {
      meetingId: this.meetingId,
    });

    // Ensure output directory exists
    await fs.mkdir(CONFIG.outputDir, { recursive: true });

    // Get authentication configuration
    const authConfig = this.getClaudeAuthMethod();

    // Meeting-specific output filename
    const outputFilename = `${this.projectName}-${this.meetingId}.html`;
    const outputPath = path.join(CONFIG.outputDir, outputFilename);

    const prompt = `Read CLAUDE.md and process the meeting transcript following the complete workflow.

Project: ${this.projectName}
Meeting ID: ${this.meetingId}
Meeting Date: ${this.meetingDate}
Meeting folder: projects/${this.projectName}/${this.meetingId}/
Transcript: projects/${this.projectName}/${this.meetingId}/transcript.vtt

Follow all steps in CLAUDE.md including deployment. Output DEPLOYED_URL as specified.`;

    return new Promise((resolve, reject) => {
      // Spawn Claude Code CLI in print mode (non-interactive)
      // -p/--print: non-interactive output (reads from stdin)
      // --dangerously-skip-permissions: skip all permission prompts (required in Docker)
      // --allowedTools: specify tools the agent can use autonomously
      // --add-dir: ensure access to workspace, output, and project directories
      const args = [
        "-p",
        "--verbose",
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

      // On Windows, use PowerShell shell (tested and works with stdin)
      if (process.platform === "win32") {
        spawnOptions.shell = "powershell.exe";
        this.log("debug", "Using PowerShell shell to invoke Claude command", {
          command: CONFIG.claudeCommand,
          authMethod: authConfig.useOAuth ? "oauth-token" : "api-key",
        });
      }

      this.log("info", "Spawning Claude CLI with flags", {
        flags: spawnArgs.join(" "),
        promptLength: prompt.length,
      });

      const claude = spawn(command, spawnArgs, spawnOptions);

      // Write prompt to stdin and close
      this.log("info", "Sending prompt to Claude CLI...");
      claude.stdin.write(prompt);
      claude.stdin.end();
      this.log(
        "info",
        "Prompt sent. Waiting for Claude analysis (this may take 5-10 minutes)...",
      );

      let stdout = "";
      let stderr = "";
      let firstOutputReceived = false;
      let lastOutputTime = Date.now();
      let currentActivity = "initializing";
      let jsonBuffer = ""; // Buffer for incomplete JSON lines

      // Progress indicator: log current activity every minute
      let elapsedMinutes = 0;
      const progressInterval = setInterval(() => {
        elapsedMinutes++;
        const minutesSinceLastOutput = Math.floor(
          (Date.now() - lastOutputTime) / 60000,
        );
      }, 60000); // Every 1 minute

      // Inactivity timeout: fail if no output received for 15 minutes
      const INACTIVITY_TIMEOUT = 900000; // 15 minutes
      const inactivityTimer = setInterval(() => {
        const timeSinceLastOutput = Date.now() - lastOutputTime;
        if (timeSinceLastOutput > INACTIVITY_TIMEOUT) {
          clearInterval(inactivityTimer);
          clearInterval(progressInterval);
          const error = `Claude CLI timeout: No output received for ${Math.floor(timeSinceLastOutput / 60000)} minutes. Last activity: ${currentActivity}`;
          this.log("error", error);
          claude.kill();
          reject(new Error(error));
        }
      }, 30000); // Check every 30 seconds

      claude.stdout.on("data", (data) => {
        lastOutputTime = Date.now(); // Reset inactivity timer
        if (!firstOutputReceived) {
          firstOutputReceived = true;
          this.log("info", "Receiving streaming output from Claude CLI...");
        }

        const output = data.toString();
        stdout += output;

        // Parse streaming JSON output for major events
        // Claude Code CLI outputs newline-delimited JSON objects
        jsonBuffer += output;
        const lines = jsonBuffer.split("\n");
        jsonBuffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const event = JSON.parse(line);

            // Extract first meaningful text from event for logging
            const extractPreview = (obj) => {
              if (!obj) return "";
              const truncate = (s, len = 120) =>
                s && s.length > len ? s.substring(0, len) + "..." : s || "";

              // Handle system events with subtype
              if (obj.type === "system" && obj.subtype) {
                if (obj.subtype === "init") {
                  const sessionId =
                    obj.session_id?.substring(0, 8) || "unknown";
                  return `Session initialized (${sessionId})`;
                }
                return obj.subtype;
              }

              // Handle nested message object (Claude CLI stream-json format)
              const messageObj = obj.message || obj;
              const content = messageObj.content;

              if (content !== undefined) {
                // Content is a string directly
                if (typeof content === "string") {
                  return truncate(content.split("\n")[0].trim());
                }
                // Content is an array of blocks
                if (Array.isArray(content) && content.length > 0) {
                  const firstBlock = content[0];
                  if (firstBlock) {
                    // Text block
                    if (firstBlock.type === "text" && firstBlock.text) {
                      return truncate(firstBlock.text.split("\n")[0].trim());
                    }
                    // Tool use block
                    if (firstBlock.type === "tool_use" && firstBlock.name) {
                      return `Calling tool: ${firstBlock.name}`;
                    }
                    // Tool result block
                    if (firstBlock.type === "tool_result") {
                      const resultText =
                        typeof firstBlock.content === "string"
                          ? firstBlock.content.split("\n")[0].trim()
                          : "completed";
                      return truncate(`Tool result: ${resultText}`);
                    }
                    // Fallback: stringify first block
                    return truncate(JSON.stringify(firstBlock));
                  }
                }
                // Content is something else - stringify it directly
                return truncate(JSON.stringify(content));
              }

              // Handle direct text fields
              if (typeof obj.text === "string" && obj.text.trim()) {
                return truncate(obj.text.split("\n")[0].trim());
              }
              if (typeof obj.message === "string" && obj.message.trim()) {
                return truncate(obj.message.split("\n")[0].trim());
              }

              // Final fallback: stringify relevant fields
              const relevantKeys = [
                "content",
                "text",
                "message",
                "data",
                "result",
              ];
              for (const key of relevantKeys) {
                if (obj[key] !== undefined) {
                  const val = JSON.stringify(obj[key]);
                  return truncate(val);
                }
              }

              return truncate(JSON.stringify(obj));
            };

            // Log events
            const preview = extractPreview(event);
            this.log("info", preview);
          } catch (parseError) {
            // Ignore parse errors for non-JSON lines (e.g., plain text output)
            if (line.includes("DEPLOYED_URL=")) {
              this.log("info", "Deployment URL detected", { line });
            }
          }
        }
      });

      claude.stderr.on("data", (data) => {
        lastOutputTime = Date.now(); // Reset inactivity timer
        if (!firstOutputReceived) {
          firstOutputReceived = true;
        }
        const stderrText = data.toString();
        stderr += stderrText;
        // Log stderr for visibility
        this.log("warn", `Claude stderr: ${stderrText.trim()}`);
      });

      claude.on("close", async (code) => {
        clearInterval(inactivityTimer);
        clearInterval(progressInterval);
        if (code === 0) {
          this.log("info", "Claude Code CLI completed successfully");
          // Extract deployed URL from stdout (URL only, stop at whitespace/newline)
          const match = stdout.match(/DEPLOYED_URL=(https?:\/\/[^\s"'\\]+)/);
          const deployedUrl = match ? match[1].trim() : null;
          resolve({ stdout, stderr, deployedUrl });
        } else {
          const error = `Claude Code CLI failed with exit code ${code}\nStderr: ${stderr}`;
          await this.logError(error);
          reject(new Error(error));
        }
      });

      claude.on("error", async (err) => {
        clearInterval(inactivityTimer);
        clearInterval(progressInterval);
        const error = `Failed to spawn Claude Code CLI: ${err.message}`;
        await this.logError(error);
        reject(new Error(error));
      });
    });
  }

  async checkOutputExists() {
    // Primary (canonical): Check self-contained meeting dashboard folder
    const primaryPath = path.join(this.meetingPath, "dashboard", "index.html");

    try {
      await fs.access(primaryPath);
      this.log("info", "Dashboard generated successfully", {
        path: primaryPath,
        meetingId: this.meetingId,
      });
      return primaryPath;
    } catch (error) {
      throw new Error(
        `Dashboard not found at canonical location: ${primaryPath}`,
      );
    }
  }

  async copyToOutputDirectory(sourcePath) {
    // Optional: Copy dashboard to output directory for convenience
    if (!CONFIG.outputDir) {
      this.log("debug", "No output directory configured, skipping copy");
      return null;
    }

    try {
      await fs.mkdir(CONFIG.outputDir, { recursive: true });

      const outputFilename = `${this.projectName}-${this.meetingId}.html`;
      const outputPath = path.join(CONFIG.outputDir, outputFilename);

      await fs.copyFile(sourcePath, outputPath);

      this.log("info", "Dashboard copied to output directory", {
        from: sourcePath,
        to: outputPath,
      });

      return outputPath;
    } catch (error) {
      this.log("warn", "Failed to copy dashboard to output directory", {
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Get Graph API access token using client credentials flow (MSAL)
   */
  async getGraphToken() {
    this.log("info", "Acquiring Graph API token");

    if (
      !CONFIG.graphClientId ||
      !CONFIG.graphClientSecret ||
      !CONFIG.graphTenantId
    ) {
      throw new Error(
        "Graph API credentials not configured.\n" +
          "Set: GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, GRAPH_TENANT_ID",
      );
    }

    const tokenUrl = `https://login.microsoftonline.com/${CONFIG.graphTenantId}/oauth2/v2.0/token`;

    const params = new URLSearchParams({
      client_id: CONFIG.graphClientId,
      client_secret: CONFIG.graphClientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to acquire Graph token: ${response.status} - ${errorText}`,
      );
    }

    const data = await response.json();
    this.log("info", "Graph API token acquired successfully");
    return data.access_token;
  }

  async downloadFromGraphApi(userId, meetingId, transcriptId, filename) {
    this.log("info", "Downloading transcript from Graph API", {
      userId,
      meetingId,
      transcriptId,
    });

    const token = await this.getGraphToken();

    // Graph API endpoint for transcript content
    // GET /users/{userId}/onlineMeetings/{meetingId}/transcripts/{transcriptId}/content?$format=text/vtt
    const graphUrl = `https://graph.microsoft.com/v1.0/users/${userId}/onlineMeetings/${meetingId}/transcripts/${transcriptId}/content?$format=text/vtt`;

    const response = await fetch(graphUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to download transcript: ${response.status} - ${errorText}`,
      );
    }

    const vttContent = await response.text();

    // Save to temp file
    const tempDir = path.join(__dirname, "temp");
    await fs.mkdir(tempDir, { recursive: true });

    const localPath = path.join(tempDir, filename);
    await fs.writeFile(localPath, vttContent, "utf-8");

    this.log("info", "Transcript downloaded from Graph API", {
      localPath,
      size: vttContent.length,
    });

    return localPath;
  }

  async postToTeams(deployedUrl) {
    const isGroupChat = !!CONFIG.teamsChatId;
    const isChannel = !!(CONFIG.teamsTeamId && CONFIG.teamsChannelId);

    if (!isGroupChat && !isChannel) {
      this.log("info", "Teams not configured, skipping notification");
      return;
    }

    const targetType = isGroupChat ? "group chat" : "channel";
    this.log("info", `Posting dashboard link to Teams ${targetType}`, {
      deployedUrl,
    });

    try {
      const token = await this.getGraphToken();

      const message = {
        body: {
          contentType: "html",
          content: `<p><strong>📊 Meeting Dashboard Ready</strong></p>
<p><strong>Project:</strong> ${this.projectName}</p>
<p><strong>Meeting:</strong> ${this.meetingId} (${this.meetingDate})</p>
<p><a href="${deployedUrl}">🔗 View Dashboard</a></p>`,
        },
      };

      const graphUrl = isGroupChat
        ? `https://graph.microsoft.com/v1.0/chats/${CONFIG.teamsChatId}/messages`
        : `https://graph.microsoft.com/v1.0/teams/${CONFIG.teamsTeamId}/channels/${CONFIG.teamsChannelId}/messages`;

      const response = await fetch(graphUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Graph API error: ${response.status} - ${errorBody}`);
      }

      const result = await response.json();
      this.log("info", `Successfully posted to Teams ${targetType}`, {
        messageId: result.id,
      });
    } catch (error) {
      this.log("warn", `Failed to post to Teams: ${error.message}`);
    }
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
      // Claude will handle: analysis, consolidation, dashboard generation, AND deployment
      const claudeResult = await this.invokeClaude();

      // Check if output exists at canonical location (meeting folder)
      const canonicalPath = await this.checkOutputExists();

      // Optional: Copy to output directory for convenience
      const outputCopyPath = await this.copyToOutputDirectory(canonicalPath);

      this.log("info", "Processing complete", {
        project: this.projectName,
        meetingId: this.meetingId,
        meetingDate: this.meetingDate,
        canonicalPath,
        outputCopyPath: outputCopyPath || "not copied",
        deployedUrl: claudeResult.deployedUrl || "not deployed",
      });

      // Post link back to Teams (if configured)
      if (claudeResult.deployedUrl) {
        this.log("info", `DEPLOYED_URL=${claudeResult.deployedUrl}`);
        await this.postToTeams(claudeResult.deployedUrl);
      }

      return {
        success: true,
        meetingId: this.meetingId,
        meetingDate: this.meetingDate,
        dashboardPath: canonicalPath,
        outputCopyPath,
        deployedUrl: claudeResult.deployedUrl,
      };
    } catch (error) {
      await this.logError(
        `Processing failed: ${error.message}\n${error.stack}`,
      );
      throw error;
    }
  }
}

/**
 * Check if running in Azure mode (Graph API env vars set)
 */
function isAzureMode() {
  return !!(
    process.env.GRAPH_MEETING_ID &&
    process.env.GRAPH_TRANSCRIPT_ID &&
    process.env.GRAPH_USER_ID &&
    process.env.PROJECT_NAME
  );
}

// Main execution
async function main() {
  const processor = new MeetingProcessor();

  let transcriptPath, projectName;

  if (isAzureMode()) {
    // Azure Container App Job mode: download transcript from Graph API
    processor.log("info", "Running in Azure mode (Graph API)");

    const graphMeetingId = process.env.GRAPH_MEETING_ID;
    const graphTranscriptId = process.env.GRAPH_TRANSCRIPT_ID;
    const graphUserId = process.env.GRAPH_USER_ID;
    projectName = process.env.PROJECT_NAME;
    const meetingDate = process.env.MEETING_DATE;
    const filename = process.env.FILENAME || `${meetingDate}.vtt`;

    processor.log("info", "Azure environment variables", {
      graphMeetingId,
      graphTranscriptId,
      graphUserId,
      projectName,
      meetingDate,
      filename,
    });

    // Download VTT from Graph API
    try {
      transcriptPath = await processor.downloadFromGraphApi(
        graphUserId,
        graphMeetingId,
        graphTranscriptId,
        filename,
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "ERROR",
          message: "Failed to download transcript from Graph API",
          error: error.message,
          exitCode: 1,
        }),
      );
      process.exit(1);
    }
  } else {
    // Local mode: parse command line arguments
    const args = process.argv.slice(2);

    if (args.length < 2) {
      console.error(
        "Usage: node processor.js <transcript-file-path> <project-name>",
      );
      console.error(
        "Example: node processor.js ./transcripts/meeting.vtt yakshaver",
      );
      console.error(
        "\nOr set Azure env vars: GRAPH_MEETING_ID, GRAPH_TRANSCRIPT_ID, GRAPH_USER_ID, PROJECT_NAME",
      );
      process.exit(1);
    }

    [transcriptPath, projectName] = args;
  }

  try {
    const result = await processor.process(transcriptPath, projectName);
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "INFO",
        message: "SUCCESS: Meeting processing completed",
        meetingId: result.meetingId,
        meetingDate: result.meetingDate,
        dashboardPath: result.dashboardPath,
        outputCopyPath: result.outputCopyPath || "",
        deployedUrl: result.deployedUrl || "",
        exitCode: 0,
      }),
    );
    process.exit(0);
  } catch (error) {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "ERROR",
        message: "FAILURE: Meeting processing failed",
        error: error.message,
        exitCode: 1,
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
