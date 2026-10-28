const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { ensureDashboardInitialClasses } = require('./dashboardPresentation');
const { encryptDashboardHtml, renderUnlockPage } = require('./dashboardEncryption');

test('repair leaves encrypted reports and unrelated markup byte-for-byte unchanged', () => {
  const protectedHtml = renderUnlockPage({ projectName: 'test', encryptedPayload: encryptDashboardHtml('<p>\u4f1a\u8bae</p>', 'test-password') });
  for (const html of [protectedHtml, '<button :class="active ? \'custom\' : \'other\'">\u4f1a\u8bae</button>', '<p>Historic report</p>']) {
    assert.equal(ensureDashboardInitialClasses(html), html);
  }
});

test('repair keeps interactive bindings and existing static classes intact', () => {
  const html = `<button title="Timeline" :class="activeTab === 'timeline' ? 'ds-navitem ds-navitem--active' : 'ds-navitem'">Timeline</button>`;
  const repaired = ensureDashboardInitialClasses(html);
  assert.ok(repaired.includes('class="ds-navitem"'));
  assert.ok(repaired.includes(html.slice(html.indexOf(':class='))));
  assert.equal(ensureDashboardInitialClasses(repaired), repaired);
  const custom = html.replace('<button ', '<button class="custom" ');
  assert.equal(ensureDashboardInitialClasses(custom), custom);
});

test('dashboard template defines layout and icon-sizing classes before Alpine starts', () => {
  const html = readFileSync(require.resolve('../templates/dashboard.html'), 'utf8');
  const tags = html.match(/<(?:div|button)\b[^>]*:class="[^"]*ds-(?:shell|navitem|topnav-item)[^"]*"[^>]*>/g);
  assert.equal(tags.length, 11);
  for (const tag of tags) assert.match(tag, /\sclass="ds-(?:shell|navitem|topnav-item)"/);
  assert.equal(ensureDashboardInitialClasses(html), html);
});
