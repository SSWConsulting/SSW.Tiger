import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { isEmployee, safeReturnTo, reportName } from './config.js';
import { listProjects } from './storage.js';
import { escapeHtml, messagePage, projectPage, projectsPage } from './views.js';
import { ReauthenticationRequired } from './auth.js';
import { ApiAuthError } from './apiAuth.js';
import { publicUser, UserAccessError } from './users.js';

// Match the absolute IdentityServer refresh grant lifetime; refreshing must not extend it indefinitely.
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const SESSION = '__Host-tiger_session';
const TRANSACTION = '__Host-tiger_login';
// Use a separate cookie for each login to prevent tabs from overwriting each other.
const loginCookieName = state => `${TRANSACTION}_${createHash('sha256').update(state || '').digest('hex')}`;
const validSession = (session, config) => session && session.issuer === config.issuer
  && typeof session.user?.sub === 'string';
const cookie = (name, value, age) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
function cookies(req) {
  const result = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) result[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return result;
}
function redirect(res, target, status = 302) { res.writeHead(status, { Location: target }); res.end(); }
function html(res, status, body) { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); }
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
function equal(a, b) {
  const x = Buffer.from(a || ''); const y = Buffer.from(b || '');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
async function formBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 4096) throw new Error('Request too large');
  }
  return new URLSearchParams(body);
}

export function createHandler({ config, auth, apiAuth, reports, sessions, users, meetings, revision = 'development', logger = console }) {
  const renewSession = async id => sessions.update(id, async session => {
    if (!validSession(session, config) || !session.refreshToken) throw new ReauthenticationRequired();
    if (session.accessTokenExpiresAt > Date.now() + 30000) return session;
    const refreshed = await auth.refresh(session);
    if (refreshed.claims && !isEmployee(refreshed.claims, config)) throw new ReauthenticationRequired();
    const { claims, ...tokens } = refreshed;
    return { ...session, ...tokens };
  });
  const endSession = async id => {
    const session = await sessions.read(id, 'session');
    await sessions.remove(id, 'session');
    if (session?.refreshToken) {
      try { await auth.revoke(session.refreshToken); }
      catch { logger.error('Portal refresh token revocation failed'); }
    }
    return session;
  };
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      if (req.url === '/healthz' && ['GET', 'HEAD'].includes(req.method)) {
        return json(res, 200, { status: 'ok', revision });
      }
      const host = (req.headers.host || '').toLowerCase();
      if (config.legacyHosts.has(host)) {
        // Preserve the path and query, using only the server-configured destination origin.
        return redirect(res, `${config.origin}${safeReturnTo(req.url)}`, 308);
      }
      if (host !== config.host) return html(res, 421, messagePage('Unknown host', 'Use the configured TIGER Portal address.'));
      const url = new URL(req.url, config.origin);
      const registration = url.pathname === '/api/User/Register';
      const roles = url.pathname === '/api/User/MyRoles';
      const bearerMe = url.pathname === '/api/me' && req.headers.authorization !== undefined;
      if (registration || roles || bearerMe) {
        const method = registration ? 'POST' : 'GET';
        if (req.method !== method) {
          res.setHeader('Allow', method); return json(res, 405, { error: 'method_not_allowed' });
        }
        const claims = await apiAuth.verify(req.headers.authorization, { allowCallback: registration || roles });
        if (!isEmployee(claims, config)) return json(res, 403, { error: 'ssw_staff_only' });
        // IdentityServer sends an empty body. User data and roles never come from callers' JSON.
        if (registration && (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) !== 0)) {
          return json(res, 400, { error: 'registration_body_must_be_empty' });
        }
        const user = await users.register(claims);
        if (registration) { res.writeHead(204); return res.end(); }
        return json(res, 200, roles ? user.roles : publicUser(user, claims.sub));
      }
      if (url.pathname === '/assets/portal.css' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
        return res.end(await readFile(new URL('../public/portal.css', import.meta.url)));
      }
      if (url.pathname === '/assets/images/app-icon.svg' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        return res.end(await readFile(new URL('../public/images/app-icon.svg', import.meta.url)));
      }
      const jar = cookies(req);
      if (url.pathname === '/auth/login' && req.method === 'GET') {
        const { url: target, transaction } = await auth.begin();
        const id = await sessions.create('login', { ...transaction, returnTo: safeReturnTo(url.searchParams.get('returnTo')) }, 600);
        res.setHeader('Set-Cookie', cookie(loginCookieName(transaction.state), id, 600));
        return redirect(res, target);
      }
      if (url.pathname === '/auth/callback' && req.method === 'GET') {
        const state = url.searchParams.get('state');
        const scopedName = loginCookieName(state);
        const transactionName = jar[scopedName] ? scopedName : TRANSACTION;
        const transactionId = jar[transactionName];
        // Support logins started before the update without consuming records from other login requests.
        let transaction = await sessions.read(transactionId, 'login');
        if (transaction && transaction.state === state) {
          transaction = await sessions.read(transactionId, 'login', true);
          res.setHeader('Set-Cookie', cookie(transactionName, '', 0));
        } else {
          transaction = null;
        }
        if (!transaction) {
          const session = await sessions.read(jar[SESSION], 'session');
          if (validSession(session, config)) {
            await users.authorize(session.user.sub);
            if (!await renewSession(jar[SESSION])) throw new ReauthenticationRequired();
            return redirect(res, '/');
          }
          return html(res, 400, messagePage('Sign-in expired', 'This sign-in link has expired or has already been used. Please start again.', '<a class="button" href="/auth/login">Sign in with SSW</a>'));
        }
        const identity = await auth.finish(url, transaction);
        if (!isEmployee(identity.claims, config)) {
          return html(res, 403, messagePage('SSW staff access only', 'Your account is not approved for this internal Portal. Contact the TIGER owner.'));
        }
        if (!identity.refreshToken) throw new ReauthenticationRequired();
        await endSession(jar[SESSION]);
        const claims = identity.claims;
        const user = publicUser(await users.register(claims), claims.sub);
        const id = await sessions.create('session', { issuer: config.issuer, user, idToken: identity.idToken, accessToken: identity.accessToken, refreshToken: identity.refreshToken, accessTokenExpiresAt: identity.accessTokenExpiresAt, csrf: randomBytes(32).toString('base64url') }, SESSION_SECONDS);
        try {
          await users.register(claims, { login: true });
        } catch (error) {
          await endSession(id);
          throw error;
        }
        res.setHeader('Set-Cookie', [cookie(transactionName, '', 0), cookie(SESSION, id, SESSION_SECONDS)]);
        return redirect(res, transaction.returnTo);
      }
      if (url.pathname === '/signed-out' && req.method === 'GET') {
        await endSession(jar[SESSION]);
        res.setHeader('Set-Cookie', cookie(SESSION, '', 0));
        return redirect(res, '/');
      }
      let session = await sessions.read(jar[SESSION], 'session');
      if (url.pathname === '/auth/logout') {
        if (!['GET', 'POST'].includes(req.method)) {
          res.setHeader('Allow', 'GET, POST'); return html(res, 405, messagePage('Method not allowed', 'Use Log out to end your session.'));
        }
        if (req.method === 'POST') {
          const form = await formBody(req);
          if (req.headers.origin !== config.origin || !equal(form.get('csrf'), session?.csrf)) return html(res, 403, messagePage('Log out didn’t go through', 'This page was out of date, so your session was left unchanged. Log out again to finish.', '<a class="button" href="/auth/logout">Log out</a>', '403 · Request rejected'));
        }
        await endSession(jar[SESSION]);
        let target = `${config.origin}/`;
        try { if (session?.issuer === config.issuer && session.idToken) target = await auth.logout(session.idToken); }
        catch { logger.error('Portal identity logout unavailable'); }
        res.setHeader('Set-Cookie', cookie(SESSION, '', 0));
        return redirect(res, target, req.method === 'POST' ? 303 : 302);
      }
      if (!validSession(session, config)) {
        if (url.pathname.startsWith('/api/')) {
          res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"sign_in_required"}');
        }
        return redirect(res, `/auth/login?returnTo=${encodeURIComponent(safeReturnTo(req.url))}`);
      }
      const user = publicUser(await users.authorize(session.user.sub), session.user.sub);
      session = await renewSession(jar[SESSION]);
      if (!session) throw new ReauthenticationRequired();
      session.user = user;
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.setHeader('Allow', 'GET, HEAD'); return html(res, 405, messagePage('Method not allowed', 'This page only supports reading reports.'));
      }
      if (url.pathname === '/api/me') {
        return json(res, 200, session.user);
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const projects = await listProjects(reports, undefined, meetings);
        const body = projectsPage(projects, session.user, session.csrf);
        if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(); }
        return html(res, 200, body);
      }
      const name = reportName(url.pathname);
      if (!name) return html(res, 404, messagePage('Report not found', 'Return to All projects to find a meeting.'));
      // Add trailing slashes to directories to preserve relative links in existing reports and indexes.
      if (url.pathname.split('/').filter(Boolean).length <= 2 && !url.pathname.endsWith('/') && !url.pathname.endsWith('.html')) {
        return redirect(res, `${url.pathname}/${url.search}`);
      }
      // Render project URLs through the Portal without reading legacy static index pages.
      if (/^[^/]+\/index\.html$/.test(name)) {
        const [project] = await listProjects(reports, name.split('/')[0], meetings);
        if (!project) return html(res, 404, messagePage('Project not found', 'Return to All projects to find a meeting.'));
        if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(); }
        return html(res, 200, projectPage(project, session.user, session.csrf));
      }
      const blob = reports.getBlockBlobClient(name);
      const response = req.method === 'HEAD' ? await blob.getProperties() : await blob.download();
      res.writeHead(200, { 'Content-Type': response.contentType || (name.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream') });
      if (req.method === 'HEAD') return res.end();
      // Return password unlock pages unchanged without reading passwords or decrypting reports.
      await pipeline(response.readableStreamBody, res);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof ReauthenticationRequired) {
        await endSession(cookies(req)[SESSION]);
        res.setHeader('Set-Cookie', cookie(SESSION, '', 0));
        if (req.url?.startsWith('/api/')) return json(res, 401, { error: 'sign_in_required' });
        return redirect(res, `/auth/login?returnTo=${encodeURIComponent(safeReturnTo(req.url))}`);
      }
      if (error instanceof UserAccessError) {
        if (req.url?.startsWith('/api/')) return json(res, 403, { error: error.message });
        return html(res, 403, messagePage('Access unavailable', 'Your account does not have access to TIGER. Contact the TIGER owner.'));
      }
      if (error instanceof ApiAuthError) {
        res.setHeader('WWW-Authenticate', `Bearer error="${error.message}"`);
        return json(res, error.status, { error: error.message });
      }
      const notFound = error.statusCode === 404;
      const authError = req.url?.startsWith('/auth/callback');
      logger.error('Portal request failed', { code: error.code || 'request_failed', status: notFound ? 404 : 500 });
      if (req.url?.startsWith('/api/')) return json(res, notFound ? 404 : 503, { error: notFound ? 'not_found' : 'temporarily_unavailable' });
      const loginError = new URL(req.url, config.origin).pathname === '/auth/login';
      const retryTarget = loginError
        ? `/auth/login?returnTo=${encodeURIComponent(safeReturnTo(new URL(req.url, config.origin).searchParams.get('returnTo')))}`
        : '/auth/login';
      html(res, notFound ? 404 : authError ? 400 : 503, messagePage(
        notFound ? 'Report not found' : loginError ? 'Unable to sign in' : authError ? 'Sign-in could not be completed' : 'Portal temporarily unavailable',
        notFound ? 'This report may have moved or is no longer available. Browse your projects to find another meeting.'
          : loginError ? 'The sign-in service is temporarily unavailable. Please try again in a few moments.'
          : authError ? 'Something interrupted the sign-in. Start again, and if it keeps happening, contact the TIGER owner.'
          : 'We couldn’t load this page. Please try again in a moment. If this continues, contact the TIGER owner.',
        notFound ? '<a class="button" href="/">Browse projects</a>'
          : loginError || authError ? `<a class="button" href="${escapeHtml(retryTarget)}">Try again</a>`
          : `<a class="button" href="${escapeHtml(safeReturnTo(req.url))}">Try again</a>`,
        notFound ? '404 · Report unavailable' : authError ? '400 · Sign-in interrupted' : '503 · Service unavailable',
      ));
    }
  };
}
