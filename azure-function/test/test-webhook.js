/**
 * Test script for TranscriptWebhook function
 * Run: node test/test-webhook.js
 *
 * Prerequisites:
 * 1. Start Azurite: azurite --silent
 * 2. Start function: TEST_MODE=true func start
 */

const FUNCTION_URL = 'http://localhost:7071/api/TranscriptWebhook';

async function testValidation() {
  console.log('\n=== Test 1: Webhook Validation ===');

  const response = await fetch(`${FUNCTION_URL}?validationToken=test-token-12345`);
  const body = await response.text();

  console.log(`Status: ${response.status}`);
  console.log(`Body: ${body}`);
  console.log(`Result: ${body === 'test-token-12345' ? '✅ PASS' : '❌ FAIL'}`);
}

async function testMockNotification() {
  console.log('\n=== Test 2: Mock Transcript Notification ===');

  const payload = {
    value: [{
      resourceData: {
        '@odata.type': '#microsoft.graph.callTranscript',
        id: 'test-transcript-id',
        meetingId: 'test-meeting-id',
        meetingOrganizerId: 'test-organizer-id'
      },
      // Custom test data (used in TEST_MODE)
      testData: {
        subject: '[Tiger] Sprint Planning',
        date: '2026-01-26T10:00:00Z'
      }
    }]
  };

  const response = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const result = await response.json();

  console.log(`Status: ${response.status}`);
  console.log(`Response:`, JSON.stringify(result, null, 2));
  console.log(`Result: ${result.results?.[0]?.success ? '✅ PASS' : '❌ FAIL'}`);
}

async function testWithLocalVtt() {
  console.log('\n=== Test 3: With Local VTT File (Sprint meeting) ===');

  const payload = {
    value: [{
      resourceData: {
        '@odata.type': '#microsoft.graph.callTranscript',
        id: 'test-transcript-id',
        meetingId: 'test-meeting-id',
        meetingOrganizerId: 'test-organizer-id'
      },
      testData: {
        subject: '[YakShaver] Sprint Review',
        date: '2026-01-26T09:00:00Z',
        // Point to a local VTT file (optional)
        // vttPath: '../dropzone/2026-01-21.vtt'
      }
    }]
  };

  const response = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const result = await response.json();

  console.log(`Status: ${response.status}`);
  console.log(`Response:`, JSON.stringify(result, null, 2));

  if (result.results?.[0]?.success) {
    console.log(`\n📁 Blob uploaded to: ${result.results[0].blobPath}`);
    console.log(`   Project: ${result.results[0].projectName}`);
    console.log(`   Filename: ${result.results[0].filename}`);
  }
}

async function testNonSprintMeeting() {
  console.log('\n=== Test 4: Non-Sprint Meeting (should skip) ===');

  const payload = {
    value: [{
      resourceData: {
        '@odata.type': '#microsoft.graph.callTranscript',
        id: 'test-transcript-id',
        meetingId: 'test-meeting-id',
        meetingOrganizerId: 'test-organizer-id'
      },
      testData: {
        subject: '[Tiger] Daily Standup',
        date: '2026-01-26T09:00:00Z'
      }
    }]
  };

  const response = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const result = await response.json();

  console.log(`Status: ${response.status}`);
  console.log(`Response:`, JSON.stringify(result, null, 2));
  console.log(`Result: ${result.results?.[0]?.skipped ? '✅ PASS (skipped as expected)' : '❌ FAIL'}`);
}

async function testNonTranscriptNotification() {
  console.log('\n=== Test 5: Non-Transcript Notification (should skip) ===');

  const payload = {
    value: [{
      resourceData: {
        '@odata.type': '#microsoft.graph.chatMessage',
        id: 'some-message-id'
      }
    }]
  };

  const response = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const result = await response.json();

  console.log(`Status: ${response.status}`);
  console.log(`Response:`, JSON.stringify(result, null, 2));
  console.log(`Result: ${result.results?.[0]?.skipped ? '✅ PASS (skipped as expected)' : '❌ FAIL'}`);
}

async function testProjectNameExtraction() {
  console.log('\n=== Test 6: Project Name Extraction ===');

  const { extractProjectName } = require('../src/functions/TranscriptWebhook');

  const testCases = [
    // Bracket format: [Project] Title
    { input: '[YakShaver] Sprint Review', expected: 'yakshaver' },
    { input: '[Tiger] Daily Standup', expected: 'tiger' },
    { input: '[My Project] Planning', expected: 'my-project' },
    // Dash format: Project - Title
    { input: 'YakShaver - Sprint Review', expected: 'yakshaver' },
    { input: 'Tiger - Daily Standup', expected: 'tiger' },
    { input: 'My Project - Planning Session', expected: 'my-project' },
    // Colon format: Project: Title
    { input: 'YakShaver: Sprint Review', expected: 'yakshaver' },
    { input: 'Tiger: Daily Standup', expected: 'tiger' },
    { input: 'My Project: Planning Session', expected: 'my-project' },
    // No project prefix - fallback to 'general'
    { input: 'No Bracket Meeting', expected: 'general' },
    { input: 'This is a long meeting name without any prefix', expected: 'general' },
    { input: null, expected: 'general' },
  ];

  let passed = 0;
  for (const { input, expected } of testCases) {
    const result = extractProjectName(input);
    const status = result === expected ? '✅' : '❌';
    console.log(`  ${status} "${input}" → "${result}" (expected: "${expected}")`);
    if (result === expected) passed++;
  }

  console.log(`Result: ${passed}/${testCases.length} passed`);
}

async function testFilenameGeneration() {
  console.log('\n=== Test 7: Filename Generation ===');

  const { generateFilename } = require('../src/functions/TranscriptWebhook');

  const testCases = [
    // Bracket format
    {
      input: { subject: '[YakShaver] Sprint Review', startDateTime: '2026-01-23T10:00:00Z' },
      expected: '2026-01-23-sprint-review.vtt'
    },
    {
      input: { subject: '[Tiger] Daily Standup', startDateTime: '2026-01-26T09:00:00Z' },
      expected: '2026-01-26-daily-standup.vtt'
    },
    // Dash format
    {
      input: { subject: 'YakShaver - Sprint Review', startDateTime: '2026-01-23T10:00:00Z' },
      expected: '2026-01-23-sprint-review.vtt'
    },
    {
      input: { subject: 'Tiger - Daily Standup', startDateTime: '2026-01-26T09:00:00Z' },
      expected: '2026-01-26-daily-standup.vtt'
    },
    // Colon format
    {
      input: { subject: 'YakShaver: Sprint Review', startDateTime: '2026-01-23T10:00:00Z' },
      expected: '2026-01-23-sprint-review.vtt'
    },
    {
      input: { subject: 'Tiger: Daily Standup', startDateTime: '2026-01-26T09:00:00Z' },
      expected: '2026-01-26-daily-standup.vtt'
    },
    // No prefix
    {
      input: { subject: 'Quick Chat', startDateTime: '2026-01-26T15:00:00Z' },
      expected: '2026-01-26-quick-chat.vtt'
    },
  ];

  let passed = 0;
  for (const { input, expected } of testCases) {
    const result = generateFilename(input);
    const status = result === expected ? '✅' : '❌';
    console.log(`  ${status} "${input.subject}" → "${result}" (expected: "${expected}")`);
    if (result === expected) passed++;
  }

  console.log(`Result: ${passed}/${testCases.length} passed`);
}

// Run all tests
async function runTests() {
  console.log('🧪 TranscriptWebhook Test Suite');
  console.log('================================');

  // Unit tests (no server needed)
  testProjectNameExtraction();
  testFilenameGeneration();

  // Integration tests (need func start)
  console.log('\n📡 Integration Tests (require func start with TEST_MODE=true)');

  try {
    await testValidation();
    await testMockNotification();
    await testWithLocalVtt();
    await testNonSprintMeeting();
    await testNonTranscriptNotification();
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') {
      console.log('\n⚠️  Function not running. Start it with:');
      console.log('   cd azure-function');
      console.log('   TEST_MODE=true func start');
    } else {
      console.error('Error:', error.message);
    }
  }

  console.log('\n================================');
  console.log('Tests complete!');
}

runTests();
