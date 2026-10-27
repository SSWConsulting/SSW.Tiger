import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { isEmployee, safeReturnTo, reportName } from './config.js';
import { listProjects } from './storage.js';
import { messagePage, projectsPage } from './views.js';

const SESSION = '__Host-tiger_session';
const TRANSACTION = '__Host-tiger_login';
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

export function createHandler({ config, auth, reports, sessions, logger = console }) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      if (req.url === '/healthz' && ['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"status":"ok"}');
      }
      const host = (req.headers.host || '').toLowerCase();
      if (config.legacyHosts.has(host)) {
        // Preserve the path and query, using only the server-configured destination origin.
        return redirect(res, `${config.origin}${safeReturnTo(req.url)}`, 308);
      }
      if (host !== config.host) return html(res, 421, messagePage('Unknown host', 'Use the configured TIGER Portal address.'));
      const url = new URL(req.url, config.origin);
      if (url.pathname === '/assets/portal.css' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
        return res.end(await readFile(new URL('../public/portal.css', import.meta.url)));
      }
      const jar = cookies(req);
      if (url.pathname === '/auth/login' && req.method === 'GET') {
        const { url: target, transaction } = await auth.begin();
        const id = await sessions.create('login', { ...transaction, returnTo: safeReturnTo(url.searchParams.get('returnTo')) }, 600);
        res.setHeader('Set-Cookie', cookie(TRANSACTION, id, 600));
        return redirect(res, target);
      }
      if (url.pathname === '/auth/callback' && req.method === 'GET') {
        res.setHeader('Set-Cookie', cookie(TRANSACTION, '', 0));
        const transaction = await sessions.read(jar[TRANSACTION], 'login', true);
        if (!transaction) return html(res, 400, messagePage('Sign-in expired', 'Start sign-in again.', '<a class="button" href="/auth/login">Sign in with SSW</a>'));
        const identity = await auth.finish(url, transaction);
        if (!isEmployee(identity.claims, config)) {
          return html(res, 403, messagePage('SSW staff access only', 'Your account is not approved for this internal Portal. Contact the TIGER owner.'));
        }
        await sessions.remove(jar[SESSION], 'session');
        const claims = identity.claims;
        const user = { sub: claims.sub, name: claims.full_name || claims.name, email: claims.email };
        const employeeEvidence = config.employeeClaim ? { [config.employeeClaim]: claims[config.employeeClaim] } : {};
        const id = await sessions.create('session', { user, employeeEvidence, idToken: identity.idToken, csrf: randomBytes(32).toString('base64url') }, 28800);
        res.setHeader('Set-Cookie', [cookie(TRANSACTION, '', 0), cookie(SESSION, id, 28800)]);
        return redirect(res, transaction.returnTo);
      }
      if (url.pathname === '/signed-out' && req.method === 'GET') {
        await sessions.remove(jar[SESSION], 'session');
        res.setHeader('Set-Cookie', cookie(SESSION, '', 0));
        return html(res, 200, messagePage('You’re signed out', 'Sign in with your SSW account to browse meeting reports.', '<a class="button" href="/auth/login">Sign in with SSW</a>'));
      }
      const session = await sessions.read(jar[SESSION], 'session');
      if (!session || !isEmployee({ ...session.user, ...session.employeeEvidence }, config)) {
        if (url.pathname.startsWith('/api/')) {
          res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"sign_in_required"}');
        }
        return redirect(res, `/auth/login?returnTo=${encodeURIComponent(safeReturnTo(req.url))}`);
      }
      if (url.pathname === '/auth/logout' && req.method === 'POST') {
        const form = await formBody(req);
        if (req.headers.origin !== config.origin || !equal(form.get('csrf'), session.csrf)) return html(res, 403, messagePage('Request rejected', 'Please return to the Portal and try again.'));
        await sessions.remove(jar[SESSION], 'session');
        res.setHeader('Set-Cookie', cookie(SESSION, '', 0));
        return redirect(res, await auth.logout(session.idToken), 303);
      }
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.setHeader('Allow', 'GET, HEAD'); return html(res, 405, messagePage('Method not allowed', 'This page only supports reading reports.'));
      }
      if (url.pathname === '/api/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(session.user));
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const projects = await listProjects(reports);
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
      const blob = reports.getBlockBlobClient(name);
      if (req.method === 'HEAD') {
        const props = await blob.getProperties();
        res.writeHead(200, { 'Content-Type': props.contentType || 'application/octet-stream' }); return res.end();
      }
      const response = await blob.download();
      res.writeHead(200, { 'Content-Type': response.contentType || (name.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream') });
      // Return password unlock pages unchanged without reading passwords or decrypting reports.
      await pipeline(response.readableStreamBody, res);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const notFound = error.statusCode === 404;
      const authError = req.url?.startsWith('/auth/callback');
      logger.error('Portal request failed', { code: error.code || 'request_failed', status: notFound ? 404 : 500 });
      html(res, notFound ? 404 : authError ? 400 : 503, messagePage(
        notFound ? 'Report not found' : authError ? 'Sign-in could not be completed' : 'Portal temporarily unavailable',
        notFound ? 'Return to All projects to find a meeting.' : 'Please try again. If the problem continues, contact the TIGER owner.',
        '<a class="button" href="/">All projects</a>',
      ));
    }
  };
}
