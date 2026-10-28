import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseConfig } from './portal-release.mjs';

export async function checkPortal({ origin, issuer, revision }, request = fetch) {
  const get = url => request(url, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'Cache-Control': 'no-cache' } });
  const health = await get(`${origin}/healthz`);
  assert.equal(health.status, 200, 'Health endpoint is unavailable');
  const body = await health.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.revision, revision, 'App is still serving another revision');
  const home = await get(`${origin}/`);
  assert.equal(home.status, 302, 'Anonymous home request must require login');
  const login = new URL(home.headers.get('location'), origin);
  assert.equal(login.origin, origin);
  assert.equal(login.pathname, '/auth/login');
  const api = await get(`${origin}/api/me`);
  assert.equal(api.status, 401, 'Anonymous API request must be denied');
  const discovery = await get(`${issuer}/.well-known/openid-configuration`);
  assert.equal(discovery.status, 200, 'IdentityServer discovery is unavailable');
  const metadata = await discovery.json();
  assert.equal(metadata.issuer, issuer);
  const response = await get(`${origin}/auth/login`);
  assert.equal(response.status, 302, 'OIDC login initiation failed');
  const authorize = new URL(response.headers.get('location'));
  assert.equal(authorize.origin + authorize.pathname, metadata.authorization_endpoint);
  const params = authorize.searchParams;
  assert.equal(params.get('client_id'), 'ssw-tiger-portal');
  assert.equal(params.get('redirect_uri'), `${origin}/auth/callback`);
  assert.equal(params.get('response_type'), 'code');
  assert.equal(params.get('code_challenge_method'), 'S256');
  for (const name of ['state', 'nonce', 'code_challenge']) assert.ok(params.get(name), `Missing ${name}`);
  for (const scope of ['openid', 'profile', 'email', 'offline_access', 'ssw-tiger-api']) {
    assert.ok(params.get('scope')?.split(' ').includes(scope), `Missing scope: ${scope}`);
  }
  const transaction = response.headers.get('set-cookie') || '';
  assert.match(transaction, /__Host-tiger_login_/);
  assert.match(transaction, /; Secure/i);
  assert.match(transaction, /; HttpOnly/i);
}

async function main() {
  const config = { ...releaseConfig(process.env), revision: process.env.REVISION };
  assert.match(config.revision || '', /^[a-f0-9]{40}$/);
  const deadline = Date.now() + 5 * 60 * 1000;
  for (;;) {
    try {
      await checkPortal(config);
      console.log(`Portal smoke checks passed for ${config.revision}.`);
      return;
    } catch {
      // Do not log login URLs, cookies, or application responses during retries.
      if (Date.now() >= deadline) throw new Error('Portal post-deployment checks failed; inspect App Service logs and configuration.');
      console.log('Waiting for the expected Portal revision and login readiness...');
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
