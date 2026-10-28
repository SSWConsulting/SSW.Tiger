import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import * as oidc from 'openid-client';
import { createAuth, ReauthenticationRequired } from '../src/auth.js';

test('public OIDC client sends S256 without credentials and validates verifier and signed identity', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const config = { issuer: 'https://identity.test', clientId: 'tiger', origin: 'https://portal.test', redirectUri: 'https://portal.test/auth/callback' };
  let transaction; let challenge; let tokenRequests = 0; let wrongNonce = false; let badSignature = false; let claimsOverride = {};
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const auth = await createAuth(config, { [oidc.customFetch]: async (input, options) => {
    const url = String(input);
    // SSW discovery advertises secret methods; the registered public client must explicitly use none.
    if (url.endsWith('/.well-known/openid-configuration')) return json({ issuer: config.issuer, authorization_endpoint: `${config.issuer}/connect/authorize`, token_endpoint: `${config.issuer}/connect/token`, jwks_uri: `${config.issuer}/jwks`, end_session_endpoint: `${config.issuer}/connect/endsession`, revocation_endpoint: `${config.issuer}/connect/revocation`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post'] });
    if (url.endsWith('/jwks')) return json({ keys: [{ ...jwk, kid: 'test-key', use: 'sig', alg: 'RS256' }] });
    if (url.endsWith('/connect/revocation')) {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('client_id'), config.clientId);
      assert.equal(body.get('token'), 'test-refresh-token');
      assert.equal(body.get('token_type_hint'), 'refresh_token');
      assert.equal(body.has('client_secret'), false);
      return new Response(null, { status: 200 });
    }
    assert.ok(url.endsWith('/connect/token'));
    tokenRequests++;
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('client_id'), config.clientId);
    assert.equal(body.has('client_secret'), false);
    assert.equal(body.has('client_assertion'), false);
    assert.equal(new Headers(options.headers).has('authorization'), false);
    if (body.get('grant_type') === 'refresh_token') {
      assert.equal(body.get('refresh_token'), 'test-refresh-token');
      assert.equal(body.has('code_verifier'), false);
      return json({ access_token: 'refreshed-access-token', token_type: 'Bearer', expires_in: 600 });
    }
    assert.equal(body.get('redirect_uri'), config.redirectUri);
    if (createHash('sha256').update(body.get('code_verifier') || '').digest('base64url') !== challenge) {
      return json({ error: 'invalid_grant' }, 400);
    }
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: config.issuer, sub: 'employee-1', aud: config.clientId, exp: now + 300, iat: now, nonce: wrongNonce ? 'wrong-nonce' : transaction.nonce, email: 'staff@ssw.com.au', ...claimsOverride })).toString('base64url');
    const unsigned = `${header}.${payload}`;
    const signature = sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
    const signedPart = badSignature ? Buffer.alloc(256, 0).toString('base64url') : signature;
    return json({ access_token: 'test-access-token', refresh_token: 'test-refresh-token', token_type: 'Bearer', expires_in: 300, id_token: `${unsigned}.${signedPart}` });
  } });
  const start = await auth.begin(); transaction = start.transaction;
  const authorize = new URL(start.url);
  challenge = authorize.searchParams.get('code_challenge');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('code_challenge'), createHash('sha256').update(transaction.verifier).digest('base64url'));
  assert.equal(authorize.searchParams.get('scope'), 'openid profile email offline_access ssw-tiger-api');
  assert.equal(authorize.searchParams.get('state'), transaction.state);
  assert.equal(authorize.searchParams.get('nonce'), transaction.nonce);
  const result = await auth.finish(new URL(`${config.redirectUri}?code=test-code&state=${transaction.state}`), transaction);
  assert.equal(result.claims.sub, 'employee-1');
  assert.equal(tokenRequests, 1);
  await assert.rejects(auth.finish(new URL(`${config.redirectUri}?code=test-code&state=wrong`), transaction));
  assert.equal(tokenRequests, 1);
  await assert.rejects(auth.finish(new URL(`${config.redirectUri}?code=test-code&state=${transaction.state}`), { ...transaction, verifier: oidc.randomPKCECodeVerifier() }));
  wrongNonce = true;
  await assert.rejects(auth.finish(new URL(`${config.redirectUri}?code=test-code&state=${transaction.state}`), transaction));
  wrongNonce = false; badSignature = true;
  await assert.rejects(auth.finish(new URL(`${config.redirectUri}?code=test-code&state=${transaction.state}`), transaction));
  badSignature = false; claimsOverride = { aud: 'another-client' };
  await assert.rejects(auth.finish(new URL(`${config.redirectUri}?code=test-code&state=${transaction.state}`), transaction));
  claimsOverride = { iss: 'https://another-issuer.test' };
  await assert.rejects(auth.finish(new URL(`${config.redirectUri}?code=test-code&state=${transaction.state}`), transaction));
  assert.equal(result.refreshToken, 'test-refresh-token');
  const refreshed = await auth.refresh({ ...result, user: { sub: result.claims.sub } });
  assert.equal(refreshed.accessToken, 'refreshed-access-token');
  assert.equal(refreshed.refreshToken, 'test-refresh-token');
  assert.ok(refreshed.accessTokenExpiresAt > Date.now() + 590000);
  await auth.revoke(result.refreshToken);
  const logout = new URL(auth.logout(result.idToken));
  assert.equal(logout.searchParams.get('post_logout_redirect_uri'), 'https://portal.test/');
});

test('refresh grants validate signed identity, retain or replace refresh tokens and distinguish revoked grants from outages', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const config = { issuer: 'https://identity.test', clientId: 'tiger-portal' };
  let mode = 'valid';
  const session = { user: { sub: 'employee-1' }, refreshToken: 'old-refresh' };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const auth = await createAuth(config, { [oidc.customFetch]: async (url, options) => {
    if (String(url).endsWith('/.well-known/openid-configuration')) return json({ issuer: config.issuer, token_endpoint: `${config.issuer}/token`, jwks_uri: `${config.issuer}/jwks` });
    if (String(url).endsWith('/jwks')) return json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'key', alg: 'RS256', use: 'sig' }] });
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'old-refresh');
    assert.equal(body.get('client_id'), config.clientId);
    assert.equal(new Headers(options.headers).has('authorization'), false);
    if (mode === 'revoked') return json({ error: 'invalid_grant' }, 400);
    if (mode === 'outage') throw new Error('Network unavailable');
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'key' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: config.issuer, aud: mode === 'audience' ? 'other' : config.clientId, sub: mode === 'subject' ? 'other' : 'employee-1', iat: now, exp: now + 300 })).toString('base64url');
    const unsigned = `${header}.${payload}`;
    const signature = mode === 'signature' ? Buffer.alloc(256).toString('base64url') : sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
    return json({ access_token: 'new-access', expires_in: 300, token_type: 'Bearer', id_token: `${unsigned}.${signature}`, ...(mode === 'rotated' ? { refresh_token: 'new-refresh' } : {}) });
  } });
  const refreshed = await auth.refresh(session);
  assert.equal(refreshed.claims.sub, 'employee-1');
  assert.equal(refreshed.refreshToken, 'old-refresh');
  mode = 'rotated';
  assert.equal((await auth.refresh(session)).refreshToken, 'new-refresh');
  mode = 'revoked';
  await assert.rejects(auth.refresh(session), ReauthenticationRequired);
  mode = 'outage';
  await assert.rejects(auth.refresh(session), error => !(error instanceof ReauthenticationRequired));
  for (mode of ['signature', 'audience', 'subject']) await assert.rejects(auth.refresh(session));
});
