import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { loadConfig, isEmployee, safeReturnTo, reportName } from '../src/config.js';
import { createHandler } from '../src/app.js';
import { SessionStore } from '../src/storage.js';

const require = createRequire(import.meta.url);
const { renderUnlockPage, encryptDashboardHtml } = require('../../lib/dashboardEncryption.js');
const env = { PORTAL_ORIGIN: 'https://portal.test', OIDC_CLIENT_ID: 'tiger', OIDC_CLIENT_SECRET: 'test-only', DASHBOARD_STORAGE_ACCOUNT: 'satigertestweb', PORTAL_EMPLOYEE_SUBJECTS: 'employee-1' };

test('configuration fails closed without employee verification and private storage', () => {
  assert.throws(() => loadConfig({ ...env, PORTAL_EMPLOYEE_SUBJECTS: '' }), /EMPLOYEE/);
  assert.throws(() => loadConfig({ ...env, DASHBOARD_CONTAINER: '$web' }), /private/);
  assert.throws(() => loadConfig({ ...env, PORTAL_ORIGIN: 'https://portal.test/path' }), /origin/);
  const config = loadConfig(env);
  assert.equal(isEmployee({ sub: 'outsider', email: 'someone@ssw.com.au' }, config), false);
  assert.equal(isEmployee({ sub: 'employee-1' }, config), true);
  const trusted = loadConfig({ ...env, PORTAL_EMPLOYEE_SUBJECTS: '', PORTAL_EMPLOYEE_CLAIM: 'ssw_employee' });
  assert.equal(isEmployee({ sub: 'staff', ssw_employee: true }, trusted), true);
  assert.equal(isEmployee({ sub: 'staff', ssw_employee: false }, trusted), false);
});

test('return URLs and blob paths reject external redirects and encoded separators', () => {
  for (const value of ['//evil.test', '/\\evil.test', 'https://evil.test', '/auth/login']) assert.equal(safeReturnTo(value), '/');
  assert.equal(safeReturnTo('/CRM/2026-10-27/?tab=people'), '/CRM/2026-10-27/?tab=people');
  assert.equal(reportName('/CRM/index.html'), 'CRM/index.html');
  assert.equal(reportName('/CRM/2026-10-27/'), 'CRM/2026-10-27/index.html');
  assert.equal(reportName('/CRM/%2e%2e/private'), null);
  assert.equal(reportName('/CRM/%2fsecret'), null);
});

function memoryContainer() {
  const blobs = new Map(); let version = 0;
  return { blobs, getBlockBlobClient(name) {
    return {
      async upload(body) { blobs.set(name, { body: Buffer.from(body), etag: String(++version) }); },
      async download() {
        const entry = blobs.get(name);
        if (!entry) throw Object.assign(new Error('missing'), { statusCode: 404 });
        return { readableStreamBody: Readable.from([entry.body]), etag: entry.etag };
      },
      async delete(options) {
        const entry = blobs.get(name);
        if (!entry) throw Object.assign(new Error('missing'), { statusCode: 404 });
        if (entry.etag !== options.conditions.ifMatch) throw Object.assign(new Error('changed'), { statusCode: 412 });
        blobs.delete(name);
      },
      async deleteIfExists() { blobs.delete(name); },
    };
  } };
}

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
  const unlock = renderUnlockPage({ projectName: 'crm', meetingId: '2026-10-27', encryptedPayload: encryptDashboardHtml('<h1>Private report</h1>', 'password') });
  const documents = { 'crm/index.html': '<a href="./2026-10-27/">Meeting</a>', 'crm/2026-10-27/index.html': unlock };
  let readCount = 0;
  const reports = {
    async *listBlobsByHierarchy() { yield { kind: 'prefix', name: 'crm/' }; },
    getBlockBlobClient(name) {
      return {
        async getProperties() { return { metadata: { displayname: 'CRM%20Team' }, contentType: 'text/html' }; },
        async download() {
          readCount++;
          if (!(name in documents)) throw Object.assign(new Error('missing'), { statusCode: 404 });
          return { contentType: 'text/html; charset=utf-8', readableStreamBody: Readable.from([documents[name]]) };
        },
      };
    },
  };
  let employee = true;
  const auth = {
    async begin() { return { url: 'https://identity.test/connect/authorize', transaction: { state: 'state', verifier: 'verifier', nonce: 'nonce' } }; },
    async finish(url, transaction) {
      assert.equal(transaction.verifier, 'verifier');
      assert.equal(url.origin, config.origin);
      return { claims: { sub: employee ? 'employee-1' : 'outsider', name: '<SSW User>', email: 'staff@ssw.com.au' }, idToken: 'not-exposed-to-browser' };
    },
    logout() { return 'https://identity.test/connect/endsession'; },
  };
  const server = createServer(createHandler({ config, sessions, reports, auth, logger: { error() {} } }));
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
  const txCookie = login.headers.getSetCookie()[0].split(';')[0];
  assert.match(login.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Lax/);
  const callback = await request('/auth/callback?code=code&state=state', { headers: { Cookie: txCookie } });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/crm/2026-10-27/');
  const sessionCookie = callback.headers.getSetCookie().find(v => v.startsWith('__Host-tiger_session=')).split(';')[0];
  const replay = await request('/auth/callback?code=code', { headers: { Cookie: txCookie } }); assert.equal(replay.status, 400);
  const root = await request('/', { headers: { Cookie: sessionCookie } });
  const rootHtml = await root.text();
  assert.match(rootHtml, /CRM Team/); assert.match(rootHtml, /&lt;SSW User&gt;/);
  assert.ok(!rootHtml.includes('not-exposed-to-browser'));
  const protectedReport = await request('/crm/2026-10-27/', { headers: { Cookie: sessionCookie } });
  assert.equal(await protectedReport.text(), unlock);
  assert.equal(protectedReport.headers.get('cache-control'), 'private, no-store');
  const missing = await request('/crm/missing/', { headers: { Cookie: sessionCookie } }); assert.equal(missing.status, 404);
  const csrf = /name="csrf" value="([^"]+)"/.exec(rootHtml)[1];
  const rejected = await request('/auth/logout', { method: 'POST', headers: { Cookie: sessionCookie, Origin: config.origin }, body: 'csrf=wrong' }); assert.equal(rejected.status, 403);
  const logout = await request('/auth/logout', { method: 'POST', headers: { Cookie: sessionCookie, Origin: config.origin }, body: `csrf=${csrf}` }); assert.equal(logout.status, 303);
  const revoked = await request('/api/me', { headers: { Cookie: sessionCookie } }); assert.equal(revoked.status, 401);
  employee = false;
  const outsiderLogin = await request('/auth/login');
  const outsiderCookie = outsiderLogin.headers.getSetCookie()[0].split(';')[0];
  const outsider = await request('/auth/callback?code=code', { headers: { Cookie: outsiderCookie } }); assert.equal(outsider.status, 403);
  assert.ok(!outsider.headers.getSetCookie().some(v => v.startsWith('__Host-tiger_session=')));
});
