#!/usr/bin/env node

/**
 * Meeting Transcript Processor - Claude Code CLI Wrapper
 * Invokes Claude Code CLI to process meeting transcripts
 *
 * Usage: node processor.js <transcript-file-path> <project-name>
 * Exit Codes: 0 = success, 1 = error
 */

const fs = require("fs").promises;
const path = require("path");
const { spawn } = require("child_process");

// Configuration
const CONFIG = {
  claudeCommand: process.env.CLAUDE_CLI || "claude",
  outputDir: process.env.OUTPUT_DIR || path.join(__dirname, "output"),
  // Auth configuration - supports both API key and subscription
  claudeApiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY,
  claudeSubscriptionToken: process.env.CLAUDE_SUBSCRIPTION_TOKEN,
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
      !CONFIG.claudeSubscriptionToken &&
      !CONFIG.claudeApiKey
    ) {
      throw new Error(
        "No Claude credentials found in production.\n" +
          "Set one of the following environment variables:\n" +
          "  CLAUDE_SUBSCRIPTION_TOKEN=<your-token>\n" +
          "  ANTHROPIC_API_KEY=<your-api-key>",
      );
    }

    if (!CONFIG.claudeSubscriptionToken && !CONFIG.claudeApiKey) {
      this.log(
        "warn",
        "No explicit Claude credentials provided. Relying on Claude CLI logged-in session.",
      );
      this.log(
        "warn",
        "For production, set CLAUDE_SUBSCRIPTION_TOKEN or ANTHROPIC_API_KEY explicitly.",
      );
    } else if (CONFIG.claudeSubscriptionToken) {
      this.log("info", "Claude subscription credentials detected");
    } else if (CONFIG.claudeApiKey) {
      this.log("info", "Claude API key credentials detected");
    }

    // Validate Surge credentials (required for deployment)
    if (!process.env.SURGE_LOGIN || !process.env.SURGE_TOKEN) {
      throw new Error(
        "Surge.sh credentials are required for deployment.\n" +
          "Please set the following environment variables:\n" +
          "  SURGE_LOGIN=<your-email>\n" +
          "  SURGE_TOKEN=<your-token>\n" +
          "Get your token by running: surge token",
      );
    }

    this.log("info", "Surge.sh credentials validated");
    this.log("info", "All credentials validated successfully");
  }

  getClaudeAuthMethod() {
    // Prioritize subscription (lower per-request cost for high volume)
    if (CONFIG.claudeSubscriptionToken) {
      this.log("info", "Using Claude subscription authentication");
      return {
        useSubscription: true,
        env: {
          CLAUDE_SUBSCRIPTION: "true",
          CLAUDE_SUBSCRIPTION_TOKEN: CONFIG.claudeSubscriptionToken,
        },
      };
    } else if (CONFIG.claudeApiKey) {
      this.log("info", "Using Claude API key authentication");
      return {
        useSubscription: false,
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
        useSubscription: false,
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

    const prompt = `Read the instructions in CLAUDE.md and process the meeting transcript.

Transcript file: projects/${this.projectName}/${this.meetingId}/transcript.vtt
Project name: ${this.projectName}
Meeting ID: ${this.meetingId}
Meeting Date: ${this.meetingDate}
Output dashboard to: ${outputPath}

IMPORTANT: Use self-contained meeting directory:
- Meeting folder: projects/${this.projectName}/${this.meetingId}/
- Transcript: projects/${this.projectName}/${this.meetingId}/transcript.vtt
- Analysis: projects/${this.projectName}/${this.meetingId}/analysis/
- Dashboard: projects/${this.projectName}/${this.meetingId}/dashboard/

Follow the complete workflow defined in CLAUDE.md. At the end, output a single line in this format:
DEPLOYED_URL=<url>`;

    return new Promise((resolve, reject) => {
      // Spawn Claude Code CLI in print mode (non-interactive)
      // --print: non-interactive output (reads from stdin)
      // --permission-mode bypassPermissions: auto-accept all permissions
      // --add-dir: ensure access to workspace, output, and project directories
      const args = [
        "--print",
        "--permission-mode",
        "bypassPermissions",
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
          authMethod: authConfig.useSubscription ? "subscription" : "api-key",
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

      claude.stdout.on("data", (data) => {
        if (!firstOutputReceived) {
          firstOutputReceived = true;
          this.log("info", "Receiving output from Claude CLI...");
          clearTimeout(timeout); // Clear the warning timeout
        }
        stdout += data.toString();
        process.stdout.write(data);
      });

      claude.stderr.on("data", (data) => {
        if (!firstOutputReceived) {
          firstOutputReceived = true;
          clearTimeout(timeout);
        }
        stderr += data.toString();
        process.stderr.write(data);
      });

      claude.on("close", async (code) => {
        clearTimeout(timeout);
        clearInterval(progressInterval);

        if (code === 0) {
          this.log("info", "Claude Code CLI completed successfully");
          // Extract deployed URL from stdout
          const match = stdout.match(/DEPLOYED_URL=(.+)/);
          const deployedUrl = match ? match[1].trim() : null;
          resolve({ stdout, stderr, deployedUrl });
        } else {
          const error = `Claude Code CLI failed with exit code ${code}\nStderr: ${stderr}`;
          await this.logError(error);
          reject(new Error(error));
        }
      });

      claude.on("error", async (err) => {
        clearTimeout(timeout);
        clearInterval(progressInterval);
        const error = `Failed to spawn Claude Code CLI: ${err.message}`;
        await this.logError(error);
        reject(new Error(error));
      });

      // Add progress indicator (shows activity while waiting)
      let elapsedMinutes = 0;
      const progressInterval = setInterval(() => {
        elapsedMinutes++;
        if (!firstOutputReceived) {
          this.log(
            "info",
            `Still waiting for Claude... (${elapsedMinutes} minute${elapsedMinutes > 1 ? "s" : ""} elapsed)`,
          );
        }
      }, 180000); // Every 3 minutes
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

// Main execution
async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error(
      "Usage: node processor.js <transcript-file-path> <project-name>",
    );
    console.error(
      "Example: node processor.js ./transcripts/meeting.vtt yakshaver",
    );
    process.exit(1);
  }

  const [transcriptPath, projectName] = args;

  const processor = new MeetingProcessor();

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
