import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { writeFile } from 'node:fs/promises';
import { SignJWT } from 'jose';
import * as oidc from 'openid-client';
import { createAuth } from '../src/auth.js';
import { createApiAuth } from '../src/apiAuth.js';
import { createHandler } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { SessionStore } from '../src/storage.js';
import { UserStore } from '../src/users.js';
import { memoryContainer, memoryUsers, serve } from './helpers.js';

// Replace only the identity provider transport layer, preserving real OIDC, signature, and callback validation.
function mockIdentityServer(config) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const codes = new Map(); const refreshTokens = new Map(); const refreshedSubjects = [];
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const signed = (profile, audience, extra) => new SignJWT({ ...profile, ...extra })
    .setProtectedHeader({ alg: 'RS256', kid: 'mock-key' }).setIssuer(config.issuer)
    .setAudience(audience).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const issue = async (profile, nonce) => {
    const refresh = randomUUID(); refreshTokens.set(refresh, profile);
    return json({ token_type: 'Bearer', expires_in: 300, refresh_token: refresh,
      access_token: await signed(profile, config.apiAudience, { client_id: config.clientId, scope: config.apiScope }),
      id_token: await signed(profile, config.clientId, nonce ? { nonce } : {}),
    });
  };
  return {
    refreshedSubjects,
    authorize(location, profile) {
      const url = new URL(location);
      assert.equal(url.origin, config.issuer);
      assert.equal(url.searchParams.get('client_id'), config.clientId);
      assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.ok(url.searchParams.get('nonce')); assert.ok(url.searchParams.get('state'));
      const code = randomUUID();
      codes.set(code, { profile, nonce: url.searchParams.get('nonce'), challenge: url.searchParams.get('code_challenge') });
      return `/auth/callback?${new URLSearchParams({ code, state: url.searchParams.get('state') })}`;
    },
    async fetch(input, options) {
      const url = String(input);
      if (url === `${config.issuer}/.well-known/openid-configuration`) return json({
        issuer: config.issuer, authorization_endpoint: `${config.issuer}/authorize`, token_endpoint: `${config.issuer}/token`,
        jwks_uri: `${config.issuer}/jwks`, revocation_endpoint: `${config.issuer}/revoke`,
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
      });
      if (url === `${config.issuer}/jwks`) return json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'mock-key', alg: 'RS256', use: 'sig' }] });
      assert.equal(new Headers(options.headers).has('authorization'), false);
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('client_id'), config.clientId); assert.equal(body.has('client_secret'), false);
      if (url === `${config.issuer}/revoke`) { refreshTokens.delete(body.get('token')); return new Response(null); }
      assert.equal(url, `${config.issuer}/token`);
      if (body.get('grant_type') === 'refresh_token') {
        const profile = refreshTokens.get(body.get('refresh_token'));
        if (!profile) return json({ error: 'invalid_grant' }, 400);
        refreshedSubjects.push(profile.sub);
        return issue(profile);
      }
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('redirect_uri'), config.redirectUri);
      const record = codes.get(body.get('code')); codes.delete(body.get('code'));
      if (!record || createHash('sha256').update(body.get('code_verifier') || '').digest('base64url') !== record.challenge) {
        return json({ error: 'invalid_grant' }, 400);
      }
      return issue(record.profile, record.nonce);
    },
  };
}

test('mock IdentityServer: signed distinct subjects with one verified SSW email share user, roles and disable state', async t => {
  const config = loadConfig({ PORTAL_ORIGIN: 'https://portal.test', OIDC_ISSUER: 'https://identity.mock.test',
    OIDC_CLIENT_ID: 'tiger-portal', DASHBOARD_STORAGE_ACCOUNT: 'tigertest', COSMOS_ENDPOINT: 'https://cosmos.mock.test' });
  const issuer = mockIdentityServer(config);
  const auth = await createAuth(config, { [oidc.customFetch]: issuer.fetch });
  const container = memoryUsers(); const users = new UserStore(container, config.issuer);
  const sessions = new SessionStore(memoryContainer());
  let reportReads = 0;
  const reports = { getBlockBlobClient() { return {
    async download() { reportReads++; return { contentType: 'text/html', readableStreamBody: Readable.from(['<h1>Mock meeting report</h1>']) }; },
    async getProperties() { reportReads++; return { contentType: 'text/html' }; },
  }; } };
  const request = await serve(t, createHandler({ config, users, sessions, reports, auth, apiAuth: createApiAuth(config, issuer.fetch), logger: { error() {} } }));
  const login = async profile => {
    const start = await request('/auth/login'); assert.equal(start.status, 302);
    const callback = issuer.authorize(start.headers.get('location'), profile);
    const response = await request(callback, { headers: { Cookie: start.headers.getSetCookie()[0].split(';')[0] } });
    const cookie = response.headers.getSetCookie().find(value => value.startsWith('__Host-tiger_session='))?.split(';')[0];
    return { response, cookie, sessionId: cookie?.split('=')[1] };
  };
  const me = async login => {
    const response = await request('/api/me', { headers: { Cookie: login.cookie } });
    assert.equal(response.status, 200); return response.json();
  };
  const update = async fields => {
    const { user, etag } = await users.read('mock-microsoft-sub');
    await container.item(user.id, user.id).replace({ ...user, ...fields }, { accessCondition: { type: 'IfMatch', condition: etag } });
  };
  const profile = { email: 'same-person@ssw.com.au', email_verified: true, name: 'Mock SSW Employee' };
  const microsoft = await login({ ...profile, sub: 'mock-microsoft-sub', roles: ['Admin'] });
  assert.equal(microsoft.response.status, 302);
  const first = await me(microsoft); assert.deepEqual(first.roles, ['User']);
  await update({ roles: ['User', 'Admin'], note: 'Preserve operator audit' });
  const password = await login({ ...profile, email: 'SAME-PERSON@SSW.COM.AU', sub: 'mock-password-sub' });
  assert.equal(password.response.status, 302);
  const second = await me(password);
  assert.equal(first.id, second.id); assert.notEqual(first.sub, second.sub);
  const identities = [...container.documents.values()].filter(value => value.type === 'identity');
  assert.equal(identities.length, 2); assert.ok(identities.every(value => value.userId === first.id));
  assert.equal([...container.documents.values()].filter(value => value.type === 'user').length, 1);
  const evidence = { mock: true, storage: 'in-memory test adapters', authentication: 'real createAuth + RS256/JWKS + PKCE/state/nonce + HTTP callback',
    internalUsersForSharedEmail: 1, linkedIdentities: 2, logins: [{ method: 'Microsoft (mock)', ...await me(microsoft) }, { method: 'Password (mock)', ...second }], checks: {} };
  for (const entry of [microsoft, password]) {
    assert.deepEqual((await me(entry)).roles, ['User', 'Admin']);
    await sessions.update(entry.sessionId, session => ({ ...session, accessTokenExpiresAt: 0 }));
    assert.equal((await me(entry)).id, first.id);
    const stored = await sessions.read(entry.sessionId, 'session');
    assert.equal(stored.user.sub, entry === microsoft ? first.sub : second.sub);
    const bearer = { Authorization: `Bearer ${stored.accessToken}` };
    assert.deepEqual(await (await request('/api/User/MyRoles', { headers: bearer })).json(), ['User', 'Admin']);
    assert.equal((await (await request('/api/me', { headers: bearer })).json()).id, first.id);
    assert.equal((await request('/crm/meeting/', { headers: { Cookie: entry.cookie } })).status, 200);
  }
  assert.deepEqual(issuer.refreshedSubjects, [first.sub, second.sub]);
  assert.equal((await users.authorize(first.sub)).note, 'Preserve operator audit');
  evidence.checks.sharedUserId = true; evidence.checks.sharedRoles = ['User', 'Admin']; evidence.checks.independentSignedRefresh = true;
  const unverified = await login({ ...profile, email_verified: false, sub: 'mock-unverified-sub' });
  assert.equal(unverified.response.status, 403); assert.equal(unverified.cookie, undefined);
  assert.equal(await users.read('mock-unverified-sub'), null);
  const other = await login({ ...profile, email: 'different-person@ssw.com.au', sub: 'mock-other-person' });
  assert.notEqual((await me(other)).id, first.id);
  evidence.checks.unverifiedEmailDenied = true; evidence.checks.differentEmailSeparate = true;
  await update({ isActive: false }); const readsBeforeDisable = reportReads;
  for (const entry of [microsoft, password]) {
    assert.equal((await request('/api/me', { headers: { Cookie: entry.cookie } })).status, 403);
    for (const method of ['GET', 'HEAD']) assert.equal((await request('/crm/meeting/', { method, headers: { Cookie: entry.cookie } })).status, 403);
    const stored = await sessions.read(entry.sessionId, 'session');
    assert.equal((await request('/api/User/MyRoles', { headers: { Authorization: `Bearer ${stored.accessToken}` } })).status, 403);
  }
  assert.equal(reportReads, readsBeforeDisable);
  const third = await login({ ...profile, sub: 'mock-third-login' });
  assert.equal(third.response.status, 403); assert.equal(await users.read('mock-third-login'), null);
  evidence.checks.disabledBothSessions = 403; evidence.checks.disabledReportsGetAndHead = 403; evidence.checks.thirdIdentityCannotBypass = true;
  await update({ isActive: true, roles: ['User'] });
  for (const entry of [microsoft, password]) assert.deepEqual((await me(entry)).roles, ['User']);
  evidence.checks.restoredBothSessions = true;
  if (process.env.TIGER_MOCK_EVIDENCE) await writeFile(process.env.TIGER_MOCK_EVIDENCE, JSON.stringify(evidence, null, 2));
  t.diagnostic(JSON.stringify(evidence));
});
