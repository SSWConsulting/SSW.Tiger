#!/usr/bin/env node

/**
 * Quick test of the processor wrapper
 * Validates that all components are properly set up
 */

const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');

async function testEnvironment() {
  console.log('🧪 Testing Processor Environment\n');

  const tests = {
    'CLAUDE.md exists': async () => {
      await fs.access(path.join(__dirname, 'CLAUDE.md'));
      return true;
    },
    'Templates directory exists': async () => {
      await fs.access(path.join(__dirname, 'templates'));
      return true;
    },
    '.claude/agents directory exists': async () => {
      await fs.access(path.join(__dirname, '.claude', 'agents'));
      return true;
    },
    'Claude CLI available': () => {
      return new Promise((resolve) => {
        const claude = spawn('claude', ['--version'], { stdio: 'ignore' });
        claude.on('close', (code) => resolve(code === 0));
        claude.on('error', () => resolve(false));
      });
    },
    'Surge CLI available': () => {
      return new Promise((resolve) => {
        const surge = spawn('surge', ['--version'], { stdio: 'ignore' });
        surge.on('close', (code) => resolve(code === 0));
        surge.on('error', () => resolve(false));
      });
    },
    'ANTHROPIC_API_KEY set': () => {
      return Promise.resolve(!!process.env.ANTHROPIC_API_KEY);
    },
    'SURGE_LOGIN set': () => {
      return Promise.resolve(!!process.env.SURGE_LOGIN);
    },
    'SURGE_TOKEN set': () => {
      return Promise.resolve(!!process.env.SURGE_TOKEN);
    },
  };

  let passed = 0;
  let failed = 0;

  for (const [name, test] of Object.entries(tests)) {
    try {
      const result = await test();
      if (result) {
        console.log(`✅ ${name}`);
        passed++;
      } else {
        console.log(`❌ ${name}`);
        failed++;
      }
    } catch (error) {
      console.log(`❌ ${name}: ${error.message}`);
      failed++;
    }
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log('\n⚠️  Some tests failed. Please fix before running processor.');
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed! Ready to process transcripts.');
    process.exit(0);
  }
}

testEnvironment();
