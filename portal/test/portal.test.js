import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { loadConfig, isEmployee, safeReturnTo, reportName } from '../src/config.js';
import { createHandler } from '../src/app.js';
import { SessionStore } from '../src/storage.js';
import { UserStore } from '../src/users.js';
import { memoryContainer, memoryUsers } from './helpers.js';

const require = createRequire(import.meta.url);
const { renderUnlockPage, encryptDashboardHtml } = require('../../lib/dashboardEncryption.js');
const env = { PORTAL_ORIGIN: 'https://portal.test', OIDC_CLIENT_ID: 'tiger-portal', DASHBOARD_STORAGE_ACCOUNT: 'satigertestweb', COSMOS_ENDPOINT: 'https://cosmos.test', PORTAL_EMPLOYEE_SUBJECTS: 'employee-1' };

test('configuration and employee qualification require private storage and a verified exact SSW domain', () => {
  assert.throws(() => loadConfig({ ...env, COSMOS_ENDPOINT: '' }), /COSMOS_ENDPOINT/);
  assert.throws(() => loadConfig({ ...env, DASHBOARD_CONTAINER: '$web' }), /private/);
  assert.throws(() => loadConfig({ ...env, PORTAL_ORIGIN: 'https://portal.test/path' }), /origin/);
  assert.throws(() => loadConfig({ ...env, COSMOS_ENDPOINT: 'http://cosmos.test' }), /HTTPS/);
  for (const email of ['staff@ssw.com.au', 'STAFF@SSW.COM.AU']) {
    assert.equal(isEmployee({ sub: 'staff', email, email_verified: true }), true);
  }
  for (const email of ['staff@ssw.com.au.evil.test', 'staff@sub.ssw.com.au', 'staff@ssw.com.au ', 'staff@other.test']) {
    assert.equal(isEmployee({ sub: 'staff', email, email_verified: true }), false);
  }
  for (const email_verified of [false, undefined, 'true', 1]) {
    assert.equal(isEmployee({ sub: 'employee-1', email: 'staff@ssw.com.au', email_verified }), false);
  }
  assert.equal(isEmployee({ email: 'staff@ssw.com.au', email_verified: true }), false);
});

test('return URLs and blob paths reject external redirects and encoded separators', () => {
  for (const value of ['/.//evil.test/phish', '/%2e//evil.test/x', '/a/..//evil.test/x', '//evil.test', '/\\evil.test', 'https://evil.test', '/auth/login']) assert.equal(safeReturnTo(value), '/');
  assert.equal(safeReturnTo('/CRM/2026-10-27/?tab=people'), '/CRM/2026-10-27/?tab=people');
  assert.equal(reportName('/CRM/index.html'), 'CRM/index.html');
  assert.equal(reportName('/CRM/2026-10-27/'), 'CRM/2026-10-27/index.html');
  assert.equal(reportName('/CRM/%2e%2e/private'), null);
  assert.equal(reportName('/CRM/%2fsecret'), null);
});

test('server sessions expire, login transactions are one-use, logout revokes sessions', async () => {
  const container = memoryContainer(); let now = 1000;
  const store = new SessionStore(container, () => now);
  const login = await store.create('login', { verifier: 'secret' }, 600);
  assert.equal((await store.read(login, 'login', true)).verifier, 'secret');
  assert.equal(await store.read(login, 'login', true), null);
  const id = await store.create('session', { user: { sub: 'employee-1' } }, 10);
  assert.ok(await store.read(id, 'session'));
  now += 10001;
  assert.equal(await store.read(id, 'session'), null);
  const active = await store.create('session', {}, 100);
  await store.remove(active, 'session');
  assert.equal(await store.read(active, 'session'), null);
  assert.equal(await store.read('../anything', 'session'), null);
});

test('Portal login, all projects, password report passthrough, legacy redirect and logout', async t => {
  const config = loadConfig(env);
  const sessions = new SessionStore(memoryContainer());
  const users = new UserStore(memoryUsers(), config.issuer);
  const unlock = renderUnlockPage({ projectName: 'crm', meetingId: '2026-10-27', encryptedPayload: encryptDashboardHtml('<h1>Private report</h1>', 'password') });
  const documents = { 'crm/index.html': '<a href="./2026-10-27/">Meeting</a>', 'crm/2026-10-27/index.html': unlock };
  let readCount = 0;
  const reports = {
    async *listBlobsFlat({ prefix = '' } = {}) {
      const blobs = [
        { name: 'crm/index.html', metadata: { displayname: 'CRM%20Team' } },
        ...['2026-10-27', '2026-10-20-sprint-review', '2026-10-13-094557', '2026-09-29'].map(id => ({ name: `crm/${id}/index.html` })),
        { name: 'crm/2026-10-27/analysis/consolidated.json' },
        { name: 'empty/index.html' },
      ];
      yield* blobs.filter(blob => blob.name.startsWith(prefix));
    },
    getBlockBlobClient(name) {
      return {
        async getProperties() {
          if (!(name in documents)) throw Object.assign(new Error('missing'), { statusCode: 404 });
          return { metadata: { displayname: 'CRM%20Team' }, contentType: 'text/html' };
        },
        async download() {
          readCount++;
          if (!(name in documents)) throw Object.assign(new Error('missing'), { statusCode: 404 });
          return { contentType: 'text/html; charset=utf-8', readableStreamBody: Readable.from([documents[name]]) };
        },
      };
    },
  };
  let employee = true;
  let authUnavailable = true;
  let authCalls = 0;
  const auth = {
    async revoke() {},
    async begin() {
      authCalls++;
      if (authUnavailable) throw new Error('Identity unavailable');
      return { url: 'https://identity.test/connect/authorize', transaction: { state: 'state', verifier: 'verifier', nonce: 'nonce' } };
    },
    async finish(url, transaction) {
      assert.equal(transaction.verifier, 'verifier');
      assert.equal(url.origin, config.origin);
      return { claims: { sub: employee ? 'employee-1' : 'outsider', name: '<SSW User>', email: employee ? 'staff@ssw.com.au' : 'outsider@example.com', email_verified: true }, idToken: 'not-exposed-to-browser', accessToken: 'access-token', refreshToken: 'refresh-token', accessTokenExpiresAt: Date.now() + 3600000 };
    },
    logout() { return 'https://identity.test/connect/endsession'; },
  };
  const meetings = { items: { query: () => ({ fetchAll: async () => ({ resources: [{ projectName: 'crm', meetingId: '2026-10-27', metadata: { participantCount: 6 } }] }) }) } };
  const server = createServer(createHandler({ config, sessions, reports, users, auth, meetings, logger: { error() {} } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options = {}) => new Promise((resolve, reject) => {
    const call = httpRequest(`${origin}${path}`, { method: options.method || 'GET', headers: { Host: 'portal.test', ...options.headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(key, item);
        }
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
    });
    call.on('error', reject); call.end(options.body);
  });
  for (const path of ['/', '/index.html']) {
    const entry = await request(path);
    assert.equal(entry.status, 302);
    assert.equal(entry.headers.get('location'), `/auth/login?returnTo=${encodeURIComponent(path)}`);
  }
  assert.equal(authCalls, 0);
  assert.equal(readCount, 0);
  assert.equal((await request('/', { method: 'HEAD' })).status, 302);
  assert.equal((await request('/auth/login?returnTo=%2F')).status, 503);
  assert.equal(authCalls, 1);
  authUnavailable = false;
  const initial = await request('/crm/2026-10-27/?tab=people');
  assert.equal(initial.status, 302);
  assert.match(initial.headers.get('location'), /returnTo=/);
  assert.equal(readCount, 0);
  const unauthApi = await request('/api/me'); assert.equal(unauthApi.status, 401);
  const spoof = await request('/api/me', { headers: { 'x-ms-client-principal': 'fake-employee' } }); assert.equal(spoof.status, 401);
  const legacy = await request('/crm/2026-10-27/?tab=people', { headers: { Host: 'dashboards.sswtiger.com' } });
  assert.equal(legacy.status, 308);
  assert.equal(legacy.headers.get('location'), 'https://portal.test/crm/2026-10-27/?tab=people');
  const badHost = await request('/', { headers: { Host: 'attacker.test' } }); assert.equal(badHost.status, 421);
  const login = await request('/auth/login?returnTo=%2Fcrm%2F2026-10-27%2F');
  assert.equal(login.status, 302);
  assert.equal(login.headers.get('location'), 'https://identity.test/connect/authorize');
  const txCookie = login.headers.getSetCookie()[0].split(';')[0];
  assert.match(login.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Lax/);
  const callback = await request('/auth/callback?code=code&state=state', { headers: { Cookie: txCookie } });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/crm/2026-10-27/');
  const sessionCookie = callback.headers.getSetCookie().find(v => v.startsWith('__Host-tiger_session=')).split(';')[0];
  const replay = await request('/auth/callback?code=code', { headers: { Cookie: txCookie } }); assert.equal(replay.status, 400);
  const root = await request('/', { headers: { Cookie: sessionCookie } });
  assert.equal(root.status, 200);
  const rootHtml = await root.text();
  assert.doesNotMatch(rootHtml, /Sign in with SSW/);
  assert.match(rootHtml, /CRM Team/); assert.match(rootHtml, /&lt;SSW User&gt;/);
  assert.ok(!rootHtml.includes('not-exposed-to-browser'));
  assert.equal(rootHtml.match(/class="meeting"/g).length, 3);
  assert.match(rootHtml, /4 meetings · <a class="view-all" href="\/crm\/">View all/);
  assert.doesNotMatch(rootHtml, /2026-09-29|empty/);
  for (const path of ['/crm/', '/crm/index.html']) {
    const project = await request(path, { headers: { Cookie: sessionCookie } });
    assert.equal(project.status, 200);
    const body = await project.text();
    assert.match(body, /class="breadcrumb"/);
    assert.match(body, /CRM Team/);
    assert.match(body, /6 people/);
    assert.match(body, /Meeting Dashboards/);
    assert.match(body, /&lt;SSW User&gt;/);
    assert.equal(body.match(/class="meeting"/g).length, 4);
    assert.doesNotMatch(body, /<a href="\.\/2026-10-27\/">Meeting<\/a>/);
    const head = await request(path, { method: 'HEAD', headers: { Cookie: sessionCookie } });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  }
  assert.equal(readCount, 0);
  const canonical = await request('/crm?tab=all', { headers: { Cookie: sessionCookie } });
  assert.equal(canonical.headers.get('location'), '/crm/?tab=all');
  const publishedIndex = documents['crm/index.html'];
  delete documents['crm/index.html'];
  const projectHtml = await (await request('/crm/', { headers: { Cookie: sessionCookie } })).text();
  assert.equal(projectHtml.match(/class="meeting"/g).length, 4);
  assert.match(projectHtml, /27\/10\/2026[\s\S]*Sprint Review[\s\S]*09:45[\s\S]*29\/09\/2026/);
  assert.equal((await request('/crm/', { method: 'HEAD', headers: { Cookie: sessionCookie } })).status, 200);
  assert.equal(await (await request('/crm/index.html', { headers: { Cookie: sessionCookie } })).text(), projectHtml);
  documents['crm/index.html'] = publishedIndex;
  const me = await request('/api/me', { headers: { Cookie: sessionCookie } });
  assert.deepEqual((await me.json()).roles, ['User']);
  const otherIssuer = await sessions.create('session', { issuer: 'https://other-identity.test', user: { sub: 'employee-1' } }, 600);
  assert.equal((await request('/api/me', { headers: { Cookie: `__Host-tiger_session=${otherIssuer}` } })).status, 401);
  const protectedReport = await request('/crm/2026-10-27/', { headers: { Cookie: sessionCookie } });
  assert.equal(await protectedReport.text(), unlock);
  assert.equal(protectedReport.headers.get('content-security-policy'), 'sandbox allow-scripts allow-popups allow-forms');
  const reportHead = await request('/crm/2026-10-27/', { method: 'HEAD', headers: { Cookie: sessionCookie } });
  assert.equal(reportHead.headers.get('content-security-policy'), 'sandbox allow-scripts allow-popups allow-forms');
  assert.equal(await reportHead.text(), '');
  assert.equal(root.headers.get('content-security-policy'), null);
  assert.equal(protectedReport.headers.get('cache-control'), 'private, no-store');
  const missing = await request('/crm/missing/', { headers: { Cookie: sessionCookie } }); assert.equal(missing.status, 404);
  const csrf = (await sessions.read(sessionCookie.split('=')[1], 'session')).csrf;
  const rejected = await request('/auth/logout', { method: 'POST', headers: { Cookie: sessionCookie, Origin: config.origin }, body: 'csrf=wrong' }); assert.equal(rejected.status, 403);
  assert.match(rootHtml, /href="\/auth\/logout"/);
  const logout = await request('/auth/logout', { headers: { Cookie: sessionCookie } });
  assert.equal(logout.status, 302);
  assert.equal(logout.headers.get('location'), 'https://identity.test/connect/endsession');
  assert.match(logout.headers.get('set-cookie'), /__Host-tiger_session=;.*Max-Age=0/);
  const repeatedLogout = await request('/auth/logout', { headers: { Cookie: sessionCookie } });
  assert.equal(repeatedLogout.status, 302);
  assert.equal(repeatedLogout.headers.get('location'), 'https://portal.test/');
  const oldSignedOut = await request('/signed-out');
  assert.equal(oldSignedOut.status, 302);
  assert.equal(oldSignedOut.headers.get('location'), '/');
  const revoked = await request('/api/me', { headers: { Cookie: sessionCookie } }); assert.equal(revoked.status, 401);
  const signedOutRoot = await request('/', { headers: { Cookie: sessionCookie } });
  assert.equal(signedOutRoot.status, 302);
  assert.equal(signedOutRoot.headers.get('location'), '/auth/login?returnTo=%2F');
  employee = false;
  const outsiderLogin = await request('/auth/login');
  const outsiderCookie = outsiderLogin.headers.getSetCookie()[0].split(';')[0];
  const outsider = await request('/auth/callback?code=code&state=state', { headers: { Cookie: outsiderCookie } }); assert.equal(outsider.status, 403);
  assert.ok(!outsider.headers.getSetCookie().some(v => v.startsWith('__Host-tiger_session=')));
});
