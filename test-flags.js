#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

const prompt = 'Say "TEST SUCCESSFUL" in exactly two words';
const workdir = __dirname;
const outputDir = path.join(__dirname, 'output');
const projectPath = path.join(__dirname, 'projects', 'yakshaver');

const args = [
  '--print',
  '--permission-mode', 'bypassPermissions',
  '--add-dir', workdir,
  '--add-dir', outputDir,
  '--add-dir', projectPath
];

console.log('Testing Claude CLI with processor flags...\n');
console.log('Args:', args.join(' '), '\n');

const claude = spawn('claude', args, {
  shell: 'powershell.exe',
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    CLAUDE_WORKSPACE_TRUST: 'true'
  },
  cwd: workdir
});

console.log('Spawned, writing prompt...');
claude.stdin.write(prompt);
claude.stdin.end();
console.log('Stdin closed, waiting...\n');

let gotOutput = false;

claude.stdout.on('data', (data) => {
  gotOutput = true;
  console.log('[STDOUT]:', data.toString());
});

claude.stderr.on('data', (data) => {
  console.error('[STDERR]:', data.toString());
});

claude.on('close', (code) => {
  console.log(`\nExited with code: ${code}`);
  if (gotOutput) {
    console.log('✓ SUCCESS - Got output from Claude');
  } else {
    console.log('✗ FAIL - No output received');
  }
});

claude.on('error', (err) => {
  console.error('Spawn error:', err.message);
});

setTimeout(() => {
  console.log('\n[TIMEOUT] No response after 20 seconds - killing process');
  claude.kill('SIGTERM');
  setTimeout(() => {
    console.log('[FORCE KILL]');
    claude.kill('SIGKILL');
    process.exit(1);
  }, 2000);
}, 20000);
