#!/usr/bin/env node
// Wrapper script to run the authentication test
const { spawn } = require('child_process');

console.log('Running Claude authentication test...\n');

const test = spawn('bash', ['/app/test-claude-auth.sh'], {
  stdio: 'inherit',
  env: process.env
});

test.on('close', (code) => {
  process.exit(code);
});
