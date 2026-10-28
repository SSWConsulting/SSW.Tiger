import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/app.js';
import { ReauthenticationRequired } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { SessionStore } from '../src/storage.js';
import { UserStore } from '../src/users.js';
import { memoryContainer, memoryUsers, serve } from './helpers.js';

async function setup(t) {
  const config = loadConfig({ PORTAL_ORIGIN: 'https://portal.test', OIDC_CLIENT_ID: 'tiger-portal', DASHBOARD_STORAGE_ACCOUNT: 'tigertest', COSMOS_ENDPOINT: 'https://cosmos.test' });
  const blobs = memoryContainer();
  const sessions = new SessionStore(blobs);
  const users = new UserStore(memoryUsers(), config.issuer);
  const user = await users.register({ sub: 'staff', email: 'staff@ssw.com.au', email_verified: true });
  let refreshes = 0;
  const revoked = [];
  const auth = {
    async refresh(session) {
      refreshes++;
      assert.equal(session.refreshToken, 'refresh-secret');
      return { accessToken: 'new-access-secret', refreshToken: 'new-refresh-secret', accessTokenExpiresAt: Date.now() + 3600000 };
    },
    async revoke(token) { revoked.push(token); },
    logout() { return 'https://identity.test/logout'; },
  };
  const id = await sessions.create('session', { issuer: config.issuer, user, idToken: 'id-secret', accessToken: 'access-secret', refreshToken: 'refresh-secret', accessTokenExpiresAt: Date.now() - 1, csrf: 'csrf' }, 2592000);
  const headers = { Cookie: `__Host-tiger_session=${id}` };
  const request = await serve(t, createHandler({ config, users, sessions, auth, logger: { error() {} } }));
  return { request, headers, sessions, id, auth, blobs, revoked, refreshes: () => refreshes };
}

test('expired access token refreshes on a cookie request, persists replacement tokens and exposes no tokens', async t => {
  const ctx = await setup(t);
  const before = await ctx.sessions.read(ctx.id, 'session');
  const response = await ctx.request('/api/me', { headers: ctx.headers });
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), /secret|Token/);
  const after = await ctx.sessions.read(ctx.id, 'session');
  assert.equal(after.refreshToken, 'new-refresh-secret');
  assert.equal(after.accessToken, 'new-access-secret');
  assert.equal(after.expiresAt, before.expiresAt);
  assert.equal((await ctx.request('/api/me', { headers: ctx.headers })).status, 200);
  assert.equal(ctx.refreshes(), 1);
  assert.equal((await ctx.request('/auth/logout', { headers: ctx.headers })).status, 302);
  assert.deepEqual(ctx.revoked, ['new-refresh-secret']);
  assert.equal(await ctx.sessions.read(ctx.id, 'session'), null);
});

test('revoked refresh authorization clears API sessions and redirects page requests to login', async t => {
  const ctx = await setup(t);
  ctx.auth.refresh = async () => { throw new ReauthenticationRequired(); };
  const response = await ctx.request('/api/me', { headers: ctx.headers });
  assert.equal(response.status, 401);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(await ctx.sessions.read(ctx.id, 'session'), null);
  assert.deepEqual(ctx.revoked, ['refresh-secret']);
  const page = await ctx.request('/crm/report/?tab=people', { headers: ctx.headers });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/auth/login?returnTo=%2Fcrm%2Freport%2F%3Ftab%3Dpeople');
});

test('temporary refresh outage denies access without destroying the session and recovers on retry', async t => {
  const ctx = await setup(t);
  const refresh = ctx.auth.refresh;
  ctx.auth.refresh = async () => { throw new Error('Temporary token endpoint outage'); };
  assert.equal((await ctx.request('/api/me', { headers: ctx.headers })).status, 503);
  assert.ok(await ctx.sessions.read(ctx.id, 'session'));
  assert.deepEqual(ctx.revoked, []);
  ctx.auth.refresh = refresh;
  assert.equal((await ctx.request('/api/me', { headers: ctx.headers })).status, 200);
});

test('logout invalidates local sessions even if revocation and identity logout are unavailable', async t => {
  const ctx = await setup(t);
  ctx.auth.revoke = async () => { throw new Error('Offline'); };
  ctx.auth.logout = () => { throw new Error('Offline'); };
  const response = await ctx.request('/auth/logout', { headers: ctx.headers });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://portal.test/');
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(await ctx.sessions.read(ctx.id, 'session'), null);
});

test('concurrent refreshes retain the winning tokens and cannot recreate a logged-out session', async () => {
  const store = new SessionStore(memoryContainer());
  const id = await store.create('session', { accessTokenExpiresAt: 0 }, 100);
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const stale = store.update(id, async session => {
    if (session.accessTokenExpiresAt) return session;
    entered(); await barrier;
    return { ...session, accessTokenExpiresAt: 100, refreshToken: 'stale' };
  });
  await started;
  await store.update(id, async session => ({ ...session, accessTokenExpiresAt: 200, refreshToken: 'winner' }));
  release();
  assert.equal((await stale).refreshToken, 'winner');
  await store.update(id, async session => {
    await store.remove(id, 'session');
    return { ...session, refreshToken: 'must-not-resurrect' };
  });
  assert.equal(await store.read(id, 'session'), null);
});

test('sessions issued before refresh support require reauthentication', async t => {
  const ctx = await setup(t);
  const old = await ctx.sessions.create('session', { issuer: 'https://identity.ssw.com.au', user: { sub: 'staff' } }, 100);
  const response = await ctx.request('/api/me', { headers: { Cookie: `__Host-tiger_session=${old}` } });
  assert.equal(response.status, 401);
  assert.equal(await ctx.sessions.read(old, 'session'), null);
});
