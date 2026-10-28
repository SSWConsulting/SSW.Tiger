const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dashboardUrl } = require('./dashboardUrl');

test('dashboard URLs support old and new hosts and HTTPS input', () => {
  for (const host of ['dashboards.sswtiger.com', 'portal.sswtiger.com']) {
    for (const base of [host, `https://${host}/`]) {
      assert.equal(dashboardUrl(base, ['my project', '2026-10-26']), `https://${host}/my%20project/2026-10-26`);
      assert.equal(dashboardUrl(base), `https://${host}/`);
    }
  }
});

test('dashboard URLs reject malformed configuration', () => {
  for (const base of ['', 'http://portal.sswtiger.com', 'portal.sswtiger.com/path',
    'https://user:pass@portal.sswtiger.com', 'portal.sswtiger.com?x=y', 'portal.sswtiger.com#x']) {
    assert.throws(() => dashboardUrl(base));
  }
});
