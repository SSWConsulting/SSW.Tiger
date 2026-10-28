import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseConfig, infrastructureParameters, validateRuntime, packageSource } from './portal-release.mjs';
import { checkPortal } from './portal-smoke.mjs';

const env = {
  TARGET: 'test', OPERATION: 'deploy', PORTAL_APP_NAME: 'app-tiger-portal-test',
  PORTAL_RESOURCE_GROUP: 'tiger-rg', PORTAL_ORIGIN: 'https://portal-test.sswtiger.com',
  OIDC_ISSUER: 'https://app-ssw-ident-staging-api.azurewebsites.net',
  AZURE_CLIENT_ID: 'deployer', AZURE_TENANT_ID: 'tenant', AZURE_SUBSCRIPTION_ID: 'subscription',
};
const revision = 'a'.repeat(40);

test('release rejects cross-environment apps, origins, issuers and invalid operations', () => {
  const config = releaseConfig(env);
  assert.equal(infrastructureParameters(config).parameters.environment.value, 'test');
  assert.equal(infrastructureParameters(config).parameters.bindCustomDomains.value, false);
  for (const changes of [
    { TARGET: 'production' }, { OPERATION: 'anything' }, { PORTAL_APP_NAME: 'app-tiger-portal-staging' },
    { OIDC_ISSUER: 'https://identity.ssw.com.au' }, { PORTAL_ORIGIN: 'https://portal.sswtiger.com' },
    { AZURE_SUBSCRIPTION_ID: '' }, { PORTAL_MANAGE_ROLE_ASSIGNMENTS: 'yes' },
  ]) assert.throws(() => releaseConfig({ ...env, ...changes }));
  const staging = releaseConfig({ ...env, TARGET: 'staging', PORTAL_APP_NAME: 'app-tiger-portal-staging',
    PORTAL_ORIGIN: 'https://portal.sswtiger.com', OIDC_ISSUER: 'https://identity.ssw.com.au' });
  assert.equal(staging.storage, 'satigerstagingweb');
  assert.equal(infrastructureParameters(staging).parameters.managedIdentityName.value, 'id-tiger-staging');
});

test('preflight refuses wrong storage, shared plan, runtime or build configuration', () => {
  const config = releaseConfig(env);
  const identityId = '/subscriptions/subscription/resourceGroups/tiger-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-tiger-test';
  const app = { name: config.app,
    serverFarmId: '/subscriptions/subscription/resourceGroups/tiger-rg/providers/Microsoft.Web/serverfarms/plan-tiger-portal-test',
    identity: { userAssignedIdentities: { [identityId]: { clientId: 'runtime-identity' } } } };
  const runtime = { linuxFxVersion: 'NODE|22-lts', appCommandLine: 'npm start', healthCheckPath: '/healthz' };
  const values = { PORTAL_ORIGIN: config.origin, OIDC_ISSUER: config.issuer, OIDC_CLIENT_ID: 'ssw-tiger-portal',
    OIDC_API_AUDIENCE: 'tiger', DASHBOARD_STORAGE_ACCOUNT: config.storage, DASHBOARD_CONTAINER: 'reports',
    COSMOS_DATABASE: 'tiger', COSMOS_ENDPOINT: 'https://cosmos-tiger-test.documents.azure.com:443/',
    PORTAL_USER_CONTAINER: 'users', PORTAL_SESSION_CONTAINER: 'portal-sessions', PORTAL_LEGACY_HOSTS: config.legacyHosts,
    AZURE_CLIENT_ID: 'runtime-identity', SCM_DO_BUILD_DURING_DEPLOYMENT: 'true' };
  const settings = values => Object.entries(values).map(([name, value]) => ({ name, value }));
  validateRuntime(config, app, runtime, settings(values));
  for (const changes of [{ DASHBOARD_STORAGE_ACCOUNT: 'satigerstagingweb' }, { DASHBOARD_CONTAINER: '$web' },
    { SCM_DO_BUILD_DURING_DEPLOYMENT: 'false' }, { WEBSITE_RUN_FROM_PACKAGE: '1' }, { AZURE_CLIENT_ID: 'deployer' }]) {
    assert.throws(() => validateRuntime(config, app, runtime, settings({ ...values, ...changes })));
  }
  assert.throws(() => validateRuntime(config, { ...app, serverFarmId: 'other-plan' }, runtime, settings(values)));
  assert.throws(() => validateRuntime(config, app, { ...runtime, linuxFxVersion: 'NODE|20-lts' }, settings(values)));
});

test('release package includes revision and runtime files without local secrets, tests or dependencies', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'portal-package-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = join(temp, 'source'); const output = join(temp, 'package');
  await mkdir(source);
  for (const entry of ['src', 'pages', 'public', 'node_modules', 'test']) await mkdir(join(source, entry));
  for (const entry of ['package.json', 'package-lock.json', 'next.config.mjs', '.env']) await writeFile(join(source, entry), '{}');
  await packageSource(output, revision, source);
  assert.deepEqual((await readdir(output)).sort(), ['next.config.mjs', 'package-lock.json', 'package.json', 'pages', 'public', 'release.json', 'src']);
  assert.equal(JSON.parse(await readFile(join(output, 'release.json'), 'utf8')).revision, revision);
  await assert.rejects(() => packageSource(output, 'bad', source));
});

function smokeResponses({ stale = false, exposed = false, wrongIssuer = false, missingPkce = false } = {}) {
  const config = releaseConfig(env);
  const authorization = `${config.issuer}/connect/authorize`;
  const params = new URLSearchParams({ client_id: 'ssw-tiger-portal', redirect_uri: `${config.origin}/auth/callback`,
    response_type: 'code', code_challenge_method: missingPkce ? 'plain' : 'S256', state: 'state', nonce: 'nonce',
    code_challenge: 'challenge', scope: 'openid profile email offline_access ssw-tiger-api' });
  return async (url, options) => {
    assert.equal(options.redirect, 'manual');
    if (url.endsWith('/healthz')) return Response.json({ status: 'ok', revision: stale ? 'b'.repeat(40) : revision });
    if (url.endsWith('/api/me')) return new Response('', { status: exposed ? 200 : 401 });
    if (url.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer: config.issuer, authorization_endpoint: authorization });
    if (url.endsWith('/auth/login')) return new Response('', { status: 302, headers: {
      location: `${wrongIssuer ? 'https://evil.test/authorize' : authorization}?${params}`,
      'set-cookie': '__Host-tiger_login_test=opaque; Path=/; Secure; HttpOnly; SameSite=Lax',
    } });
    assert.equal(url, `${config.origin}/`);
    return new Response('', { status: 302, headers: { location: '/auth/login?returnTo=%2F' } });
  };
}

test('post-deploy checks reject stale revisions, anonymous API exposure and wrong OIDC redirects', async () => {
  const config = { ...releaseConfig(env), revision };
  await checkPortal(config, smokeResponses());
  for (const failure of [{ stale: true }, { exposed: true }, { wrongIssuer: true }, { missingPkce: true }]) {
    await assert.rejects(() => checkPortal(config, smokeResponses(failure)));
  }
});
