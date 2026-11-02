const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const {
  shortProjectName,
  parseIsoDate,
  formatDashboardTitle,
  extractHeaderProjectName,
  applyDashboardTitle,
} = require('./dashboardTitle');

test('shortProjectName strips every form of the SSW prefix', () => {
  // Display names seen on dashboards.sswtiger.com (Nov 2026), plus separator variants
  const cases = [
    ['SSW TV', 'TV'],
    ['SSW.TV', 'TV'],
    ['SSW.AI', 'AI'],
    ['SSW AI', 'AI'],
    ['SSW.CRM', 'CRM'],
    ['SSW CRM', 'CRM'],
    ['ssw-crm', 'crm'],
    ['SSW EagleEye', 'EagleEye'],
    ['SSW Eagle Eye', 'Eagle Eye'],
    ['SSW EagleEye Sprint 96', 'EagleEye Sprint 96'],
    ['SSW TimePro', 'TimePro'],
    ['SSW Marketing Team', 'Marketing Team'],
    ['SSW.YakShaver', 'YakShaver'],
    ['SSW.Tiger', 'Tiger'],
    ['SSW_Tiger', 'Tiger'],
    ['SSW - TV', 'TV'],
    ['SSW – TV', 'TV'],
    ['SSW. TV', 'TV'],
    ['  SSW TV  ', 'TV'],
    ['YakShaver', 'YakShaver'],
    ['TinaCloud/TinaCMS', 'TinaCloud/TinaCMS'],
    ['TinaCloud / TinaCMS', 'TinaCloud / TinaCMS'],
    ['TimePro', 'TimePro'],
    ['general', 'general'],
    ['SSWeb', 'SSWeb'],
    ['SSW', 'SSW'],
    ['SSW - ', 'SSW -'],
    ['My SSW Project', 'My SSW Project'],
    ['', ''],
    [null, ''],
  ];
  for (const [input, expected] of cases) {
    assert.equal(shortProjectName(input), expected, `shortProjectName(${JSON.stringify(input)})`);
  }
});

test('parseIsoDate gives the real weekday regardless of timezone', () => {
  assert.equal(parseIsoDate('2026-10-09').weekday, 'Fri');
  assert.equal(parseIsoDate('2026-05-25').weekday, 'Mon');
  assert.equal(parseIsoDate('2026-11-02').weekday, 'Mon');
  assert.equal(parseIsoDate('2028-02-29').weekday, 'Tue');
  assert.equal(parseIsoDate('2026-10-09-141645').day, '09');
  assert.equal(parseIsoDate('2026-02-30'), null);
  assert.equal(parseIsoDate('09/10/2026'), null);
  assert.equal(parseIsoDate(undefined), null);
});

test('formatDashboardTitle matches the requested format', () => {
  assert.equal(formatDashboardTitle('SSW TV', '2026-10-09'), 'SSW Tiger - TV - Meeting Dashboard (Fri 09/10/2026)');
  assert.equal(formatDashboardTitle('YakShaver', '2026-10-26'), 'SSW Tiger - YakShaver - Meeting Dashboard (Mon 26/10/2026)');
  assert.equal(formatDashboardTitle('SSW.YakShaver', '2026-10-26'), 'SSW Tiger - YakShaver - Meeting Dashboard (Mon 26/10/2026)');
  assert.equal(formatDashboardTitle('SSW TV', 'not-a-date'), 'SSW Tiger - TV - Meeting Dashboard');
  assert.equal(formatDashboardTitle('', '2026-10-09'), 'SSW Tiger - Meeting - Meeting Dashboard (Fri 09/10/2026)');
});

const page = (h1, title = '{{DASHBOARD_TITLE}}') => `<!DOCTYPE html>
<html><head>
    <title>${title}</title>
</head><body>
<svg><title>SSW</title></svg>
<h1 class="text-2xl"><span class="font-extrabold">${h1}</span></h1>
</body></html>`;

test('applyDashboardTitle uses the header project name and leaves SVG titles alone', () => {
  const html = applyDashboardTitle(page('SSW TV'), { fallbackProjectName: 'SSW TV', meetingDate: '2026-10-09' });
  assert.match(html, /<title>SSW Tiger - TV - Meeting Dashboard \(Fri 09\/10\/2026\)<\/title>/);
  assert.match(html, /<svg><title>SSW<\/title><\/svg>/);
});

test('applyDashboardTitle follows the name the model chose for general meetings', () => {
  const html = applyDashboardTitle(page('SSW TimePro'), { fallbackProjectName: 'general', meetingDate: '2026-10-09' });
  assert.match(html, /<title>SSW Tiger - TimePro - Meeting Dashboard \(Fri 09\/10\/2026\)<\/title>/);
});

test('applyDashboardTitle overwrites a wrong weekday and escapes the name', () => {
  const wrong = page('Tom &amp; Jerry', 'SSW Eagle Eye - Meeting Dashboard (SUN 25/05/2026)');
  const html = applyDashboardTitle(wrong, { fallbackProjectName: 'x', meetingDate: '2026-05-25' });
  assert.match(html, /<title>SSW Tiger - Tom &amp; Jerry - Meeting Dashboard \(Mon 25\/05\/2026\)<\/title>/);
});

test('applyDashboardTitle falls back to the display name when the header is missing or unfilled', () => {
  for (const h1 of ['{{PROJECT_NAME}}', '']) {
    const html = applyDashboardTitle(page(h1), { fallbackProjectName: 'SSW.YakShaver', meetingDate: '2026-10-09' });
    assert.match(html, /<title>SSW Tiger - YakShaver - Meeting Dashboard \(Fri 09\/10\/2026\)<\/title>/);
  }
  assert.equal(extractHeaderProjectName('<p>no header</p>'), '');
});

test('dashboard template exposes the title placeholder and the header the title is read from', () => {
  const html = readFileSync(require.resolve('../templates/dashboard.html'), 'utf8');
  assert.match(html, /<title>\{\{DASHBOARD_TITLE\}\}<\/title>/);
  assert.equal(extractHeaderProjectName(html.replace('{{PROJECT_NAME}}', 'SSW TV')), 'SSW TV');
});
