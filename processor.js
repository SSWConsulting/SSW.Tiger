#!/usr/bin/env node

/**
 * Meeting Transcript Processor - Claude Code CLI Wrapper
 * Invokes Claude Code CLI to process meeting transcripts
 * 
 * Usage: node processor.js <transcript-file-path> <project-name>
 * Exit Codes: 0 = success, 1 = error
 */

const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');

// Configuration
const CONFIG = {
  claudeCommand: process.env.CLAUDE_CLI || 'claude',
  outputDir: process.env.OUTPUT_DIR || path.join(__dirname, 'output'),
  errorLogPath: path.join(__dirname, 'error.log'),
};

class MeetingProcessor {
  constructor() {
    this.projectName = null;
    this.projectPath = null;
    this.transcriptPath = null;
  }

  log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level: level.toUpperCase(),
      message,
      ...(data && { data })
    };
    console.log(JSON.stringify(logEntry));
  }

  async logError(error) {
    const timestamp = new Date().toISOString();
    const errorEntry = `[${timestamp}] ${error}\n`;
    await fs.appendFile(CONFIG.errorLogPath, errorEntry);
    this.log('error', error);
  }

  async initialize(transcriptPath, projectName) {
    this.log('info', 'Initializing processor', { transcriptPath, projectName });

    // Validate transcript file exists
    try {
      await fs.access(transcriptPath);
    } catch (error) {
      throw new Error(`Transcript file not found: ${transcriptPath}`);
    }

    this.transcriptPath = path.resolve(transcriptPath);
    this.projectName = projectName;
    this.projectPath = path.join(__dirname, 'projects', projectName);

    this.log('info', 'Initialization complete');
  }

  async setupProjectStructure() {
    this.log('info', 'Setting up project structure');

    const dirs = [
      this.projectPath,
      path.join(this.projectPath, 'transcripts'),
      path.join(this.projectPath, 'analysis'),
      path.join(this.projectPath, 'dashboards', this.getDateString()),
    ];

    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
      this.log('debug', `Created directory: ${dir}`);
    }

    this.log('info', 'Project structure ready');
  }

  async invokeClaude() {
    this.log('info', 'Invoking Claude Code CLI');

    // Ensure output directory exists
    await fs.mkdir(CONFIG.outputDir, { recursive: true });

    const prompt = `Read the instructions in CLAUDE.md and process the meeting transcript.

Transcript file: ${this.transcriptPath}
Project name: ${this.projectName}
Output dashboard to: ${path.join(CONFIG.outputDir, 'index.html')}

Follow the complete workflow defined in CLAUDE.md. At the end, output a single line in this format:
DEPLOYED_URL=<url or none>`;

    return new Promise((resolve, reject) => {
      // Spawn Claude Code CLI in print mode (non-interactive)
      // --print: non-interactive output
      // --permission-mode bypassPermissions: auto-accept all permissions
      // --add-dir: ensure access to workspace, output, and project directories
      const args = [
        '--print',
        '--permission-mode', 'bypassPermissions',
        '--add-dir', __dirname,
        '--add-dir', CONFIG.outputDir,
        '--add-dir', this.projectPath,
        prompt
      ];

      const claude = spawn(CONFIG.claudeCommand, args, {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Ensure trust for workspace
          CLAUDE_WORKSPACE_TRUST: 'true'
        }
      });

      let stdout = '';
      let stderr = '';

      claude.stdout.on('data', (data) => {
        stdout += data.toString();
        process.stdout.write(data);
      });

      claude.stderr.on('data', (data) => {
        stderr += data.toString();
        process.stderr.write(data);
      });

      claude.on('close', async (code) => {
        if (code === 0) {
          this.log('info', 'Claude Code CLI completed successfully');
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

      claude.on('error', async (err) => {
        const error = `Failed to spawn Claude Code CLI: ${err.message}`;
        await this.logError(error);
        reject(new Error(error));
      });
    });
  }

  async checkOutputExists() {
    const outputPath = path.join(CONFIG.outputDir, 'index.html');
    try {
      await fs.access(outputPath);
      this.log('info', 'Dashboard generated successfully', { path: outputPath });
      return outputPath;
    } catch (error) {
      // Also check in project dashboard folder as fallback
      const fallbackPath = path.join(
        this.projectPath,
        'dashboards',
        this.getDateString(),
        'index.html'
      );
      try {
        await fs.access(fallbackPath);
        this.log('info', 'Dashboard found in project folder', { path: fallbackPath });
        return fallbackPath;
      } catch {
        throw new Error(`Dashboard not found at ${outputPath} or ${fallbackPath}`);
      }
    }
  }

  getDateString() {
    const now = new Date();
    return now.toISOString().split('T')[0];
  }

  async process(transcriptPath, projectName) {
    try {
      // Initialize
      await this.initialize(transcriptPath, projectName);

      // Setup project structure
      await this.setupProjectStructure();

      // Invoke Claude Code CLI (non-interactive, auto-accept)
      // Claude will handle: analysis, consolidation, dashboard generation, AND deployment
      const claudeResult = await this.invokeClaude();

      // Check if output exists
      const dashboardPath = await this.checkOutputExists();

      this.log('info', 'Processing complete', { 
        project: this.projectName,
        dashboardPath,
        deployedUrl: claudeResult.deployedUrl || 'not deployed'
      });

      return { 
        success: true, 
        dashboardPath,
        deployedUrl: claudeResult.deployedUrl
      };
    } catch (error) {
      await this.logError(`Processing failed: ${error.message}\n${error.stack}`);
      throw error;
    }
  }
}

// Main execution
async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.error('Usage: node processor.js <transcript-file-path> <project-name>');
    console.error('Example: node processor.js ./transcripts/meeting.vtt yakshaver');
    process.exit(1);
  }

  const [transcriptPath, projectName] = args;

  const processor = new MeetingProcessor();

  try {
    const result = await processor.process(transcriptPath, projectName);
    console.log(JSON.stringify({ 
      timestamp: new Date().toISOString(),
      level: 'INFO',
      message: 'SUCCESS: Meeting processing completed',
      dashboardPath: result.dashboardPath,
      deployedUrl: result.deployedUrl || 'not deployed',
      exitCode: 0
    }));
    process.exit(0);
  } catch (error) {
    console.error(JSON.stringify({ 
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      message: 'FAILURE: Meeting processing failed',
      error: error.message,
      exitCode: 1
    }));
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = MeetingProcessor;