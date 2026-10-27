export function loadConfig(env = process.env) {
  const required = ['PORTAL_ORIGIN', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'DASHBOARD_STORAGE_ACCOUNT'];
  for (const name of required) if (!env[name]) throw new Error(`${name} is required`);
  const origin = new URL(env.PORTAL_ORIGIN);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('PORTAL_ORIGIN must be an HTTPS origin');
  }
  const issuer = new URL(env.OIDC_ISSUER || 'https://identity.ssw.com.au');
  if (issuer.protocol !== 'https:') throw new Error('OIDC_ISSUER must use HTTPS');
  const subjects = new Set((env.PORTAL_EMPLOYEE_SUBJECTS || '').split(',').map(v => v.trim()).filter(Boolean));
  const employeeClaim = env.PORTAL_EMPLOYEE_CLAIM || '';
  if (!subjects.size && !employeeClaim) throw new Error('Configure PORTAL_EMPLOYEE_SUBJECTS or a trusted PORTAL_EMPLOYEE_CLAIM');
  const container = env.DASHBOARD_CONTAINER || 'reports';
  if (container === '$web') throw new Error('Portal reports must use a private container, not $web');
  if (!/^[a-z0-9]{3,24}$/.test(env.DASHBOARD_STORAGE_ACCOUNT)) throw new Error('Invalid storage account');
  return {
    origin: origin.origin, host: origin.host, issuer: issuer.href.replace(/\/$/, ''),
    clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET,
    redirectUri: `${origin.origin}/auth/callback`, subjects, employeeClaim,
    employeeValue: env.PORTAL_EMPLOYEE_VALUE || 'true',
    legacyHosts: new Set((env.PORTAL_LEGACY_HOSTS || 'dashboards.sswtiger.com').split(',').map(v => v.trim().toLowerCase()).filter(Boolean)),
    account: env.DASHBOARD_STORAGE_ACCOUNT, container,
    sessionContainer: env.PORTAL_SESSION_CONTAINER || 'portal-sessions',
    port: Number(env.PORT || 8080),
  };
}

export function isEmployee(claims, config) {
  if (!claims || typeof claims.sub !== 'string' || !claims.sub) return false;
  if (config.subjects.has(claims.sub)) return true;
  if (!config.employeeClaim) return false;
  const value = claims[config.employeeClaim];
  return Array.isArray(value)
    ? value.some(item => String(item) === config.employeeValue)
    : value !== undefined && String(value) === config.employeeValue;
}

export function safeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value)) return '/';
  try {
    const url = new URL(value, 'https://return.invalid');
    if (url.origin !== 'https://return.invalid' || /^\/auth(?:\/|$)/.test(url.pathname)) return '/';
    return `${url.pathname}${url.search}`;
  } catch { return '/'; }
}

export function reportName(pathname) {
  let parts;
  try { parts = pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return null; }
  if (!parts.length || parts.some(p => !p || p === '.' || p === '..' || /[\\/\u0000-\u001f\u007f]/.test(p))) return null;
  if (parts.length === 1) return `${parts[0]}/index.html`;
  if ((parts.length === 2 && !parts.at(-1).includes('.')) || pathname.endsWith('/')) parts.push('index.html');
  return parts.join('/');
}
