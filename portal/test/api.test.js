import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createApiAuth } from '../src/apiAuth.js';
import { createHandler } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { UserStore } from '../src/users.js';
import { memoryContainer, memoryUsers, serve, signedIssuer } from './helpers.js';

const env = { PORTAL_ORIGIN: 'https://portal.test', OIDC_ISSUER: 'https://identity.test', OIDC_CLIENT_ID: 'tiger-portal', DASHBOARD_STORAGE_ACCOUNT: 'satigertestweb', COSMOS_ENDPOINT: 'https://cosmos.test', PORTAL_EMPLOYEE_SUBJECTS: 'employee-1,employee-2' };

test('API validates signed scoped user tokens and narrowly permits the existing IdentityServer callback contract', async () => {
  const config = loadConfig(env); const issuer = signedIssuer(config); const auth = createApiAuth(config, issuer.fetch);
  const bearer = async overrides => `Bearer ${await issuer.sign(overrides)}`;
  assert.equal((await auth.verify(await bearer({}))).sub, 'employee-1');
  assert.equal((await auth.verify(await bearer({ scope: [config.apiScope] }))).sub, 'employee-1');
  const callback = await bearer({ scope: undefined });
  assert.equal((await auth.verify(callback, { allowCallback: true })).sub, 'employee-1');
  await assert.rejects(auth.verify(callback), error => error.status === 403);
  for (const overrides of [
    { iss: 'https://wrong.test' }, { aud: 'other-api' }, { aud: config.clientId },
    { client_id: 'other-client' }, { sub: undefined }, { exp: undefined }, { iat: undefined }, { aud: undefined },
    { iat: Math.floor(Date.now() / 1000) + 100 },
    { exp: Math.floor(Date.now() / 1000) - 100 },
  ]) await assert.rejects(auth.verify(await bearer(overrides)));
  for (const overrides of [{ scope: 'different-api' }, { scope: [] }, { scope: undefined, exp: Math.floor(Date.now() / 1000) + 3600 }]) {
    await assert.rejects(auth.verify(await bearer(overrides), { allowCallback: true }));
  }
  await assert.rejects(auth.verify(undefined));
  await assert.rejects(auth.verify('Bearer not-a-jwt'));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(auth.verify(`Bearer ${await issuer.sign({}, privateKey)}`));
});

test('registration and role callbacks need no login cookie, provision only SSW users and ignore claims-based role escalation', async t => {
  const config = loadConfig(env); const issuer = signedIssuer(config); const apiAuth = createApiAuth(config, issuer.fetch);
  const container = memoryUsers(); const users = new UserStore(container, config.issuer);
  let sessionReads = 0; let reportReads = 0;
  const sessions = { async read() { sessionReads++; throw new Error('Callback must not read login sessions'); } };
  const reports = { getBlockBlobClient() { reportReads++; throw new Error('Callback must not read reports'); } };
  const request = await serve(t, createHandler({ config, apiAuth, users, sessions, reports, logger: { error() {} } }));
  const callback = `Bearer ${await issuer.sign({ scope: undefined, role: 'Admin', roles: ['Admin'] })}`;
  const headers = { Authorization: callback };
  const anonymous = await request('/api/User/Register', { method: 'POST' });
  assert.equal(anonymous.status, 401); assert.equal(anonymous.headers.get('location'), null);
  assert.equal((await request('/api/User/MyRoles', { headers: { Cookie: '__Host-tiger_session=anything' } })).status, 401);
  const first = await request('/api/User/Register', { method: 'POST', headers });
  assert.equal(first.status, 204); assert.equal(first.headers.get('set-cookie'), null);
  assert.equal((await request('/api/User/Register', { method: 'POST', headers })).status, 204);
  assert.equal(container.writes, 3);
  const roles = await request('/api/User/MyRoles', { headers });
  assert.deepEqual(await roles.json(), ['User']);
  assert.deepEqual((await users.read('employee-1')).user.roles, ['User']);
  const meHeaders = { Authorization: `Bearer ${await issuer.sign({})}` };
  const me = await request('/api/me', { headers: meHeaders });
  assert.equal(me.status, 200); assert.deepEqual((await me.json()).roles, ['User']);
  assert.equal((await request('/api/me', { headers })).status, 403);
  const previous = (await users.read('employee-1')).user;
  container.documents.set(previous.id, { ...previous, roles: ['User', 'Admin'], _etag: 'operator' });
  assert.deepEqual(await (await request('/api/User/MyRoles', { headers })).json(), ['User', 'Admin']);
  const linkedHeaders = { Authorization: `Bearer ${await issuer.sign({ sub: 'password-login', email: 'STAFF@ssw.com.au' })}` };
  const linkedMe = await (await request('/api/me', { headers: linkedHeaders })).json();
  assert.equal(linkedMe.id, previous.id);
  assert.equal(linkedMe.sub, 'password-login');
  assert.deepEqual(linkedMe.roles, ['User', 'Admin']);
  assert.deepEqual(await (await request('/api/User/MyRoles', { headers: linkedHeaders })).json(), ['User', 'Admin']);
  const injection = await request('/api/User/Register', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': '19' }, body: '{"roles":["Admin"]}' });
  assert.equal(injection.status, 400);
  const outsider = { Authorization: `Bearer ${await issuer.sign({ sub: 'outsider', email: 'outsider@example.com' })}` };
  assert.equal((await request('/api/User/Register', { method: 'POST', headers: outsider })).status, 403);
  assert.equal(await users.read('outsider'), null);
  assert.equal((await request('/api/User/MyRoles', { method: 'POST', headers })).status, 405);
  container.documents.set(previous.id, { ...previous, isActive: false, _etag: 'disabled' });
  assert.equal((await request('/api/User/MyRoles', { headers })).status, 403);
  assert.equal((await request('/api/User/MyRoles', { headers: linkedHeaders })).status, 403);
  assert.equal(sessionReads, 0); assert.equal(reportReads, 0);
});

test('new approved users can query roles before registration, and storage errors do not grant access', async t => {
  const config = loadConfig(env); const issuer = signedIssuer(config); const apiAuth = createApiAuth(config, issuer.fetch);
  const users = new UserStore(memoryUsers(), config.issuer);
  const request = await serve(t, createHandler({ config, apiAuth, users, logger: { error() {} } }));
  const headers = { Authorization: `Bearer ${await issuer.sign({ sub: 'employee-2', scope: undefined })}` };
  assert.deepEqual(await (await request('/api/User/MyRoles', { headers })).json(), ['User']);
  assert.equal((await users.read('employee-2')).user.sub, 'employee-2');
  const broken = await serve(t, createHandler({ config, apiAuth, users: { async register() { throw new Error('storage unavailable'); } }, logger: { error() {} } }));
  assert.equal((await broken('/api/User/MyRoles', { headers })).status, 503);
});

test('configuration keeps API audience separate from ID tokens', () => {
  assert.throws(() => loadConfig({ ...env, OIDC_API_AUDIENCE: env.OIDC_CLIENT_ID }), /audience/);
});

test('API callbacks require verified email and fail closed when confirmation claims are absent', async t => {
  const config = loadConfig(env); const issuer = signedIssuer(config);
  const users = new UserStore(memoryUsers(), config.issuer);
  const request = await serve(t, createHandler({ config, users, apiAuth: createApiAuth(config, issuer.fetch), logger: { error() {} } }));
  for (const email_verified of [false, undefined, 'true']) {
    const headers = { Authorization: `Bearer ${await issuer.sign({ scope: undefined, email_verified })}` };
    assert.equal((await request('/api/User/MyRoles', { headers })).status, 403);
    assert.equal((await request('/api/User/Register', { method: 'POST', headers })).status, 403);
  }
  assert.equal(await users.read('employee-1'), null);
});
