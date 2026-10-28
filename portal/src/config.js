export const TIGER_API_SCOPE = 'ssw-tiger-api';

export function loadConfig(env = process.env) {
  const required = ['PORTAL_ORIGIN', 'OIDC_CLIENT_ID', 'DASHBOARD_STORAGE_ACCOUNT'];
  for (const name of required) if (!env[name]) throw new Error(`${name} is required`);
  const origin = new URL(env.PORTAL_ORIGIN);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('PORTAL_ORIGIN must be an HTTPS origin');
  }
  const issuer = new URL(env.OIDC_ISSUER || 'https://identity.ssw.com.au');
  if (issuer.protocol !== 'https:') throw new Error('OIDC_ISSUER must use HTTPS');
  const container = env.DASHBOARD_CONTAINER || 'reports';
  if (container === '$web') throw new Error('Portal reports must use a private container, not $web');
  if (!/^[a-z0-9]{3,24}$/.test(env.DASHBOARD_STORAGE_ACCOUNT)) throw new Error('Invalid storage account');
  const apiAudience = env.OIDC_API_AUDIENCE || 'tiger';
  if (apiAudience === env.OIDC_CLIENT_ID || /\s/.test(apiAudience)) throw new Error('API audience must be distinct from the OIDC client ID');
  if (!env.COSMOS_ENDPOINT) throw new Error('COSMOS_ENDPOINT is required');
  const cosmosEndpoint = new URL(env.COSMOS_ENDPOINT);
  if (cosmosEndpoint.protocol !== 'https:' || cosmosEndpoint.username || cosmosEndpoint.password || cosmosEndpoint.pathname !== '/' || cosmosEndpoint.search || cosmosEndpoint.hash) {
    throw new Error('COSMOS_ENDPOINT must be an HTTPS origin');
  }
  return {
    origin: origin.origin, host: origin.host, issuer: issuer.href.replace(/\/$/, ''),
    clientId: env.OIDC_CLIENT_ID, apiAudience, apiScope: TIGER_API_SCOPE,
    redirectUri: `${origin.origin}/auth/callback`,
    legacyHosts: new Set((env.PORTAL_LEGACY_HOSTS || 'dashboards.sswtiger.com').split(',').map(v => v.trim().toLowerCase()).filter(Boolean)),
    account: env.DASHBOARD_STORAGE_ACCOUNT, container,
    sessionContainer: env.PORTAL_SESSION_CONTAINER || 'portal-sessions',
    cosmosEndpoint: cosmosEndpoint.href,
    cosmosDatabase: env.COSMOS_DATABASE || 'tiger',
    userContainer: env.PORTAL_USER_CONTAINER || 'users',
    meetingContainer: env.COSMOS_CONTAINER || 'meetings',
    port: Number(env.PORT || 8080),
  };
}

export function normalizedEmail(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(value)) return null;
  return value.toLowerCase();
}

export function isEmployee(claims) {
  const email = normalizedEmail(claims?.email);
  return typeof claims?.sub === 'string' && claims.sub.length > 0 && claims.sub.length <= 256
    && claims.email_verified === true && email?.split('@')[1] === 'ssw.com.au';
}

export function safeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value)) return '/';
  try {
    const url = new URL(value, 'https://return.invalid');
    if (url.origin !== 'https://return.invalid' || /^\/auth(?:\/|$)/.test(url.pathname)) return '/';
    return `${url.pathname}${url.search}`;
  } catch { return '/'; }
}

// A single path segment that can be served as-is: not empty, not a dot segment, no separators or control characters.
export const safeSegment = part => Boolean(part) && part !== '.' && part !== '..' && !/[\\/\u0000-\u001f\u007f]/.test(part);

export function reportName(pathname) {
  let parts;
  try { parts = pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return null; }
  if (!parts.length || !parts.every(safeSegment)) return null;
  if (parts.length === 1) return `${parts[0]}/index.html`;
  if ((parts.length === 2 && !parts.at(-1).includes('.')) || pathname.endsWith('/')) parts.push('index.html');
  return parts.join('/');
}
