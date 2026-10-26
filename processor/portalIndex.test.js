const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { projectsFromBlobs, renderPortalIndex, deployPortalIndex } = require('./portalIndex');

test('portal lists only published project indexes, deduplicated and alphabetical', () => {
  const names = ['index.html', 'beta/index.html', 'alpha/index.html', 'alpha/index.html',
    'orphan/2026-10-26/index.html', 'alpha/2026-10-26/analysis/consolidated.json',
    '../index.html', './index.html', 'assets/logo.svg'];
  assert.deepEqual(projectsFromBlobs(names.map((name) => ({ name }))), [
    { projectName: 'alpha', displayName: 'alpha' }, { projectName: 'beta', displayName: 'beta' },
  ]);
});

test('portal shows decoded display names, sorted by them, falling back to the slug', () => {
  const projects = projectsFromBlobs([
    { name: 'zeta/index.html', metadata: { displayname: encodeURIComponent('Zeta Ångström') } },
    { name: 'yak/index.html', metadata: { displayname: 'YakShaver' } },
    { name: 'broken/index.html', metadata: { displayname: '%E0%A4%A' } },
  ]);
  assert.deepEqual(projects, [
    { projectName: 'broken', displayName: 'broken' },
    { projectName: 'yak', displayName: 'YakShaver' },
    { projectName: 'zeta', displayName: 'Zeta Ångström' },
  ]);
  const html = renderPortalIndex({ template: '{{PROJECT_LIST}}', projects, generatedAt: '' });
  assert.ok(html.includes('href="./yak/"') && html.includes('>YakShaver</h2>'));
});

test('portal renders real template with escaped labels and relative project links', async () => {
  const template = await fs.readFile(path.join(__dirname, '..', 'templates', 'portal-index.html'), 'utf8');
  const html = renderPortalIndex({ template, projects: [
    { projectName: 'Client <A> & "B"' },
  ], generatedAt: '2026-10-26' });
  assert.ok(!html.includes('{{'));
  assert.ok(html.includes('Client &lt;A&gt; &amp; &quot;B&quot;'));
  assert.ok(html.includes('href="./Client%20%3CA%3E%20%26%20%22B%22/"'));
  assert.ok(html.includes('26/10/2026'));
  assert.ok(!html.includes('<details'));
  assert.ok(!html.includes('2026-10-26-123000'));
  assert.ok(!html.includes('href="https://dashboards.'));
  const empty = renderPortalIndex({ template, projects: [], generatedAt: '2026-10-26' });
  assert.ok(empty.includes('No projects yet'));
});

function fakeContainer({ failList = false, conflict = false, missing = false } = {}) {
  let scans = 0;
  const uploads = [];
  return {
    uploads,
    getBlockBlobClient(name) {
      assert.equal(name, 'index.html');
      return {
        async getProperties() {
          if (missing) throw Object.assign(new Error('Missing'), { statusCode: 404 });
          return { etag: `version-${scans}` };
        },
        async upload(html, length, options) {
          assert.equal(length, Buffer.byteLength(html));
          uploads.push({ html, options });
          if (conflict && uploads.length === 1) throw Object.assign(new Error('Conflict'), { statusCode: 412 });
        },
      };
    },
    async *listBlobsFlat(options) {
      assert.equal(options?.includeMetadata, true);
      if (failList) throw new Error('Storage unavailable');
      scans++;
      yield { name: 'alpha/index.html' };
      if (scans > 1) yield { name: 'beta/index.html' };
    },
  };
}

test('portal deployment retries a concurrent update with a fresh listing and ETag', async () => {
  const container = fakeContainer({ conflict: true });
  await deployPortalIndex({ container });
  assert.equal(container.uploads.length, 2);
  const { html, options } = container.uploads[1];
  assert.ok(html.includes('beta'));
  assert.deepEqual(options.conditions, { ifMatch: 'version-1' });
  assert.equal(options.blobHTTPHeaders.blobCacheControl, 'no-cache, max-age=0, must-revalidate');
});

test('first portal deployment creates the root index conditionally', async () => {
  const container = fakeContainer({ missing: true });
  await deployPortalIndex({ container });
  assert.deepEqual(container.uploads[0].options.conditions, { ifNoneMatch: '*' });
});

test('failed storage listing leaves the existing portal untouched', async () => {
  const container = fakeContainer({ failList: true });
  await assert.rejects(deployPortalIndex({ container }), /Storage unavailable/);
  assert.equal(container.uploads.length, 0);
});
