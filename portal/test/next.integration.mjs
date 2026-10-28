import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createNextRenderer } from '../src/nextRenderer.js';
import { UserStore } from '../src/users.js';
import { SessionStore } from '../src/storage.js';
import { memoryContainer, memoryUsers, serve } from './helpers.js';

// Uses the real built Next.js app with in-memory storage to cover the framework/authorization boundary.
test('production Next.js pages preserve access checks, report passthrough and private data boundaries', async t => {
  const config = loadConfig({ PORTAL_ORIGIN: 'https://portal.test', OIDC_CLIENT_ID: 'tiger-portal',
    DASHBOARD_STORAGE_ACCOUNT: 'satigertestweb', COSMOS_ENDPOINT: 'https://cosmos.test' });
  const renderer = await createNextRenderer();
  t.after(() => renderer.close());
  const container = memoryUsers();
  const users = new UserStore(container, config.issuer);
  const user = await users.register({ sub: 'staff', email: 'staff@ssw.com.au', email_verified: true, name: '<Staff>' });
  const sessions = new SessionStore(memoryContainer());
  const id = await sessions.create('session', { issuer: config.issuer, user,
    accessToken: 'private-access-secret', refreshToken: 'private-refresh-secret', accessTokenExpiresAt: Date.now() + 3600000 }, 600);
  const headers = { Cookie: `__Host-tiger_session=${id}` };
  const reportBody = '<html><body>Password-protected report fixture</body></html>';
  const reports = {
    async *listBlobsFlat() {
      yield { name: 'demo/2026-10-28-100000/index.html', metadata: { displayname: 'Demo%20Project' } };
    },
    getBlockBlobClient() { return { async download() {
      return { contentType: 'text/html', readableStreamBody: Readable.from([reportBody]) };
    } }; },
  };
  const request = await serve(t, createHandler({ config, users, sessions, reports, ...renderer }));
  for (const path of ['/', '/demo/', '/demo/index.html', '/_next/data/arbitrary/index.json']) {
    assert.equal((await request(path)).status, 302);
  }
  let rootHtml;
  for (const path of ['/', '/index.html', '/demo/', '/demo/index.html']) {
    const response = await request(path, { headers });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /private.*no-store/);
    const html = await response.text();
    assert.match(html, /Demo Project/);
    assert.match(html, /&lt;Staff&gt;/);
    assert.match(html, /__NEXT_DATA__/);
    assert.doesNotMatch(html, /private-access-secret|private-refresh-secret|accessToken|refreshToken/);
    if (path === '/') rootHtml = html;
  }
  const head = await request('/demo/', { method: 'HEAD', headers });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  // Build assets need no sign-in but still pass the host check; data routes are never handed to Next.js.
  const asset = rootHtml.match(/src="([^" ]*\/_next\/static\/[^" ]+\.js)"/)[1];
  assert.equal((await request(asset)).status, 200);
  assert.equal((await request(asset, { headers: { Host: 'evil.test' } })).status, 421);
  assert.equal(await (await request('/demo/2026-10-28-100000/', { headers })).text(), reportBody);
  const legacy = await request('/demo/?tab=all', { headers: { Host: 'dashboards.sswtiger.com' } });
  assert.equal(legacy.status, 308);
  assert.equal(legacy.headers.get('location'), 'https://portal.test/demo/?tab=all');
  const document = container.documents.get(user.id);
  container.documents.set(user.id, { ...document, isActive: false });
  assert.equal((await request('/', { headers })).status, 403);
  assert.equal((await request('/demo/', { headers })).status, 403);
});
