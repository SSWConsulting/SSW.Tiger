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

  generateDeployUrl(projectName, meetingId) {
    // Surge.sh domain limit: ~63 characters total (including .surge.sh suffix)
    // Reserve 10 chars for ".surge.sh", leaving ~53 chars for project-meeting
    // Format: {project}-{meeting-id}.surge.sh

    const MAX_DOMAIN_LENGTH = 35; // Without .surge.sh suffix
    const MEETING_ID_LENGTH = 17; // YYYY-MM-DD-HHmmss (fixed length)
    const SEPARATOR_LENGTH = 1; // hyphen between project and meeting

    // Calculate max project name length
    const maxProjectLength =
      MAX_DOMAIN_LENGTH - MEETING_ID_LENGTH - SEPARATOR_LENGTH;

    // Sanitize project name for valid surge.sh domain (only a-z, 0-9, hyphens allowed)
    let truncatedProject =
      projectName
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-") // Replace any non-alphanumeric char with hyphen
        .replace(/-+/g, "-") // Collapse consecutive hyphens
        .replace(/^-+|-+$/g, "") || // Trim all leading/trailing hyphens
      "general"; // Fallback if sanitization yields empty string
    if (truncatedProject.length > maxProjectLength) {
      // Truncate at word boundary (last hyphen before limit)
      const truncated = truncatedProject.substring(0, maxProjectLength);
      const lastHyphen = truncated.lastIndexOf("-");
      truncatedProject =
        lastHyphen > 0 ? truncated.substring(0, lastHyphen) : truncated;

      this.log("warn", "Project name truncated for deploy URL", {
        original: projectName,
        truncated: truncatedProject,
        originalLength: projectName.length,
        maxLength: maxProjectLength,
      });
    }

    const deployDomain = `${truncatedProject}-${meetingId}`;

    // Validate total length
    if (deployDomain.length > MAX_DOMAIN_LENGTH) {
      this.log("error", "Deploy domain too long even after truncation", {
        domain: deployDomain,
        length: deployDomain.length,
        maxLength: MAX_DOMAIN_LENGTH,
      });
    }

    return `${deployDomain}.surge.sh`;
  }

  extractDeployedUrl(text, expectedDomain) {
    // Try multiple patterns to extract the deployed URL
    // Pattern priority: most specific to most permissive

    const patterns = [
      // Pattern 1: DEPLOYED_URL= with expected domain (most specific)
      new RegExp(
        `DEPLOYED_URL=(https?:\\/\\/${expectedDomain.replace(/\./g, "\\.")})`,
        "i",
      ),

      // Pattern 2: DEPLOYED_URL= with any surge.sh domain
      /DEPLOYED_URL=(https?:\/\/[a-z0-9-]+\.surge\.sh)/i,

      // Pattern 3: DEPLOYED_URL= with protocol and any domain
      /DEPLOYED_URL=(https?:\/\/[^\s"'`<>\\]+)/i,

      // Pattern 4: Just the expected domain with protocol (fallback)
      new RegExp(`(https?:\\/\\/${expectedDomain.replace(/\./g, "\\.")})`, "i"),

      // Pattern 5: Any surge.sh URL (last resort)
      /(https?:\/\/[a-z0-9-]+\.surge\.sh)/i,
    ];

    for (let i = 0; i < patterns.length; i++) {
      const match = text.match(patterns[i]);
      if (match && match[1]) {
        const url = match[1].trim();

        // Validate URL format
        if (this.validateDeployedUrl(url)) {
          this.log("debug", `Extracted deployed URL (pattern ${i + 1})`, {
            url,
          });
          return url;
        }
      }
    }

    return null;
  }

  validateDeployedUrl(url) {
    if (!url) return false;

    // Must start with http:// or https://
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return false;
    }

    // Must end with .surge.sh (case-insensitive)
    if (!url.toLowerCase().endsWith(".surge.sh")) {
      this.log("warn", "URL doesn't end with .surge.sh", { url });
      return false;
    }

    // Extract domain part (without protocol and .surge.sh)
    const domain = url.replace(/^https?:\/\//, "").replace(/\.surge\.sh$/i, "");

    // Domain should only contain lowercase letters, numbers, and hyphens
    if (!/^[a-z0-9-]+$/.test(domain)) {
      this.log("warn", "Invalid domain format", { url, domain });
      return false;
    }

    // Domain shouldn't start or end with hyphen
    if (domain.startsWith("-") || domain.endsWith("-")) {
      this.log("warn", "Domain starts or ends with hyphen", { url, domain });
      return false;
    }

    return true;
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

    // Meeting-specific output filename
    const outputFilename = `${this.projectName}-${this.meetingId}.html`;
    const outputPath = path.join(CONFIG.outputDir, outputFilename);

    // Generate deploy URL with truncation if needed
    const deployUrl = this.generateDeployUrl(this.projectName, this.meetingId);

    const prompt = `Read CLAUDE.md and process the meeting transcript following the complete workflow.

Project: ${this.projectName}
Meeting ID: ${this.meetingId}
Meeting Date: ${this.meetingDate}
Meeting folder: projects/${this.projectName}/${this.meetingId}/
Transcript: projects/${this.projectName}/${this.meetingId}/transcript.vtt
Dashboard template: templates/dashboard.html

Follow all steps in CLAUDE.md including deployment.
Deploy to: ${deployUrl}
Output DEPLOYED_URL as specified.`;

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

      let deployedUrl = null;
      let stderr = "";
      let firstOutputReceived = false;
      let lastOutputTime = Date.now();

      // Inactivity timeout: fail if no output received for 15 minutes
      const INACTIVITY_TIMEOUT = 900000;
      const inactivityTimer = setInterval(() => {
        const timeSinceLastOutput = Date.now() - lastOutputTime;
        if (timeSinceLastOutput > INACTIVITY_TIMEOUT) {
          clearInterval(inactivityTimer);
          claude.kill();
          reject(new Error("Claude CLI timeout: no output for 15 minutes"));
        }
      }, 30000);

      const stdoutReader = readline.createInterface({
        input: claude.stdout,
        crlfDelay: Infinity,
      });

      // Accumulate all output for fallback URL extraction
      let allStdout = "";

      stdoutReader.on("line", (line) => {
        lastOutputTime = Date.now(); // Reset inactivity timer
        firstOutputReceived = true;

        if (!line || !line.trim()) return;

        // Accumulate for fallback
        allStdout += line + "\n";

        // Fast-path: capture deployed URL if it appears in plain output
        if (!deployedUrl) {
          const extracted = this.extractDeployedUrl(line, deployUrl);
          if (extracted) {
            deployedUrl = extracted;
            this.log("info", "✅ Deployed URL captured", { url: deployedUrl });
          }
        }

        try {
          const parsed = this.parseStreamJsonLine(line);
          if (!parsed.ok) return;

          if (this.shouldSkipEvent(parsed.event)) return;

          const preview = this.extractEventPreview(parsed.event);
          if (preview) {
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

      claude.on("close", async (code) => {
        clearInterval(inactivityTimer);

        if (code === 0) {
          // If URL not found yet, try fallback extraction from all accumulated output
          if (!deployedUrl) {
            this.log(
              "warn",
              "Deployed URL not found in real-time, trying fallback extraction",
            );

            // Try extracting from accumulated stdout
            deployedUrl = this.extractDeployedUrl(allStdout, deployUrl);

            // If still not found, try stderr
            if (!deployedUrl) {
              deployedUrl = this.extractDeployedUrl(stderr, deployUrl);
            }

            if (deployedUrl) {
              this.log("info", "✅ Deployed URL extracted via fallback", {
                url: deployedUrl,
              });
            } else {
              this.log("error", "❌ Failed to extract deployed URL", {
                expectedDomain: deployUrl,
                stdoutPreview: allStdout.substring(0, 500),
                stderrPreview: stderr.substring(0, 500),
              });
            }
          }

          resolve({ stdout: null, stderr, deployedUrl });
        } else {
          const error = `Claude CLI failed (exit ${code}): ${stderr.substring(0, 200)}`;
          reject(new Error(error));
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

      return {
        success: true,
        meetingId: this.meetingId,
        meetingDate: this.meetingDate,
        dashboardPath: canonicalPath,
        outputCopyPath,
        deployedUrl: claudeResult.deployedUrl,
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
