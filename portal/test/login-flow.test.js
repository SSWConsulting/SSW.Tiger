import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { SessionStore } from '../src/storage.js';
import { UserStore } from '../src/users.js';
import { memoryContainer, memoryUsers, serve } from './helpers.js';

async function setup(t) {
  const config = loadConfig({ PORTAL_ORIGIN: 'https://portal.test', OIDC_CLIENT_ID: 'tiger-portal', DASHBOARD_STORAGE_ACCOUNT: 'tigertest', COSMOS_ENDPOINT: 'https://cosmos.test', PORTAL_EMPLOYEE_SUBJECTS: 'employee-1' });
  let now = Date.now();
  const sessions = new SessionStore(memoryContainer(), () => now);
  let sequence = 0;
  let exchanges = 0;
  const auth = {
    async revoke() {},
    async begin() {
      const state = `state-${++sequence}`;
      return { url: `https://identity.test/authorize?state=${state}`, transaction: { state, verifier: `verifier-${sequence}`, nonce: `nonce-${sequence}` } };
    },
    async finish(url, transaction) {
      exchanges++;
      assert.equal(url.searchParams.get('state'), transaction.state);
      return { claims: { sub: 'employee-1', email: 'staff@ssw.com.au', email_verified: true }, idToken: 'signed-id-token', accessToken: 'access-token', refreshToken: 'refresh-token', accessTokenExpiresAt: Date.now() + 3600000 };
    },
  };
  const request = await serve(t, createHandler({ config, sessions, auth, users: new UserStore(memoryUsers(), config.issuer), logger: { error() {} } }));
  return { config, sessions, request, exchanges: () => exchanges, expire: () => { now += 601000; } };
}
const cookiePair = response => response.headers.getSetCookie()[0].split(';')[0];

test('two login tabs retain their own state, verifier and return destination', async t => {
  const { request, exchanges } = await setup(t);
  const first = await request('/auth/login?returnTo=%2Fcrm%2F');
  const second = await request('/auth/login?returnTo=%2Ftiger%2F');
  const firstCookie = cookiePair(first);
  const secondCookie = cookiePair(second);
  assert.notEqual(firstCookie.split('=')[0], secondCookie.split('=')[0]);
  const jar = `${firstCookie}; ${secondCookie}`;
  const a = await request('/auth/callback?code=one&state=state-1', { headers: { Cookie: jar } });
  assert.equal(a.status, 302);
  assert.equal(a.headers.get('location'), '/crm/');
  const b = await request('/auth/callback?code=two&state=state-2', { headers: { Cookie: jar } });
  assert.equal(b.status, 302);
  assert.equal(b.headers.get('location'), '/tiger/');
  assert.equal(exchanges(), 2);
  const replay = await request('/auth/callback?code=one&state=state-1', { headers: { Cookie: jar } });
  assert.equal(replay.status, 400);
  assert.equal(exchanges(), 2);
});

test('old callback returns to projects only when an approved session is already valid', async t => {
  const { request, sessions, config, exchanges } = await setup(t);
  const login = await request('/auth/login');
  const loginCookie = cookiePair(login);
  const completed = await request('/auth/callback?code=one&state=state-1', { headers: { Cookie: loginCookie } });
  const sessionCookie = completed.headers.getSetCookie().find(v => v.startsWith('__Host-tiger_session=')).split(';')[0];
  const stale = await request('/auth/callback?code=old&state=state-1', { headers: { Cookie: sessionCookie } });
  assert.equal(stale.status, 302);
  assert.equal(stale.headers.get('location'), '/');
  assert.equal(exchanges(), 1);
  for (const data of [
    { issuer: config.issuer, user: { sub: 'outsider' } },
    { issuer: 'https://other.test', user: { sub: 'employee-1' } },
  ]) {
    const id = await sessions.create('session', data, 300);
    const denied = await request('/auth/callback?code=old&state=state-1', { headers: { Cookie: `__Host-tiger_session=${id}` } });
    assert.equal(denied.status, data.issuer === config.issuer ? 403 : 400);
  }
  await sessions.remove(sessionCookie.split('=')[1], 'session');
  assert.equal((await request('/auth/callback?code=old&state=state-1', { headers: { Cookie: sessionCookie } })).status, 400);
});

test('expired login and mismatched state never create a session', async t => {
  const { request, expire, exchanges } = await setup(t);
  const login = await request('/auth/login');
  const jar = cookiePair(login);
  const wrong = await request('/auth/callback?code=one&state=unrelated', { headers: { Cookie: jar } });
  assert.equal(wrong.status, 400);
  expire();
  const expired = await request('/auth/callback?code=one&state=state-1', { headers: { Cookie: jar } });
  assert.equal(expired.status, 400);
  assert.equal(exchanges(), 0);
  assert.ok(!expired.headers.getSetCookie().some(v => v.startsWith('__Host-tiger_session=')));
});

test('in-flight login from before the update remains valid and wrong state cannot consume it', async t => {
  const { request, sessions, exchanges } = await setup(t);
  const id = await sessions.create('login', { state: 'legacy-state', verifier: 'legacy-verifier', nonce: 'legacy-nonce', returnTo: '/crm/' }, 600);
  const jar = `__Host-tiger_login=${id}`;
  const wrong = await request('/auth/callback?code=one&state=wrong', { headers: { Cookie: jar } });
  assert.equal(wrong.status, 400);
  assert.equal(exchanges(), 0);
  const completed = await request('/auth/callback?code=one&state=legacy-state', { headers: { Cookie: jar } });
  assert.equal(completed.status, 302);
  assert.equal(completed.headers.get('location'), '/crm/');
  assert.match(completed.headers.getSetCookie()[0], /__Host-tiger_login=;.*Max-Age=0/);
  assert.equal(exchanges(), 1);
});

test('database disables revoke existing cookies, report GET/HEAD and stale callbacks; new logins cannot reactivate', async t => {
  const config = loadConfig({ PORTAL_ORIGIN: 'https://portal.test', OIDC_CLIENT_ID: 'tiger-portal', DASHBOARD_STORAGE_ACCOUNT: 'tigertest', COSMOS_ENDPOINT: 'https://cosmos.test' });
  const container = memoryUsers(); const users = new UserStore(container, config.issuer);
  const sessions = new SessionStore(memoryContainer());
  let reportReads = 0;
  const reports = { getBlockBlobClient() { reportReads++; throw new Error('Disabled user must not read reports'); } };
  const claims = { sub: 'employee-1', email: 'staff@ssw.com.au', email_verified: true };
  const auth = {
    async revoke() {},
    async begin() { return { url: 'https://identity.test/authorize', transaction: { state: 'state' } }; },
    async finish() { return { claims, idToken: 'signed-token', accessToken: 'access-token', refreshToken: 'refresh-token', accessTokenExpiresAt: Date.now() + 3600000 }; },
  };
  const request = await serve(t, createHandler({ config, users, sessions, reports, auth, logger: { error() {} } }));
  const signIn = async () => {
    const login = await request('/auth/login');
    return request('/auth/callback?state=state', { headers: { Cookie: cookiePair(login) } });
  };
  const response = await signIn();
  assert.equal(response.status, 302);
  const cookie = response.headers.getSetCookie().find(v => v.startsWith('__Host-tiger_session=')).split(';')[0];
  const user = (await users.read(claims.sub)).user;
  assert.ok(user.lastLoginAt);
  container.documents.set(user.id, { ...user, isActive: false, _etag: 'disabled' });
  for (const [path, method] of [['/', 'GET'], ['/crm/report/', 'GET'], ['/crm/report/', 'HEAD'], ['/api/me', 'GET'], ['/auth/callback?state=old', 'GET']]) {
    assert.equal((await request(path, { method, headers: { Cookie: cookie } })).status, 403);
  }
  assert.equal((await signIn()).status, 403);
  assert.equal((await users.read(claims.sub)).user.isActive, false);
  container.documents.set(user.id, { ...user, _etag: 'enabled' });
  const blockId = users.emailBlockId(user.email);
  container.documents.set(blockId, { id: blockId, type: 'emailBlock', issuer: config.issuer, email: user.email, isBlocked: true });
  assert.equal((await request('/api/me', { headers: { Cookie: cookie } })).status, 403);
  claims.sub = 'second-login-method';
  assert.equal((await signIn()).status, 403);
  assert.equal(await users.read(claims.sub), null);
  container.documents.delete(blockId);
  container.item = () => ({ async read() { throw new Error('Cosmos offline'); } });
  assert.equal((await request('/crm/report/', { headers: { Cookie: cookie } })).status, 503);
  assert.equal(reportReads, 0);
});

test('failed session creation does not record a successful login', async t => {
  const config = loadConfig({ PORTAL_ORIGIN: 'https://portal.test', OIDC_CLIENT_ID: 'tiger-portal', DASHBOARD_STORAGE_ACCOUNT: 'tigertest', COSMOS_ENDPOINT: 'https://cosmos.test' });
  const users = new UserStore(memoryUsers(), config.issuer);
  const sessions = new SessionStore(memoryContainer());
  const create = sessions.create.bind(sessions);
  sessions.create = (kind, ...args) => {
    if (kind === 'session') throw new Error('Session storage unavailable');
    return create(kind, ...args);
  };
  const auth = {
    async revoke() {},
    async begin() { return { url: 'https://identity.test/authorize', transaction: { state: 'state' } }; },
    async finish() { return { claims: { sub: 'employee-1', email: 'staff@ssw.com.au', email_verified: true }, idToken: 'signed-token', accessToken: 'access-token', refreshToken: 'refresh-token', accessTokenExpiresAt: Date.now() + 3600000 }; },
  };
  const request = await serve(t, createHandler({ config, users, sessions, auth, logger: { error() {} } }));
  const login = await request('/auth/login');
  const response = await request('/auth/callback?state=state', { headers: { Cookie: cookiePair(login) } });
  assert.equal(response.status, 400);
  assert.equal((await users.read('employee-1')).user.lastLoginAt, undefined);
  assert.ok(!response.headers.getSetCookie().some(value => value.startsWith('__Host-tiger_session=')));
});


test('different login subjects share user roles while sessions and refresh retain their own subject', async t => {
  const config = loadConfig({ PORTAL_ORIGIN: 'https://portal.test', OIDC_CLIENT_ID: 'tiger-portal', DASHBOARD_STORAGE_ACCOUNT: 'tigertest', COSMOS_ENDPOINT: 'https://cosmos.test' });
  const container = memoryUsers(); const users = new UserStore(container, config.issuer);
  const sessions = new SessionStore(memoryContainer());
  let subject = 'microsoft'; let reportReads = 0;
  const refreshSubjects = [];
  const auth = {
    async revoke() {},
    async begin() { return { url: 'https://identity.test/authorize', transaction: { state: 'state' } }; },
    async finish() { return { claims: { sub: subject, email: 'staff@ssw.com.au', email_verified: true }, idToken: 'signed-token', accessToken: 'access', refreshToken: subject, accessTokenExpiresAt: Date.now() + 3600000 }; },
    async refresh(session) {
      assert.equal(session.user.sub, session.refreshToken);
      refreshSubjects.push(session.user.sub);
      return { accessToken: 'renewed', refreshToken: session.refreshToken, accessTokenExpiresAt: Date.now() + 3600000 };
    },
  };
  const reports = { getBlockBlobClient() { return {
    async download() { reportReads++; return { contentType: 'text/html', readableStreamBody: Readable.from(['<h1>Report</h1>']) }; },
    async getProperties() { reportReads++; return { contentType: 'text/html' }; },
  }; } };
  const request = await serve(t, createHandler({ config, users, sessions, auth, reports, logger: { error() {} } }));
  const login = async () => {
    const start = await request('/auth/login');
    const response = await request('/auth/callback?state=state', { headers: { Cookie: cookiePair(start) } });
    assert.equal(response.status, 302);
    return response.headers.getSetCookie().find(value => value.startsWith('__Host-tiger_session=')).split(';')[0];
  };
  const firstCookie = await login();
  const original = await users.authorize(subject);
  container.documents.set(original.id, { ...original, roles: ['Admin'], _etag: 'operator' });
  subject = 'password';
  const secondCookie = await login();
  for (const [cookie, expectedSub] of [[firstCookie, 'microsoft'], [secondCookie, 'password']]) {
    const id = cookie.split('=')[1];
    await sessions.update(id, session => ({ ...session, accessTokenExpiresAt: 0 }));
    const me = await (await request('/api/me', { headers: { Cookie: cookie } })).json();
    assert.equal(me.id, original.id);
    assert.equal(me.sub, expectedSub);
    assert.deepEqual(me.roles, ['Admin']);
    // 再次刷新验证页面处理没有把登录身份替换为主用户的 sub。
    await sessions.update(id, session => ({ ...session, accessTokenExpiresAt: 0 }));
    assert.equal((await request('/crm/meeting/', { headers: { Cookie: cookie } })).status, 200);
  }
  assert.deepEqual(refreshSubjects, ['microsoft', 'microsoft', 'password', 'password']);
  const active = await users.authorize(subject);
  container.documents.set(active.id, { ...active, isActive: false, _etag: 'disabled' });
  const readsBeforeDisable = reportReads;
  for (const cookie of [firstCookie, secondCookie]) {
    for (const method of ['GET', 'HEAD']) assert.equal((await request('/crm/meeting/', { method, headers: { Cookie: cookie } })).status, 403);
  }
  assert.equal(reportReads, readsBeforeDisable);
});
