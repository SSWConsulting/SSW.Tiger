#!/usr/bin/env node

/**
 * Test script to debug Claude CLI spawn issue
 */

const { spawn } = require('child_process');

console.log('Testing Claude CLI spawn...\n');

const prompt = 'Say "TEST SUCCESSFUL" in exactly those two words';

console.log('Test 1: Spawn with shell (PowerShell)');
console.log('========================================\n');

const test1 = spawn('claude', ['--print'], {
  shell: 'powershell.exe',
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env
});

console.log('Spawned with shell, writing prompt...');
test1.stdin.write(prompt);
test1.stdin.end();
console.log('Prompt written, stdin closed.\n');

test1.stdout.on('data', (data) => {
  console.log('[STDOUT]:', data.toString());
});

test1.stderr.on('data', (data) => {
  console.error('[STDERR]:', data.toString());
});

test1.on('close', (code) => {
  console.log(`\nTest 1 completed with exit code: ${code}\n`);

  // Run test 2
  console.log('Test 2: Spawn without shell (.cmd direct)');
  console.log('==========================================\n');

  const test2 = spawn('claude.cmd', ['--print'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env
  });

  console.log('Spawned without shell, writing prompt...');
  test2.stdin.write(prompt);
  test2.stdin.end();
  console.log('Prompt written, stdin closed.\n');

  test2.stdout.on('data', (data) => {
    console.log('[STDOUT]:', data.toString());
  });

  test2.stderr.on('data', (data) => {
    console.error('[STDERR]:', data.toString());
  });

  test2.on('close', (code) => {
    console.log(`\nTest 2 completed with exit code: ${code}\n`);
  });

  test2.on('error', (err) => {
    console.error('Test 2 spawn error:', err.message);
  });

  setTimeout(() => {
    console.log('\n[TIMEOUT] Test 2 did not complete in 20 seconds');
    test2.kill();
    process.exit(1);
  }, 20000);
});

test1.on('error', (err) => {
  console.error('Test 1 spawn error:', err.message);
});

setTimeout(() => {
  console.log('\n[TIMEOUT] Test 1 did not complete in 20 seconds');
  test1.kill();
  process.exit(1);
}, 20000);
