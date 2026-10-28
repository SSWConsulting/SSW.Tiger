import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const operations = ['deploy', 'preview-infrastructure', 'apply-infrastructure-and-deploy'];

export function releaseConfig(env) {
  assert.ok(['test', 'staging'].includes(env.TARGET), 'Invalid Portal target');
  assert.ok(operations.includes(env.OPERATION), 'Invalid release operation');
  const target = env.TARGET;
  const app = `app-tiger-portal-${target}`;
  const issuer = target === 'test' ? 'https://app-ssw-ident-staging-api.azurewebsites.net' : 'https://identity.ssw.com.au';
  for (const key of ['PORTAL_RESOURCE_GROUP', 'PORTAL_ORIGIN', 'OIDC_ISSUER', 'AZURE_SUBSCRIPTION_ID']) {
    assert.ok(env[key]?.trim(), `Missing environment variable: ${key}`);
  }
  assert.equal(env.PORTAL_APP_NAME, app, 'Portal app does not match target');
  assert.equal(env.OIDC_ISSUER, issuer, 'IdentityServer issuer does not match target');
  const origin = new URL(env.PORTAL_ORIGIN);
  assert.equal(origin.protocol, 'https:');
  assert.equal(origin.origin, env.PORTAL_ORIGIN, 'PORTAL_ORIGIN must be an HTTPS origin without a trailing slash');
  const customHost = target === 'test' ? 'portal-test.sswtiger.com' : 'portal.sswtiger.com';
  assert.ok(origin.hostname === customHost || (origin.hostname.startsWith(`${app}-`) && origin.hostname.endsWith('.azurewebsites.net'))
    || origin.hostname === `${app}.azurewebsites.net`, 'Portal origin does not match target');
  const manageRoles = env.PORTAL_MANAGE_ROLE_ASSIGNMENTS || 'false';
  assert.ok(['true', 'false'].includes(manageRoles), 'PORTAL_MANAGE_ROLE_ASSIGNMENTS must be true or false');
  return {
    target, app, issuer, origin: origin.origin,
    resourceGroup: env.PORTAL_RESOURCE_GROUP,
    subscription: env.AZURE_SUBSCRIPTION_ID,
    storage: `satiger${target}web`, cosmos: `cosmos-tiger-${target}`,
    plan: 'plan-tiger-portal-test',
    planResourceGroup: env.PORTAL_SHARED_PLAN_RESOURCE_GROUP || env.PORTAL_RESOURCE_GROUP,
    legacyHosts: env.PORTAL_LEGACY_HOSTS || (target === 'test' ? 'dashboards-test.sswtiger.com' : 'dashboards.sswtiger.com'),
    manageRoles: manageRoles === 'true',
  };
}

export function infrastructureParameters(config) {
  const values = {
    project: 'tiger', environment: config.target, location: 'australiaeast',
    portalOrigin: config.origin, legacyHosts: config.legacyHosts,
    identityServerIssuer: config.issuer, oidcClientId: 'ssw-tiger-portal', apiAudience: 'tiger',
    cosmosAccountName: config.cosmos, dashboardStorageAccountName: config.storage,
    dashboardContainer: 'reports', managedIdentityName: `id-tiger-${config.target}`,
    sharedPlanName: config.plan, sharedPlanResourceGroup: config.planResourceGroup,
    manageRoleAssignments: config.manageRoles, bindCustomDomains: false,
  };
  return { '$schema': 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#',
    contentVersion: '1.0.0.0', parameters: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])) };
}

export function validateRuntime(config, app, runtime, settings) {
  assert.equal(app.name, config.app, 'Wrong App Service');
  const plan = `/subscriptions/${config.subscription}/resourceGroups/${config.planResourceGroup}/providers/Microsoft.Web/serverfarms/${config.plan}`;
  assert.equal(app.serverFarmId?.toLowerCase(), plan.toLowerCase(), 'Unexpected shared plan');
  const identityId = `/subscriptions/${config.subscription}/resourceGroups/${config.resourceGroup}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-tiger-${config.target}`;
  const identity = Object.entries(app.identity?.userAssignedIdentities || {}).find(([id]) => id.toLowerCase() === identityId.toLowerCase())?.[1];
  assert.ok(identity?.clientId, 'Environment managed identity is missing');
  assert.equal(runtime.linuxFxVersion?.toLowerCase(), 'node|22-lts', 'Portal requires Node 22');
  assert.equal(runtime.appCommandLine, 'npm start');
  assert.equal(runtime.healthCheckPath, '/healthz');
  const values = Object.fromEntries(settings.map(({ name, value }) => [name, value]));
  const expected = {
    PORTAL_ORIGIN: config.origin, OIDC_ISSUER: config.issuer, OIDC_CLIENT_ID: 'ssw-tiger-portal',
    OIDC_API_AUDIENCE: 'tiger', DASHBOARD_STORAGE_ACCOUNT: config.storage, DASHBOARD_CONTAINER: 'reports',
    COSMOS_DATABASE: 'tiger', PORTAL_USER_CONTAINER: 'users', PORTAL_SESSION_CONTAINER: 'portal-sessions',
    PORTAL_LEGACY_HOSTS: config.legacyHosts, AZURE_CLIENT_ID: identity.clientId,
  };
  // Report setting names only; never print credentials from application settings.
  for (const [key, value] of Object.entries(expected)) assert.ok(values[key] === value, `App setting mismatch: ${key}`);
  assert.ok(new URL(values.COSMOS_ENDPOINT).origin === `https://${config.cosmos}.documents.azure.com`, 'App setting mismatch: COSMOS_ENDPOINT');
  assert.ok(values.SCM_DO_BUILD_DURING_DEPLOYMENT?.toLowerCase() === 'true', 'Remote dependency build must be enabled');
  assert.ok(!values.WEBSITE_RUN_FROM_PACKAGE || values.WEBSITE_RUN_FROM_PACKAGE === '0', 'Run-from-package conflicts with remote build');
  assert.ok(!values.OIDC_CLIENT_SECRET, 'Portal uses a public PKCE client');
}

export async function packageSource(directory, revision, source = 'portal') {
  assert.match(revision || '', /^[a-f0-9]{40}$/, 'A full commit SHA is required');
  await mkdir(directory, { recursive: true });
  // Package runtime files only, excluding local secrets, tests, and node_modules.
  for (const entry of ['src', 'public', 'package.json', 'package-lock.json']) {
    await cp(resolve(source, entry), resolve(directory, entry), { recursive: true });
  }
  await writeFile(resolve(directory, 'release.json'), JSON.stringify({ revision }) + '\n');
}

async function main() {
  const [command, destination] = process.argv.slice(2);
  if (command === 'package') {
    assert.ok(['test', 'staging'].includes(process.env.TARGET));
    assert.ok(operations.includes(process.env.OPERATION));
    await packageSource(destination, process.env.REVISION);
    return;
  }
  const config = releaseConfig(process.env);
  if (command === 'configure') {
    await writeFile(destination, JSON.stringify(infrastructureParameters(config), null, 2));
  } else if (command === 'preflight') {
    const [app, runtime, settings] = await Promise.all(['app', 'runtime', 'settings'].map(async name =>
      JSON.parse(await readFile(resolve(destination, `portal-${name}.json`), 'utf8'))));
    validateRuntime(config, app, runtime, settings);
    console.log('Portal target, runtime, managed identity and environment settings verified.');
  } else throw new Error('Unknown Portal release command');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
